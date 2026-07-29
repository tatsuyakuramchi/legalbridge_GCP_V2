import { Router } from "express";
import type { MasterDataRepository, MasterDataType } from "./repository.js";

const types = new Set<MasterDataType>(["vendor", "staff", "document", "work", "company"]);

export function createMasterDataRouter(repository: MasterDataRepository) {
  const router = Router();
  router.get("/master-data/search", async (request, response, next) => {
    try {
      const type = String(request.query.type ?? "") as MasterDataType;
      if (!types.has(type)) {
        return response.status(400).json({ error: "invalid master data type" });
      }
      const query = String(request.query.q ?? "").slice(0, 100);
      const limit = Number.parseInt(String(request.query.limit ?? "20"), 10) || 20;
      response.json({ type, items: await repository.search(type, query, limit) });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
