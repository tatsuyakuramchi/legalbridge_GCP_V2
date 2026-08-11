import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DocumentRegistryRepository, RegisteredDocument } from "./registry-repository.js";
import type { GmailDeliveryAdapter } from "../integrations/gmail-delivery-adapter.js";
import { isValidEmail } from "../integrations/gmail-delivery-adapter.js";
import {
  evaluateGmailDispatchGate, type GmailDispatchGateSettings
} from "../integrations/gmail-dispatch-gate.js";
import type { GmailSendHistoryRepository } from "../integrations/gmail-send-history-repository.js";
import type { MatterSendRepository } from "../matters/matter-send-repository.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });
const bodySchema = z.object({ to: z.string().trim().min(1, "宛先が必要です").max(255) });

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

// 文書確定・成立通知の件名/本文。テンプレートは変更せず、確定済み文書の
// メタ情報（文書番号・件名・相手方・Driveリンク）から組み立てる。
export function buildFinalizeNotification(document: RegisteredDocument, to: string) {
  const label = document.documentNumber ?? document.issueKey;
  const subject = `【LegalBridge】${label} ${document.title} 確定のお知らせ`;
  const lines = [
    `${document.counterparty || "ご担当者"} 御中`,
    "",
    `${document.title}（文書番号：${document.documentNumber ?? "未採番"} / 案件：${document.issueKey}）を確定しました。`,
    document.driveLink ? `文書URL：${document.driveLink}` : "",
    "",
    "本メールはLegalBridgeから自動送信されています。"
  ].filter((line) => line !== "" || true);
  const bodyText = lines.join("\n");
  const idempotencyKey = createHash("sha256")
    .update(`gmail:${document.id}:${document.documentNumber ?? document.issueKey}:${to.trim().toLowerCase()}`)
    .digest("hex");
  return { to: to.trim(), subject, bodyText, idempotencyKey };
}

export function createGmailNotificationRouter(
  documents: DocumentRegistryRepository | undefined,
  gmail: GmailDeliveryAdapter | undefined,
  gateSettings: GmailDispatchGateSettings,
  sendHistory?: GmailSendHistoryRepository,
  matterSends?: MatterSendRepository
) {
  const router = Router();

  async function load(id: number, to: string) {
    const document = await documents!.find(id);
    if (!document) return null;
    const content = buildFinalizeNotification(document, to);
    let gate = evaluateGmailDispatchGate(
      { to: content.to, subject: content.subject, bodyText: content.bodyText },
      gateSettings
    );
    // 文書リンクなしの「確定のお知らせ」を送れてしまう問題（監査W3 A2.9）：
    // Drive 保存前は本文に文書URLが入らないため、送信をブロックして理由を返す。
    if (!document.driveLink) {
      gate = {
        ...gate,
        dispatchAllowed: false,
        blockerLabels: [...gate.blockerLabels, "文書がまだDriveに保存されていません（先に「Driveへ保存」を実行してください。メール本文に文書URLが入りません）"]
      };
    }
    return { document, content, gate };
  }

  // 送信前プレビュー（送信しない）。ゲートのブロック理由も返す。
  router.post("/documents/:id/gmail-notification/preview", async (request, response, next) => {
    try {
      if (!documents) return response.status(503).json({ error: "document registry unavailable", code: "GMAIL_REGISTRY_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "GMAIL_FORBIDDEN" });
      }
      const { id } = idPath.parse(request.params);
      const { to } = bodySchema.parse(request.body);
      const loaded = await load(id, to);
      if (!loaded) return response.status(404).json({ error: "文書が見つかりません", code: "GMAIL_DOCUMENT_NOT_FOUND" });
      return response.status(200).json({
        preview: { to: loaded.content.to, subject: loaded.content.subject, bodyText: loaded.content.bodyText },
        gate: loaded.gate
      });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 実送信（管理者のみ）。ミドルウェアで gmail スコープ有効時のみ到達する。
  router.post("/documents/:id/gmail-notification/dispatch", async (request, response, next) => {
    try {
      if (!documents || !gmail) return response.status(503).json({ error: "gmail delivery unavailable", code: "GMAIL_DELIVERY_UNAVAILABLE" });
      if (response.locals.currentUser?.role !== "admin") {
        return response.status(403).json({ error: "管理者のみが送信できます", code: "GMAIL_ADMIN_REQUIRED" });
      }
      const { id } = idPath.parse(request.params);
      const { to } = bodySchema.parse(request.body);
      if (!isValidEmail(to)) return response.status(400).json({ error: "宛先メールアドレスが不正です", code: "GMAIL_RECIPIENT_INVALID" });
      const loaded = await load(id, to);
      if (!loaded) return response.status(404).json({ error: "文書が見つかりません", code: "GMAIL_DOCUMENT_NOT_FOUND" });
      if (!loaded.gate.dispatchAllowed) {
        return response.status(409).json({
          error: "送信条件が整っていません", code: "GMAIL_DISPATCH_BLOCKED", blockers: loaded.gate.blockerLabels
        });
      }
      // 冪等強制：送信履歴が有効なら、同一指紋の既送信は再送せず受領情報を返す。
      if (sendHistory) {
        const prior = await sendHistory.findByKey(loaded.content.idempotencyKey);
        if (prior) {
          return response.status(200).json({
            receipt: { messageId: prior.messageId, threadId: prior.threadId },
            integrations: { gmail: "duplicate" }
          });
        }
      }
      const receipt = await gmail.send({
        to: loaded.content.to, subject: loaded.content.subject, bodyText: loaded.content.bodyText,
        fromEmail: gateSettings.senderEmail, fromName: "LegalBridge",
        idempotencyKey: loaded.content.idempotencyKey
      });
      if (sendHistory) {
        await sendHistory.record({
          idempotencyKey: loaded.content.idempotencyKey,
          documentId: loaded.document.id,
          recipient: loaded.content.to,
          messageId: receipt.messageId,
          threadId: receipt.threadId,
          recordedBy: response.locals.currentUser?.email ?? "unknown"
        });
      }
      // 案件の送信履歴へ自動記録（手動での二重記帳を廃止・監査W3 A3.7）。失敗しても送信自体は成功扱い。
      if (matterSends && loaded.document.matterId != null) {
        try {
          await matterSends.record(loaded.document.matterId, {
            documentId: loaded.document.id, channel: "email", recipient: loaded.content.to,
            status: "sent", subject: loaded.content.subject,
            messageId: receipt.messageId, sentBy: response.locals.currentUser?.email ?? null
          });
        } catch { /* 台帳未整備でも送信は成立している */ }
      }
      return response.status(201).json({ receipt, integrations: { gmail: "sent" } });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
