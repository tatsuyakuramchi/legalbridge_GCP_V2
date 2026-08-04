import { Router } from "express";
import { z } from "zod";
import {
  documentImportRowSchema, DocumentImportError, type DocumentImportRepository
} from "./import-repository.js";

// Bulk register legacy/past documents. Reuses the `documents` write capability.
export function createDocumentImportRouter(
  documents: DocumentImportRepository | undefined,
  writeEnabled = false
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
      if (response.locals.currentUser?.role !== "admin" && response.locals.currentUser?.role !== "legal") {
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

  return router;
}
