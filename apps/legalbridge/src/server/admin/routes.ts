import { Router } from "express";
import type { AdminRepository } from "./repository.js";
import { slackUxPreviewCatalog } from "../integrations/slack-ux.js";
export function createAdminRouter(repository: AdminRepository) {
  const router = Router();
  router.get("/admin/overview", async (_request, response, next) => {
    try { response.json(await repository.overview()); }
    catch (error) { next(error); }
  });
  router.get("/admin/slack-ux-preview", (_request, response) => {
    response.json({
      mode: "preview",
      externalSend: false,
      principles: [
        "Slackは申請入口と行動が必要な通知に限定する",
        "案件ごとに一つのスレッドへ集約する",
        "内部工程を利用者向けの七段階へ変換する",
        "通知には現在地と次の行動を必ず表示する"
      ],
      notifications: slackUxPreviewCatalog()
    });
  });
  return router;
}
