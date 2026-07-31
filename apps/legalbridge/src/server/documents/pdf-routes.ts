import { Router } from "express";
import type { DocumentRegistryRepository } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import {
  renderStoredDocumentHtml,
  StoredDocumentTemplateVersionError
} from "./document-html-renderer.js";
import type { PdfRenderer } from "./pdf-renderer.js";

export function createDocumentPdfRouter(
  documents: DocumentRegistryRepository,
  templates: TemplateRepository,
  pdfRenderer: PdfRenderer,
  enabled: boolean
) {
  const router = Router();

  router.get("/documents/:id/pdf", async (request, response, next) => {
    try {
      if (!enabled) {
        return response.status(403).json({
          error: "PDF generation is not enabled",
          code: "PDF_GENERATION_DISABLED"
        });
      }
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "invalid document id" });
      }
      const document = await documents.find(id);
      if (!document) return response.status(404).json({ error: "document not found" });
      const html = await renderStoredDocumentHtml(templates, document);
      if (!html) return response.status(404).json({ error: "template not found" });
      const pdf = await pdfRenderer.render(html);
      const filename = safeFilename(document.documentNumber ?? `document-${document.id}`);

      response
        .status(200)
        .type("application/pdf")
        .setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`)
        .setHeader("Cache-Control", "no-store")
        .send(pdf);
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
