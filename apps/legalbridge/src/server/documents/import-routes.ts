import { Router, raw, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  documentImportRowSchema, DocumentImportError, type DocumentImportRepository
} from "./import-repository.js";
import { MultipartError, parseMultipart } from "./multipart.js";
import type { DriveStorage } from "./drive-storage.js";

// Bulk register legacy/past documents. Reuses the `documents` write capability.
// 取込強化（2026-08-21）: ファイルを添えた取込（multipart → Drive 格納 → 登録）を
// 追加。過去文書の実体を Drive に置くことで、取込直後からメールPDF添付・
// CloudSign 送信（テンプレート無し文書の Drive 実体経路）が使える。
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function canImport(role: string | undefined) { return role === "admin" || role === "legal"; }

export function createDocumentImportRouter(
  documents: DocumentImportRepository | undefined,
  writeEnabled = false,
  storage?: DriveStorage | null
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
          title: payload.fields.title,
          counterparty: payload.fields.counterparty,
          documentDate: payload.fields.documentDate,
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

  // express.raw の limit 超過（PayloadTooLarge）をこのルータ内で 413 に変換する。
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if ((error as { type?: string })?.type === "entity.too.large") {
      return response.status(413).json({ error: "1ファイル 30MB までです", code: "DOCUMENT_IMPORT_TOO_LARGE" });
    }
    return next(error);
  });

  return router;
}
