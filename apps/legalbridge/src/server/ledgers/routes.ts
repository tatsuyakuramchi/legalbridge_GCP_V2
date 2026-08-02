import { Router } from "express";
import type { LedgerRepository, LedgerType } from "./repository.js";
const types = new Set<LedgerType>(["vendors", "works", "materials", "conditions"]);
export function createLedgerRouter(repository: LedgerRepository) {
  const router = Router();
  router.get("/ledgers/:type", async (request, response, next) => {
    try {
      const type = request.params.type as LedgerType;
      if (!types.has(type)) return response.status(404).json({ error: "ledger not found" });
      const query = String(request.query.q ?? "").slice(0, 100);
      const limit = Number.parseInt(String(request.query.limit ?? "200"), 10) || 200;
      response.json({ type, items: await repository.list(type, query, limit) });
    } catch (error) { next(error); }
  });
  return router;
}
