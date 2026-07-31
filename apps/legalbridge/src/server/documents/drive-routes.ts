import { Router } from "express";
import type { DocumentRegistryRepository } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import {
  renderStoredDocumentHtml,
  StoredDocumentTemplateVersionError
} from "./document-html-renderer.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import type { DriveStorage } from "./drive-storage.js";

export function createDocumentDriveRouter(
  documents: DocumentRegistryRepository,
  templates: TemplateRepository,
  pdfRenderer: PdfRenderer,
  drive: DriveStorage | null,
  enabled: boolean
) {
  const router = Router();

  router.post("/documents/:id/drive", async (request, response, next) => {
    try {
      if (!enabled || !drive) {
        return response.status(403).json({
          error: "Drive storage is not enabled",
          code: "DRIVE_STORAGE_DISABLED"
        });
      }
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "invalid document id" });
      }
      const document = await documents.find(id);
      if (!document) return response.status(404).json({ error: "document not found" });
      if (document.driveLink) {
        return response.status(200).json({ driveLink: document.driveLink, reused: true });
      }

      const existing = await drive.findByDocumentId(id);
      if (existing) {
        await documents.setDriveLink(id, existing.webViewLink);
        return response.status(200).json({ driveLink: existing.webViewLink, reused: true });
      }

      const html = await renderStoredDocumentHtml(templates, document);
      if (!html) return response.status(404).json({ error: "template not found" });
      const pdf = await pdfRenderer.render(html);
      const filename = `${safeFilename(document.documentNumber ?? `document-${id}`)}.pdf`;
      const uploaded = await drive.uploadPdf({ documentId: id, filename, pdf });
      await documents.setDriveLink(id, uploaded.webViewLink);
      return response.status(201).json({ driveLink: uploaded.webViewLink, reused: false });
    } catch (error) {
      if (error instanceof StoredDocumentTemplateVersionError) {
        return response.status(409).json({
          error: error.message,
          storedTemplateVersionId: error.storedVersionId,
          currentTemplateVersionId: error.currentVersionId
        });
      }
      next(error);
    }
  });

  return router;
}

function safeFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
}
