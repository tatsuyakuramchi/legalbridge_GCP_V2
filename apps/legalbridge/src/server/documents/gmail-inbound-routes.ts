import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { GmailInboundAdapter } from "../integrations/gmail-inbound-adapter.js";
import { isPdfBufferSafe } from "../integrations/gmail-inbound-adapter.js";
import type {
  InboundContractRepository, InboundContractStatus
} from "../integrations/inbound-contract-repository.js";

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

export interface GmailInboundSettings {
  enabled: boolean;      // scope + live + adapter configured
  query: string;         // 既定検索クエリ
  mailbox: string;
}

// 受信取込の指紋。messageId と attachmentId で一意化（同一添付の再取込を冪等化）。
export function inboundContractKey(messageId: string, attachmentId: string): string {
  return createHash("sha256").update(`inbound:${messageId}:${attachmentId}`).digest("hex");
}

const registerBody = z.object({
  filename: z.string().trim().max(400).optional(),
  from: z.string().trim().max(400).optional(),
  subject: z.string().trim().max(1000).optional(),
  threadId: z.string().trim().max(200).optional(),
  receivedAt: z.string().trim().max(60).optional()
});
const statusBody = z.object({ status: z.enum(["captured", "linked", "dismissed"]) });

export function createGmailInboundRouter(
  inbound: GmailInboundAdapter | undefined,
  settings: GmailInboundSettings,
  intake?: InboundContractRepository
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

  // 取込登録（隔離台帳への恒久記録）。添付PDFを取得・検証し、取込台帳に1件記録する。
  // 既存業務テーブルには触れない。同一添付は冪等（既記録をそのまま返す・duplicate）。
  router.post("/gmail-inbound/messages/:messageId/attachments/:attachmentId/register",
    async (request, response, next) => {
      try {
        if (!editorAllowed(response.locals.currentUser?.role)) {
          return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "GMAIL_INBOUND_FORBIDDEN" });
        }
        if (!inbound || !settings.enabled || !intake) {
          return response.status(409).json({ error: "Gmail受信取込の登録は無効です", code: "GMAIL_INBOUND_INTAKE_DISABLED" });
        }
        const messageId = String(request.params.messageId).slice(0, 200);
        const attachmentId = String(request.params.attachmentId).slice(0, 400);
        const meta = registerBody.parse(request.body ?? {});
        const key = inboundContractKey(messageId, attachmentId);

        const prior = await intake.findByKey(key);
        if (prior) {
          return response.status(200).json({ record: prior, intake: "duplicate" });
        }

        // 実バイト列を取得し、PDF であることを検証してから記録する。
        const pdf = await inbound.fetchAttachment(messageId, attachmentId);
        if (!isPdfBufferSafe(pdf)) {
          return response.status(422).json({ error: "添付がPDFではありません", code: "GMAIL_INBOUND_NOT_PDF" });
        }

        const record = await intake.capture({
          idempotencyKey: key,
          messageId,
          attachmentId,
          threadId: meta.threadId ?? null,
          filename: meta.filename ?? `contract-${messageId}.pdf`,
          fromAddress: meta.from ?? "",
          subject: meta.subject ?? "",
          receivedAt: meta.receivedAt ?? null,
          capturedBy: response.locals.currentUser?.email ?? "unknown"
        });
        return response.status(201).json({ record, intake: "captured" });
      } catch (error) {
        if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
        return next(error);
      }
    });

  // 取込台帳の一覧（読取）。status で絞り込み可。台帳が無ければ enabled=false。
  router.get("/gmail-inbound/registered", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "GMAIL_INBOUND_FORBIDDEN" });
      }
      if (!intake) return response.status(200).json({ enabled: false, records: [] });
      const status = typeof request.query.status === "string"
        ? request.query.status as InboundContractStatus : undefined;
      const filter = status && ["captured", "linked", "dismissed"].includes(status) ? status : undefined;
      const records = await intake.list(filter);
      return response.status(200).json({ enabled: true, records });
    } catch (error) {
      return next(error);
    }
  });

  // 取込レコードの状態遷移（captured→linked/dismissed 等）。
  router.post("/gmail-inbound/registered/:key/status", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "GMAIL_INBOUND_FORBIDDEN" });
      }
      if (!intake) return response.status(409).json({ error: "Gmail受信取込の登録は無効です", code: "GMAIL_INBOUND_INTAKE_DISABLED" });
      const key = String(request.params.key).slice(0, 64);
      const { status } = statusBody.parse(request.body);
      const record = await intake.updateStatus(key, status);
      if (!record) return response.status(404).json({ error: "取込レコードが見つかりません", code: "GMAIL_INBOUND_RECORD_NOT_FOUND" });
      return response.status(200).json({ record });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
