import { Router, type Response } from "express";
import type { DocumentRegistryRepository } from "./registry-repository.js";

export function createDocumentRegistryRouter(repository: DocumentRegistryRepository) {
  const router = Router();

  router.get("/documents", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").slice(0, 100);
      const templateType = String(request.query.template_type ?? "").slice(0, 60);
      const limit = Number.parseInt(String(request.query.limit ?? "100"), 10) || 100;
      const owner = requesterEmail(response);
      const listed = await repository.list(query, templateType || undefined, owner ? 200 : limit);
      const documents = listed.filter((document) => owns(document.createdBy, owner)).slice(0, limit);
      response.json({
        documents: documents.map(({ formData: _formData, ...document }) => ({
          ...document,
          lifecycle: documentLifecycle(document)
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id", async (request, response, next) => {
    try {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "invalid document id" });
      }
      const document = await repository.find(id);
      if (!document || !owns(document.createdBy, requesterEmail(response))) {
        return response.status(404).json({ error: "document not found" });
      }
      response.json({
        document: {
          ...document,
          lifecycle: documentLifecycle(document),
          formData: maskSensitiveFields(document.formData)
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function requesterEmail(response: Response) {
  const user = response.locals.currentUser;
  return user?.role === "requester" ? user.email.toLowerCase() : "";
}

function owns(recordEmail: string | null | undefined, requiredOwner: string) {
  return !requiredOwner || recordEmail?.toLowerCase() === requiredOwner;
}

function maskSensitiveFields(formData: Record<string, unknown>) {
  const sensitive = /account|口座|bank|銀行|email|メール|phone|電話/i;
  return Object.fromEntries(Object.entries(formData).map(([key, value]) => {
    if (!sensitive.test(key) || value == null || value === "") return [key, value];
    const text = String(value);
    return [key, text.length > 4 ? `${"*".repeat(Math.min(8, text.length - 4))}${text.slice(-4)}` : "****"];
  }));
}


function documentLifecycle(document: {
  documentNumber: string | null;
  driveLink: string;
}) {
  const finalized = Boolean(document.documentNumber);
  const driveStored = Boolean(document.driveLink);
  return {
    state: finalized ? "finalized" : "registered",
    label: finalized ? "確定済み" : "登録済み・未発番",
    pdfState: finalized ? "ready" : "unavailable",
    pdfLabel: finalized ? "PDF生成可能" : "発番後にPDF生成可能",
    driveState: driveStored ? "stored" : "not_stored",
    driveLabel: driveStored ? "Drive保存済み" : "Drive未保存"
  };
}
