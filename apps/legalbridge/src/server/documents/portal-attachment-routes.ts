import { Router, raw, type NextFunction, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { MultipartError, parseMultipart } from "./multipart.js";
import type { DriveStorage } from "./drive-storage.js";
import { ATTACHMENT_KINDS, type AttachmentsRepository } from "./attachments-repository.js";
import type { DatabasePool } from "../db/pool.js";

// V1 検索ポータル互換の資料アップロード受け口（V1停止・案A）。
// ポータル（search-api）の資料アップロードページは POST を DOCUMENT_WORKER_URL の
// /api/attachments/by-issue へ中継する。V1 worker を止めるため、同じ契約の受け口を
// V2 に用意し、search-api の DOCUMENT_WORKER_URL を V2 へ向け替える。
//   ・認証: x-lb-portal-secret ヘッダ（LB_PORTAL_SECRET と一致・fail-closed）。
//     ユーザー認証は通さない（auth.ts でこのパスのみ免除）。
//   ・アップロード者: x-lb-portal-secret 検証済みの search-api が IAP から取った
//     メールを x-lb-uploader-email で渡す（V1 と同一・ブラウザ入力は信用しない）。
//   ・応答: ページ互換の snake_case（d.ok / d.document.document_number）。

const MAX_FILE_BYTES = 30 * 1024 * 1024;

export interface PortalIssueResolver {
  // 課題の実在確認（誤入力の番号に添付が積まれるのを防ぐ・V1 同様 legal_requests を見る）。
  requestExists(issueKey: string): Promise<boolean>;
  // 案件解決: 代表課題 → matter_issues の順。無ければ null（autolink に委ねる・V1 同様）。
  matterIdForIssue(issueKey: string): Promise<number | null>;
}

export class PgPortalIssueResolver implements PortalIssueResolver {
  constructor(private readonly database: DatabasePool) {}

  async requestExists(issueKey: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM legal_requests WHERE backlog_issue_key = $1 LIMIT 1`, [issueKey]);
    return Boolean(result.rows[0]);
  }

  async matterIdForIssue(issueKey: string): Promise<number | null> {
    const primary = await this.database.query(
      `SELECT id FROM matters WHERE primary_issue_key = $1 LIMIT 1`, [issueKey]);
    if (primary.rows[0]) return Number(primary.rows[0].id);
    const linked = await this.database.query(
      `SELECT matter_id FROM matter_issues WHERE backlog_issue_key = $1 LIMIT 1`, [issueKey]);
    return linked.rows[0] ? Number(linked.rows[0].matter_id) : null;
  }
}

export class MemoryPortalIssueResolver implements PortalIssueResolver {
  constructor(
    private readonly requests: string[] = [],
    private readonly matterByIssue: Record<string, number> = {}
  ) {}
  async requestExists(issueKey: string) { return this.requests.includes(issueKey); }
  async matterIdForIssue(issueKey: string) { return this.matterByIssue[issueKey] ?? null; }
}

function secretMatches(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

export interface PortalAttachmentRouterDependencies {
  repository?: AttachmentsRepository;
  resolver?: PortalIssueResolver;
  storage?: DriveStorage | null;
  postComment?: (issueKey: string, text: string) => Promise<void>;
  writeEnabled?: boolean;
  // 共有シークレット（未設定＝空文字なら受け口ごと 404・fail-closed）。
  portalSecret: () => string;
}

export function createPortalAttachmentRouter(dependencies: PortalAttachmentRouterDependencies) {
  const { repository, resolver, storage, postComment } = dependencies;
  const writeEnabled = dependencies.writeEnabled === true;
  const router = Router();

  router.post(
    "/api/attachments/by-issue",
    raw({ type: "multipart/form-data", limit: `${MAX_FILE_BYTES + 1024 * 1024}b` }),
    async (request, response, next) => {
      try {
        const secret = String(dependencies.portalSecret() ?? "").trim();
        if (!secret) return response.status(404).json({ ok: false, error: "not found" });
        const presented = String(request.headers["x-lb-portal-secret"] ?? "");
        if (!presented || !secretMatches(secret, presented)) {
          return response.status(401).json({ ok: false, error: "unauthorized" });
        }
        if (!writeEnabled || !repository || !resolver || !storage?.uploadFile) {
          return response.status(503).json({
            ok: false, error: "添付アップロードは現在利用できません（V2側の設定が未完了です）"
          });
        }
        if (!Buffer.isBuffer(request.body)) {
          return response.status(400).json({ ok: false, error: "multipart/form-data で送信してください" });
        }

        let payload;
        try {
          payload = parseMultipart(request.body, request.headers["content-type"]);
        } catch (error) {
          if (error instanceof MultipartError) {
            return response.status(400).json({ ok: false, error: error.message });
          }
          throw error;
        }

        const issueKey = String(payload.fields.issueKey ?? "").trim().toUpperCase();
        if (!issueKey || !/^[A-Z0-9_]+-\d+$/.test(issueKey)) {
          return response.status(400).json({ ok: false, error: "課題番号が不正です" });
        }
        const file = payload.files.find((f) => f.field === "file");
        if (!file || !file.data.length) {
          return response.status(400).json({ ok: false, error: "ファイルが指定されていません" });
        }
        if (file.data.length > MAX_FILE_BYTES) {
          return response.status(413).json({ ok: false, error: "1ファイル 30MB までです" });
        }

        const uploaderEmail = String(request.headers["x-lb-uploader-email"] ?? "").trim();
        const kind = String(payload.fields.docKind ?? "").trim();
        const templateType = ATTACHMENT_KINDS[kind] ? kind : "reference";
        const rawName = String(payload.fields.originalName ?? "").trim() || file.filename || "attachment";
        const safeName = rawName.replace(/[\r\n]/g, "_");

        if (!(await resolver.requestExists(issueKey))) {
          return response.status(404).json({
            ok: false, error: "この課題番号の依頼が見つかりません: " + issueKey
          });
        }
        const matterId = await resolver.matterIdForIssue(issueKey);

        const accountPart = (uploaderEmail || "unknown").replace(/[\r\n\\/]/g, "_");
        const driveFileName = `${issueKey}_${accountPart}_${safeName}`;
        let driveLink = "";
        try {
          const stored = await storage.uploadFile({
            filename: driveFileName,
            mimeType: file.contentType || "application/octet-stream",
            data: file.data
          });
          driveLink = stored.webViewLink;
        } catch (error) {
          return response.status(502).json({
            ok: false,
            error: `Drive アップロードに失敗しました: ${String((error as Error)?.message ?? error).slice(0, 300)}`
          });
        }

        let document;
        try {
          document = await repository.register({
            matterId,
            issueKey,
            templateType,
            driveLink,
            originalName: safeName,
            mimeType: file.contentType || "application/octet-stream",
            sizeBytes: file.data.length,
            uploadedBy: uploaderEmail || null
          });
        } catch (error) {
          if ((error as { code?: string })?.code === "42501") {
            return response.status(503).json({ ok: false, error: "添付登録の権限が付与されていません" });
          }
          throw error;
        }

        // 法務側への気づき導線（V1 同様ベストエフォート・失敗しても添付は成功扱い）。
        if (postComment) {
          try {
            await postComment(
              issueKey,
              `📎 資料アップロードページから資料が格納されました。\n` +
              `- ファイル: ${safeName} (${ATTACHMENT_KINDS[templateType]})\n` +
              `- 登録番号: ${document.documentNumber}\n` +
              `- アップロード: ${uploaderEmail || "(不明)"}\n` +
              `- Drive: ${driveLink}`
            );
          } catch (error) {
            console.warn("[portal-attachments] Backlog comment failed (non-fatal):", error);
          }
        }

        // V1 ページ互換の snake_case 応答（st.textContent が document.document_number を読む）。
        return response.status(200).json({
          ok: true,
          document: {
            id: document.id,
            document_number: document.documentNumber,
            template_type: document.templateType,
            drive_link: document.driveLink,
            matter_id: matterId,
            contract_title: document.contractTitle,
            created_at: document.createdAt
          }
        });
      } catch (error) { return next(error); }
    }
  );

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if ((error as { type?: string })?.type === "entity.too.large") {
      return response.status(413).json({ ok: false, error: "1ファイル 30MB までです" });
    }
    return next(error);
  });

  return router;
}
