import { Router } from "express";
import type { GmailInboundAdapter } from "../integrations/gmail-inbound-adapter.js";

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

export interface GmailInboundSettings {
  enabled: boolean;      // scope + live + adapter configured
  query: string;         // 既定検索クエリ
  mailbox: string;
}

export function createGmailInboundRouter(
  inbound: GmailInboundAdapter | undefined,
  settings: GmailInboundSettings
) {
  const router = Router();

  // 契約候補メール一覧（PDF添付あり）。未有効なら live=false で返す。
  router.get("/gmail-inbound/contracts", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "GMAIL_INBOUND_FORBIDDEN" });
      }
      if (!inbound || !settings.enabled) {
        return response.status(200).json({ live: false, mailbox: settings.mailbox, messages: [] });
      }
      const q = typeof request.query.q === "string" && request.query.q.trim()
        ? request.query.q.trim().slice(0, 500)
        : settings.query;
      const messages = await inbound.listContracts(q, 25);
      return response.status(200).json({ live: true, mailbox: settings.mailbox, query: q, messages });
    } catch (error) {
      return next(error);
    }
  });

  // 添付PDFの取得（ダウンロード）。有効時のみ。
  router.get("/gmail-inbound/messages/:messageId/attachments/:attachmentId", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "GMAIL_INBOUND_FORBIDDEN" });
      }
      if (!inbound || !settings.enabled) {
        return response.status(409).json({ error: "Gmail受信取込は無効です", code: "GMAIL_INBOUND_DISABLED" });
      }
      const messageId = String(request.params.messageId).slice(0, 200);
      const attachmentId = String(request.params.attachmentId).slice(0, 400);
      const pdf = await inbound.fetchAttachment(messageId, attachmentId);
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Disposition", `inline; filename="contract-${messageId}.pdf"`);
      return response.status(200).send(pdf);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
