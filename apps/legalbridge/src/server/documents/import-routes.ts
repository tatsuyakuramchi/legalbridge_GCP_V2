import { Router, raw, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  documentImportRowSchema, DocumentImportError, type DocumentImportRepository
} from "./import-repository.js";
import { MultipartError, parseMultipart } from "./multipart.js";
import type { DriveStorage } from "./drive-storage.js";
import { buildDocumentConditionInputs, hasConditionSyncData } from "./condition-sync.js";
import type { ConditionSyncRepository } from "./condition-sync-repository.js";

// Bulk register legacy/past documents. Reuses the `documents` write capability.
// 取込強化（2026-08-21）: ファイルを添えた取込（multipart → Drive 格納 → 登録）を
// 追加。過去文書の実体を Drive に置くことで、取込直後からメールPDF添付・
// CloudSign 送信（テンプレート無し文書の Drive 実体経路）が使える。
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function canImport(role: string | undefined) { return role === "admin" || role === "legal"; }

export function createDocumentImportRouter(
  documents: DocumentImportRepository | undefined,
  writeEnabled = false,
  storage?: DriveStorage | null,
  // 取込文書の詳細編集で金銭条件を保存したとき、条件明細台帳へ自動同期する
  // （取込文書は確定フローを通らないため、確定時同期の代わりにここで行う）。
  conditionSync?: ConditionSyncRepository
) {
  const router = Router();

  router.post("/documents/import/validate", (request, response) => {
    const result = z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).safeParse(request.body);
    if (!result.success) {
      return response.status(400).json({ ok: false, error: "invalid request" });
    }
    const errors = result.data.rows.map((row, index) => {
      const parsed = documentImportRowSchema.safeParse(row);
      return parsed.success ? null : { index, error: parsed.error.issues.map((i) => i.message).join(" / ") };
    }).filter(Boolean);
    return response.status(200).json({ ok: errors.length === 0, errors });
  });

  router.post("/documents/import", async (request, response, next) => {
    try {
      if (!writeEnabled || !documents) {
        return response.status(503).json({ error: "document import is not enabled", code: "DOCUMENT_IMPORT_UNAVAILABLE" });
      }
      if (!canImport(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが取込できます", code: "DOCUMENT_IMPORT_FORBIDDEN" });
      }
      const body = z.object({
        rows: z.array(z.record(z.string(), z.unknown())).min(1, "取込む行がありません").max(500)
      }).parse(request.body);
      const email = response.locals.currentUser!.email;
      const inserted: Array<{ index: number; id: number; documentNumber: string }> = [];
      const failed: Array<{ index: number; error: string }> = [];
      for (let index = 0; index < body.rows.length; index += 1) {
        const parsed = documentImportRowSchema.safeParse(body.rows[index]);
        if (!parsed.success) {
          failed.push({ index, error: parsed.error.issues.map((i) => i.message).join(" / ") });
          continue;
        }
        try {
          const doc = await documents.importOne(parsed.data, email);
          inserted.push({ index, id: doc.id, documentNumber: doc.documentNumber });
        } catch (error) {
          const message = error instanceof DocumentImportError ? error.message
            : error instanceof Error ? error.message : "取込に失敗しました";
          failed.push({ index, error: message });
        }
      }
      return response.status(inserted.length ? 201 : 422).json({
        insertedCount: inserted.length, failedCount: failed.length, inserted, failed
      });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      next(error);
    }
  });

  // ファイル添付つきの取込（1件）。実体を Drive に格納してから登録する。
  // Drive 上のファイル名は「文書番号_元ファイル名」（過去文書を後から探せるように）。
  router.post(
    "/documents/import/upload",
    raw({ type: "multipart/form-data", limit: `${MAX_FILE_BYTES + 1024 * 1024}b` }),
    async (request, response, next) => {
      try {
        if (!writeEnabled || !documents) {
          return response.status(503).json({ error: "document import is not enabled", code: "DOCUMENT_IMPORT_UNAVAILABLE" });
        }
        if (!canImport(response.locals.currentUser?.role)) {
          return response.status(403).json({ error: "法務または管理者のみが取込できます", code: "DOCUMENT_IMPORT_FORBIDDEN" });
        }
        if (!storage?.uploadFile) {
          return response.status(503).json({
            error: "Drive連携が有効でないため、ファイルつき取込はできません（Driveリンクでの取込は可能です）",
            code: "DOCUMENT_IMPORT_DRIVE_UNAVAILABLE"
          });
        }
        if (!Buffer.isBuffer(request.body)) {
          return response.status(400).json({ error: "multipart/form-data で送信してください", code: "DOCUMENT_IMPORT_NOT_MULTIPART" });
        }

        let payload;
        try {
          payload = parseMultipart(request.body, request.headers["content-type"]);
        } catch (error) {
          if (error instanceof MultipartError) {
            return response.status(400).json({ error: error.message, code: `DOCUMENT_IMPORT_${error.code}` });
          }
          throw error;
        }
        const file = payload.files.find((f) => f.field === "file");
        if (!file || !file.data.length) {
          return response.status(400).json({ error: "ファイルが指定されていません", code: "DOCUMENT_IMPORT_NO_FILE" });
        }
        if (file.data.length > MAX_FILE_BYTES) {
          return response.status(413).json({ error: "1ファイル 30MB までです", code: "DOCUMENT_IMPORT_TOO_LARGE" });
        }
        // multipart ヘッダの filename は非 ASCII で化ける環境があるため、FE が
        // File.name を通常フィールド（originalName）で併送してきたら優先する（添付と同様）。
        const rawName = String(payload.fields.originalName ?? "").trim() || file.filename || "document";
        const safeName = rawName.replace(/[\r\n]/g, "_");

        const parsed = documentImportRowSchema.safeParse({
          documentNumber: payload.fields.documentNumber,
          templateType: payload.fields.templateType,
          issueKey: payload.fields.issueKey,
          matterId: String(payload.fields.matterId ?? "").trim() || undefined,
          counterpartyVendorId: String(payload.fields.counterpartyVendorId ?? "").trim() || undefined,
          title: payload.fields.title,
          counterparty: payload.fields.counterparty,
          documentDate: payload.fields.documentDate,
          workCode: payload.fields.workCode,
          supersededBy: payload.fields.supersededBy,
          originalFileName: safeName,
          mimeType: file.contentType && file.contentType !== "application/octet-stream" ? file.contentType : undefined
        });
        if (!parsed.success) {
          return response.status(400).json({
            error: parsed.error.issues.map((i) => i.message).join(" / "), code: "DOCUMENT_IMPORT_INVALID"
          });
        }

        // Drive へ上げる前に番号衝突を弾く（孤児ファイルを作らない）。
        if (await documents.exists(parsed.data.documentNumber)) {
          return response.status(409).json({ error: "その文書番号は既に存在します", code: "DOCUMENT_CONFLICT" });
        }

        let driveLink = "";
        try {
          const stored = await storage.uploadFile({
            filename: `${parsed.data.documentNumber}_${safeName}`.replace(/[\\/]/g, "_"),
            mimeType: file.contentType || "application/octet-stream",
            data: file.data
          });
          driveLink = stored.webViewLink;
        } catch (error) {
          return response.status(502).json({
            error: `Drive アップロードに失敗しました: ${String((error as Error)?.message ?? error).slice(0, 300)}`,
            code: "DOCUMENT_IMPORT_DRIVE_FAILED"
          });
        }

        const email = String(response.locals.currentUser?.email ?? "unknown");
        try {
          const doc = await documents.importOne({ ...parsed.data, driveLink }, email);
          return response.status(201).json({ document: doc, driveLink });
        } catch (error) {
          if (error instanceof DocumentImportError) {
            const status = error.code === "DOCUMENT_CONFLICT" ? 409 : 422;
            return response.status(status).json({ error: error.message, code: error.code });
          }
          throw error;
        }
      } catch (error) { return next(error); }
    }
  );

  // 取込文書の詳細編集（過去文書ベースの検収書・利用許諾料計算書作成のための後入力）。
  // 生成された文書（template_version_id あり）は対象外＝再発行（特例編集）を使う。
  // form_data を丸ごと差し替える（クライアントは現状の formData に編集を重ねて送る）。
  const detailsSchema = z.object({
    formData: z.record(z.string(), z.unknown()),
    // 相手先の取引先マスタ結線（documents.vendor_id）。省略=変更しない / null=外す。
    counterpartyVendorId: z.union([z.coerce.number().int().positive(), z.null()]).optional()
  });
  router.put("/documents/:id/import-details", async (request, response, next) => {
    try {
      if (!writeEnabled || !documents) {
        return response.status(503).json({ error: "document import is not enabled", code: "DOCUMENT_IMPORT_UNAVAILABLE" });
      }
      if (!canImport(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが編集できます", code: "DOCUMENT_IMPORT_FORBIDDEN" });
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "invalid document id" });
      }
      const input = detailsSchema.parse(request.body ?? {});
      if (JSON.stringify(input.formData).length > 200_000) {
        return response.status(413).json({ error: "登録内容が大きすぎます", code: "DOCUMENT_IMPORT_DETAILS_TOO_LARGE" });
      }
      let updated: boolean;
      try {
        updated = await documents.updateDetails(id, input.formData, input.counterpartyVendorId);
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({
            error: "取込文書の編集権限が付与されていません（grant 064 を適用してください）",
            code: "DOCUMENT_IMPORT_DETAILS_FORBIDDEN_DB"
          });
        }
        throw error;
      }
      if (!updated) {
        return response.status(404).json({
          error: "取込文書が見つかりません（テンプレートから生成した文書は再発行で編集してください）",
          code: "DOCUMENT_IMPORT_DETAILS_NOT_FOUND"
        });
      }
      // 金銭条件を含む保存なら台帳（condition_lines）へ自動同期（確定時同期と同じ
      // ベストエフォート）。失敗しても保存は成立＝「条件明細を台帳へ同期」で回復できる。
      let conditionSyncResult: { written: number; deleted: number } | null = null;
      let conditionSyncWarning: string | undefined;
      if (conditionSync && hasConditionSyncData(input.formData)) {
        try {
          const synced = await conditionSync.upsertDocumentConditions(
            id, buildDocumentConditionInputs(input.formData)
          );
          conditionSyncResult = { written: synced.written, deleted: synced.deleted };
        } catch (error) {
          conditionSyncWarning = (error as { code?: string })?.code === "42501"
            ? "条件明細の台帳同期権限が未付与です（grant 066）。適用後「条件明細を台帳へ同期」で反映できます"
            : `条件明細の台帳同期に失敗しました（「条件明細を台帳へ同期」で再実行できます）: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
        }
      }
      return response.status(200).json({
        updated: true,
        ...(conditionSyncResult ? { conditionSync: conditionSyncResult } : {}),
        ...(conditionSyncWarning ? { conditionSyncWarning } : {})
      });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 確定文書の表示情報の特例修正。文書上は相手先名が入っているのに一覧・検索で
  // ブランクになる（V1由来のキーで保存されていて表示側が読めない）ケースの補正。
  // 一覧・検索・引用が読む title / counterparty キーだけをマージ追記し、
  // form_data の他のキー（＝PDF の中身になるデータ）には触れない。
  // 文書内容そのものの訂正はここでは行わず、再発行（特例編集）を使う。
  const displaySchema = z.object({
    title: z.string().trim().max(300).optional(),
    counterparty: z.string().trim().max(300).optional()
  }).refine((v) => v.title !== undefined || v.counterparty !== undefined,
    { message: "件名または相手先のどちらかを指定してください" });
  router.put("/documents/:id/display-fields", async (request, response, next) => {
    try {
      if (!writeEnabled || !documents) {
        return response.status(503).json({ error: "document import is not enabled", code: "DOCUMENT_IMPORT_UNAVAILABLE" });
      }
      if (!canImport(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが修正できます", code: "DOCUMENT_IMPORT_FORBIDDEN" });
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "invalid document id" });
      }
      const input = displaySchema.parse(request.body ?? {});
      const patch: Record<string, string> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.counterparty !== undefined) patch.counterparty = input.counterparty;
      let updated: boolean;
      try {
        updated = await documents.mergeDisplayFields(id, patch);
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({
            error: "表示情報の修正権限が付与されていません（grant 064 を適用してください）",
            code: "DOCUMENT_DISPLAY_FIELDS_FORBIDDEN_DB"
          });
        }
        throw error;
      }
      if (!updated) {
        return response.status(404).json({ error: "文書が見つかりません", code: "DOCUMENT_NOT_FOUND" });
      }
      return response.status(200).json({ updated: true, patch });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // express.raw の limit 超過（PayloadTooLarge）をこのルータ内で 413 に変換する。
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if ((error as { type?: string })?.type === "entity.too.large") {
      return response.status(413).json({ error: "1ファイル 30MB までです", code: "DOCUMENT_IMPORT_TOO_LARGE" });
    }
    return next(error);
  });

  // 作品との紐づけ・巻き直しの旧版指定（作品一括編集「既存文書と条件明細」）。
  // 取込文書・確定文書を問わず form_data の work_code / superseded_by だけを付け外しする。
  //   { workCode: "WRK-10013" }            … 作品に紐づける
  //   { workCode: null }                   … 紐づけを外す
  //   { supersededBy: "LIC-2024-0012" }    … 旧版にする（有効版の文書番号）
  //   { supersededBy: null }               … 旧版指定を解除
  const workLinkSchema = z.object({
    workCode: z.string().trim().max(40).nullable().optional(),
    supersededBy: z.string().trim().max(100).nullable().optional()
  }).refine((v) => v.workCode !== undefined || v.supersededBy !== undefined, { message: "変更する項目がありません" });
  router.post("/documents/:id/work-link", async (request, response, next) => {
    try {
      if (!writeEnabled || !documents) {
        return response.status(503).json({ error: "document import is not enabled", code: "DOCUMENT_IMPORT_UNAVAILABLE" });
      }
      if (!canImport(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "DOCUMENT_IMPORT_FORBIDDEN" });
      }
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const link = workLinkSchema.parse(request.body ?? {});
      const updated = await documents.setWorkLink(id, {
        ...(link.workCode !== undefined ? { workCode: link.workCode || null } : {}),
        ...(link.supersededBy !== undefined ? { supersededBy: link.supersededBy || null } : {})
      });
      if (!updated) return response.status(404).json({ error: "文書が見つかりません", code: "DOCUMENT_NOT_FOUND" });
      return response.status(200).json({ ok: true });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
