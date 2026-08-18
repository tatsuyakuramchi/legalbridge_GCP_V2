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
      // 文書検索の絞り込み（例: 検収書フォームの親PO検索は発注書だけを出す）。
      // template_type の前方一致・カンマ区切り。英小文字と _ 以外は捨てる。
      const templates = String(request.query.template ?? "")
        .split(",").map((value) => value.trim())
        .filter((value) => /^[a-z_]{1,50}$/.test(value));
      response.json({ type, items: await repository.search(type, query, limit, templates) });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
