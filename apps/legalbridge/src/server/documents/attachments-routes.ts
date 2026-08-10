import { Router, raw, type NextFunction, type Request, type Response } from "express";
import { MultipartError, parseMultipart } from "./multipart.js";
import type { DriveStorage } from "./drive-storage.js";
import {
  ATTACHMENT_KINDS, type AttachmentsRepository
} from "./attachments-repository.js";

// 案件への資料アップロード（Phase 16-4・guarded scope 'attachments'）。
// multipart を依存フリーパーサで解釈し、Drive へ生ファイル格納 → documents 行
// （ATT 採番）として案件へ紐付ける。Drive 上のファイル名は V1 と同じ
// 「課題番号（無ければ案件コード）_アカウント_元ファイル名」。

const MAX_FILE_BYTES = 30 * 1024 * 1024;

export interface AttachmentsRouterDependencies {
  repository?: AttachmentsRepository;
  storage?: DriveStorage | null;
  // Backlog 課題への気づきコメント（V1 同様ベストエフォート・失敗しても添付は成功扱い）。
  postComment?: (issueKey: string, text: string) => Promise<void>;
  writeEnabled?: boolean;
}

function canUpload(role: string | undefined) { return role === "admin" || role === "legal"; }

export function createAttachmentsRouter(dependencies: AttachmentsRouterDependencies) {
  const { repository, storage, postComment } = dependencies;
  const writeEnabled = dependencies.writeEnabled === true;
  const router = Router();

  router.post(
    "/matters/:id/attachments",
    raw({ type: "multipart/form-data", limit: `${MAX_FILE_BYTES + 1024 * 1024}b` }),
    async (request, response, next) => {
      try {
        if (!writeEnabled || !repository || !storage?.uploadFile) {
          return response.status(503).json({
            error: "attachment upload is not enabled", code: "ATTACHMENTS_WRITE_UNAVAILABLE"
          });
        }
        if (!canUpload(response.locals.currentUser?.role)) {
          return response.status(403).json({
            error: "管理者または法務のみが資料を添付できます", code: "ATTACHMENTS_FORBIDDEN"
          });
        }
        const matterId = Number(request.params.id);
        if (!Number.isInteger(matterId) || matterId <= 0) {
          return response.status(400).json({ error: "invalid matter id" });
        }
        if (!Buffer.isBuffer(request.body)) {
          return response.status(400).json({
            error: "multipart/form-data で送信してください", code: "ATTACHMENTS_NOT_MULTIPART"
          });
        }

        let payload;
        try {
          payload = parseMultipart(request.body, request.headers["content-type"]);
        } catch (error) {
          if (error instanceof MultipartError) {
            return response.status(400).json({ error: error.message, code: `ATTACHMENTS_${error.code}` });
          }
          throw error;
        }
        const file = payload.files.find((f) => f.field === "file");
        if (!file || !file.data.length) {
          return response.status(400).json({ error: "ファイルが指定されていません", code: "ATTACHMENTS_NO_FILE" });
        }
        if (file.data.length > MAX_FILE_BYTES) {
          return response.status(413).json({ error: "1ファイル 30MB までです", code: "ATTACHMENTS_TOO_LARGE" });
        }

        const kind = String(payload.fields.docKind ?? "").trim();
        const templateType = ATTACHMENT_KINDS[kind] ? kind : "reference";
        // multipart ヘッダの filename は非 ASCII で化ける環境があるため、FE が
        // File.name を通常フィールド（originalName）で併送してきたら優先する（V1 同様）。
        const rawName = String(payload.fields.originalName ?? "").trim() || file.filename || "attachment";
        const safeName = rawName.replace(/[\r\n]/g, "_");

        const matter = await repository.findMatter(matterId);
        if (!matter) {
          return response.status(404).json({ error: "案件が見つかりません", code: "MATTER_NOT_FOUND" });
        }

        // アップロード者は認証済みユーザーのメール（ブラウザ入力は信用しない・V1 同様）。
        const uploaderEmail = String(response.locals.currentUser?.email ?? "").trim();
        const accountPart = (uploaderEmail || "unknown").replace(/[\r\n\\/]/g, "_");
        const keyPart = matter.primaryIssueKey || matter.matterCode || `M${matter.id}`;
        const driveFileName = `${keyPart}_${accountPart}_${safeName}`;

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
            error: `Drive アップロードに失敗しました: ${String((error as Error)?.message ?? error).slice(0, 300)}`,
            code: "ATTACHMENTS_DRIVE_FAILED"
          });
        }

        let document;
        try {
          document = await repository.register({
            matterId: matter.id,
            issueKey: matter.primaryIssueKey,
            templateType,
            driveLink,
            originalName: safeName,
            mimeType: file.contentType || "application/octet-stream",
            sizeBytes: file.data.length,
            uploadedBy: uploaderEmail || null
          });
        } catch (error) {
          if ((error as { code?: string })?.code === "42501") {
            return response.status(503).json({
              error: "添付登録の権限が付与されていません", code: "ATTACHMENTS_FORBIDDEN_DB"
            });
          }
          throw error;
        }

        // Backlog 課題への気づき導線（失敗してもアップロード自体は成功扱い・V1 同様）。
        if (postComment && matter.primaryIssueKey) {
          try {
            await postComment(
              matter.primaryIssueKey,
              `📎 資料が添付されました。\n` +
              `- ファイル: ${safeName} (${ATTACHMENT_KINDS[templateType]})\n` +
              `- 登録番号: ${document.documentNumber}\n` +
              `- アップロード: ${uploaderEmail || "(不明)"}\n` +
              `- Drive: ${driveLink}`
            );
          } catch (error) {
            console.warn("[attachments] Backlog comment failed (non-fatal):", error);
          }
        }

        return response.status(200).json({ ok: true, document });
      } catch (error) { return next(error); }
    }
  );

  // express.raw の limit 超過（PayloadTooLarge）をこのルータ内で 413 に変換する。
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if ((error as { type?: string })?.type === "entity.too.large") {
      return response.status(413).json({ error: "1ファイル 30MB までです", code: "ATTACHMENTS_TOO_LARGE" });
    }
    return next(error);
  });

  return router;
}
