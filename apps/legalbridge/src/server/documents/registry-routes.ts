import { Router } from "express";
import type { DocumentRegistryRepository } from "./registry-repository.js";

export function createDocumentRegistryRouter(repository: DocumentRegistryRepository) {
  const router = Router();

  router.get("/documents", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").slice(0, 100);
      const templateType = String(request.query.template_type ?? "").slice(0, 60);
      const limit = Number.parseInt(String(request.query.limit ?? "100"), 10) || 100;
      response.json({
        documents: await repository.list(query, templateType || undefined, limit)
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
      if (!document) return response.status(404).json({ error: "document not found" });
      response.json({ document });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
