import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DocumentRegistryRepository, RegisteredDocument } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import {
  renderStoredDocumentHtml, StoredDocumentTemplateVersionError
} from "./document-html-renderer.js";
import type { CloudSignAdapter } from "../integrations/cloudsign-adapter.js";
import { CloudSignError, isValidEmail, findDisallowedRecipient } from "../integrations/cloudsign-adapter.js";
import {
  evaluateCloudSignDispatchGate, type CloudSignDispatchGateSettings
} from "../integrations/cloudsign-dispatch-gate.js";
import type { CloudSignRequestRepository } from "../integrations/cloudsign-request-repository.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });
const participantSchema = z.object({
  email: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(200),
  organization: z.string().trim().max(200).optional()
});
const bodySchema = z.object({
  participants: z.array(participantSchema).min(1, "署名者が必要です").max(20)
});

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

export function documentTitle(document: RegisteredDocument) {
  return `${document.title}（${document.documentNumber ?? document.issueKey}）`;
}
function safeFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
}

export function createCloudSignRouter(
  documents: DocumentRegistryRepository | undefined,
  templates: TemplateRepository,
  pdfRenderer: PdfRenderer,
  cloudSign: CloudSignAdapter | undefined,
  gateSettings: CloudSignDispatchGateSettings,
  options: {
    // 静的 Set か、呼び出し時解決のプロバイダ（連携設定のランタイム反映）。
    allowedRecipients?: Set<string> | (() => Set<string>);
    requestHistory?: CloudSignRequestRepository;
    // 案件の送信履歴への自動記録（W3・文書に matter_id がある場合のみ）。
    matterSends?: import("../matters/matter-send-repository.js").MatterSendRepository;
  } = {}
) {
  const router = Router();
  const allowedRecipientsOption = options.allowedRecipients;
  const allowedRecipients = () =>
    typeof allowedRecipientsOption === "function"
      ? allowedRecipientsOption()
      : allowedRecipientsOption ?? new Set<string>();
  const requestHistory = options.requestHistory;

  // 依頼前プレビュー（送信しない）。署名者とゲートのブロック理由を返す。
  router.post("/documents/:id/cloudsign/preview", async (request, response, next) => {
    try {
      if (!documents) return response.status(503).json({ error: "document registry unavailable", code: "CLOUDSIGN_REGISTRY_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "CLOUDSIGN_FORBIDDEN" });
      }
      const { id } = idPath.parse(request.params);
      const { participants } = bodySchema.parse(request.body);
      const document = await documents.find(id);
      if (!document) return response.status(404).json({ error: "文書が見つかりません", code: "CLOUDSIGN_DOCUMENT_NOT_FOUND" });
      const gate = evaluateCloudSignDispatchGate({ documentTitle: documentTitle(document), participants }, gateSettings);
      return response.status(200).json({
        preview: { documentTitle: documentTitle(document), participants }, gate
      });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 電子署名依頼の実発火（管理者のみ）。ミドルウェアで cloudsign スコープ
  // 有効時のみ到達する。文書PDFはDrive連携と同じ描画パイプラインで生成する。
  router.post("/documents/:id/cloudsign/dispatch", async (request, response, next) => {
    try {
      if (!documents || !cloudSign) return response.status(503).json({ error: "cloudsign unavailable", code: "CLOUDSIGN_UNAVAILABLE" });
      if (response.locals.currentUser?.role !== "admin") {
        return response.status(403).json({ error: "管理者のみが依頼できます", code: "CLOUDSIGN_ADMIN_REQUIRED" });
      }
      const { id } = idPath.parse(request.params);
      const { participants } = bodySchema.parse(request.body);
      if (!participants.every((participant) => isValidEmail(participant.email))) {
        return response.status(400).json({ error: "署名者のメールアドレスが不正です", code: "CLOUDSIGN_PARTICIPANT_INVALID" });
      }
      // 宛先allowlist（設定時のみ）：検証中の誤送信防止。全宛先が許可集合内であること。
      const disallowed = findDisallowedRecipient(participants.map((p) => p.email), allowedRecipients());
      if (disallowed) {
        return response.status(422).json({
          error: `許可されていない宛先です: ${disallowed}`, code: "CLOUDSIGN_RECIPIENT_NOT_ALLOWED"
        });
      }
      const document = await documents.find(id);
      if (!document) return response.status(404).json({ error: "文書が見つかりません", code: "CLOUDSIGN_DOCUMENT_NOT_FOUND" });
      const title = documentTitle(document);
      const gate = evaluateCloudSignDispatchGate({ documentTitle: title, participants }, gateSettings);
      if (!gate.dispatchAllowed) {
        return response.status(409).json({ error: "依頼条件が整っていません", code: "CLOUDSIGN_DISPATCH_BLOCKED", blockers: gate.blockerLabels });
      }
      const idempotencyKey = createHash("sha256")
        .update(`cloudsign:${document.id}:${document.documentNumber ?? document.issueKey}`)
        .digest("hex");
      // 冪等強制：履歴が有効なら、同一文書の既依頼は再送せず既存受領を返す。
      if (requestHistory) {
        const prior = await requestHistory.findByKey(idempotencyKey);
        if (prior) {
          return response.status(200).json({
            receipt: { cloudSignDocumentId: prior.cloudSignDocumentId, status: prior.status, participantIds: [] },
            integrations: { cloudsign: "duplicate" }
          });
        }
      }
      const html = await renderStoredDocumentHtml(templates, document);
      if (!html) return response.status(404).json({ error: "テンプレートが見つかりません", code: "CLOUDSIGN_TEMPLATE_NOT_FOUND" });
      const pdf = await pdfRenderer.render(html);
      const receipt = await cloudSign.requestSignature({
        documentTitle: title, note: `案件：${document.issueKey}`,
        filename: `${safeFilename(document.documentNumber ?? `document-${id}`)}.pdf`,
        pdf, participants, idempotencyKey
      });
      if (requestHistory) {
        await requestHistory.record({
          idempotencyKey, documentId: document.id,
          cloudSignDocumentId: receipt.cloudSignDocumentId, status: receipt.status,
          participantCount: participants.length,
          recordedBy: response.locals.currentUser?.email ?? "unknown"
        });
      }
      if (options.matterSends && document.matterId != null) {
        try {
          await options.matterSends.record(document.matterId, {
            documentId: document.id, channel: "cloudsign",
            recipient: participants.map((p) => p.email).join(", "),
            status: "sent", subject: title,
            messageId: receipt.cloudSignDocumentId,
            sentBy: response.locals.currentUser?.email ?? null
          });
        } catch { /* 台帳未整備でも依頼は成立している */ }
      }
      return response.status(201).json({ receipt, integrations: { cloudsign: "requested" } });
    } catch (error) {
      if (error instanceof StoredDocumentTemplateVersionError) {
        return response.status(409).json({ error: error.message, code: "CLOUDSIGN_TEMPLATE_VERSION_MISMATCH" });
      }
      if (error instanceof CloudSignError) {
        // CloudSign API 側の失敗（認証・接続・4xx/5xx）。素の500ではなく理由を返す。
        return response.status(502).json({
          error: `CloudSign連携エラー: ${error.message}（クライアントID・宛先・CloudSign側の設定を確認してください）`,
          code: `CLOUDSIGN_API_${String(error.code ?? "error").toUpperCase()}`
        });
      }
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 署名ステータス取込（read）。ライブ未設定なら live=false で返す（テーブル変更なし・表示のみ）。
  router.get("/cloudsign/:cloudSignDocumentId/status", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "CLOUDSIGN_FORBIDDEN" });
      }
      if (!cloudSign || !cloudSign.configured) {
        return response.status(200).json({ live: false, status: null });
      }
      const cloudSignDocumentId = String(request.params.cloudSignDocumentId).slice(0, 200);
      const status = await cloudSign.fetchStatus(cloudSignDocumentId);
      // 履歴が有効なら締結状況を反映（存在しない ID は no-op）。
      if (requestHistory) await requestHistory.updateStatus(cloudSignDocumentId, status.status);
      return response.status(200).json({ live: true, status });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
