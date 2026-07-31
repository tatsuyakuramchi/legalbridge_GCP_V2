import { Router } from "express";
import type { AdminRepository } from "./repository.js";
export function createAdminRouter(repository: AdminRepository) {
  const router = Router();
  router.get("/admin/overview", async (_request, response, next) => {
    try { response.json(await repository.overview()); }
    catch (error) { next(error); }
  });
  return router;
}
