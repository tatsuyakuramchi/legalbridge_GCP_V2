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
import {
  CloudSignError, isValidEmail, findDisallowedRecipient, cloudSignConsoleUrl
} from "../integrations/cloudsign-adapter.js";
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
const ccSchema = z.object({
  email: z.string().trim().min(1).max(255),
  name: z.string().trim().max(200).optional()
});
const bodySchema = z.object({
  participants: z.array(participantSchema).min(1, "署名者が必要です").max(20),
  // CC（CloudSign の共有先＝reportees・任意）。
  cc: z.array(ccSchema).max(20).optional().default([]),
  // true=即時送信。false/未指定=下書きで作成（CloudSign 画面で印影配置後に送信する運用・既定）。
  sendNow: z.boolean().optional().default(false),
  // 同じ案件の他の確定文書を同一 CloudSign 書類に添付する（一括依頼・V1 相当）。
  attachDocumentIds: z.array(z.coerce.number().int().positive()).max(10).optional().default([])
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
    // CloudSign コンソールURL導出用の API ベースURL（連携設定のランタイム反映のため関数も可）。
    consoleBaseUrl?: string | (() => string);
  } = {}
) {
  const router = Router();
  const allowedRecipientsOption = options.allowedRecipients;
  const allowedRecipients = () =>
    typeof allowedRecipientsOption === "function"
      ? allowedRecipientsOption()
      : allowedRecipientsOption ?? new Set<string>();
  const requestHistory = options.requestHistory;
  const consoleUrl = (cloudSignDocumentId: string) => cloudSignConsoleUrl(
    (typeof options.consoleBaseUrl === "function" ? options.consoleBaseUrl() : options.consoleBaseUrl)
      ?? "https://api.cloudsign.jp",
    cloudSignDocumentId
  );

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
      const { participants, cc, sendNow, attachDocumentIds } = bodySchema.parse(request.body);
      if (!participants.every((participant) => isValidEmail(participant.email))) {
        return response.status(400).json({ error: "署名者のメールアドレスが不正です", code: "CLOUDSIGN_PARTICIPANT_INVALID" });
      }
      if (!cc.every((entry) => isValidEmail(entry.email))) {
        return response.status(400).json({ error: "CCのメールアドレスが不正です", code: "CLOUDSIGN_CC_INVALID" });
      }
      // 宛先allowlist（設定時のみ）：検証中の誤送信防止。CC 含む全宛先が許可集合内であること。
      const disallowed = findDisallowedRecipient(
        [...participants.map((p) => p.email), ...cc.map((c) => c.email)], allowedRecipients());
      if (disallowed) {
        return response.status(422).json({
          error: `許可されていない宛先です: ${disallowed}`, code: "CLOUDSIGN_RECIPIENT_NOT_ALLOWED"
        });
      }
      const document = await documents.find(id);
      if (!document) return response.status(404).json({ error: "文書が見つかりません", code: "CLOUDSIGN_DOCUMENT_NOT_FOUND" });
      // 一括依頼：添付は同じ案件に紐付く確定文書のみ許可（誤添付防止）。
      const attachIds = [...new Set(attachDocumentIds)].filter((docId) => docId !== id);
      const attachedDocuments: RegisteredDocument[] = [];
      for (const attachId of attachIds) {
        const attached = await documents.find(attachId);
        if (!attached) {
          return response.status(404).json({ error: `添付文書が見つかりません（ID: ${attachId}）`, code: "CLOUDSIGN_ATTACH_NOT_FOUND" });
        }
        if (document.matterId == null || attached.matterId !== document.matterId) {
          return response.status(422).json({
            error: `添付できるのは同じ案件の文書のみです（${attached.documentNumber ?? attachId}）`,
            code: "CLOUDSIGN_ATTACH_DIFFERENT_MATTER"
          });
        }
        attachedDocuments.push(attached);
      }
      const title = documentTitle(document);
      const gate = evaluateCloudSignDispatchGate({ documentTitle: title, participants }, gateSettings);
      if (!gate.dispatchAllowed) {
        return response.status(409).json({ error: "依頼条件が整っていません", code: "CLOUDSIGN_DISPATCH_BLOCKED", blockers: gate.blockerLabels });
      }
      // 添付構成が違えば別依頼として扱う（単独依頼の既存キーとは互換維持のため、束ねのときのみ拡張）。
      const idempotencyKey = createHash("sha256")
        .update(`cloudsign:${document.id}:${document.documentNumber ?? document.issueKey}` +
          (attachedDocuments.length ? `:bundle:${[...attachIds].sort((a, b) => a - b).join("-")}` : ""))
        .digest("hex");
      // 冪等強制：履歴が有効なら、同一文書の既依頼は再送せず既存受領を返す。
      if (requestHistory) {
        const prior = await requestHistory.findByKey(idempotencyKey);
        if (prior) {
          return response.status(200).json({
            receipt: { cloudSignDocumentId: prior.cloudSignDocumentId, status: prior.status, participantIds: [] },
            cloudSignUrl: consoleUrl(prior.cloudSignDocumentId),
            integrations: { cloudsign: "duplicate" }
          });
        }
      }
      const html = await renderStoredDocumentHtml(templates, document);
      if (!html) return response.status(404).json({ error: "テンプレートが見つかりません", code: "CLOUDSIGN_TEMPLATE_NOT_FOUND" });
      const pdf = await pdfRenderer.render(html);
      const extraFiles: Array<{ filename: string; pdf: Buffer }> = [];
      for (const attached of attachedDocuments) {
        const attachedHtml = await renderStoredDocumentHtml(templates, attached);
        if (!attachedHtml) {
          return response.status(404).json({
            error: `添付文書のテンプレートが見つかりません（${attached.documentNumber ?? attached.id}）`,
            code: "CLOUDSIGN_ATTACH_TEMPLATE_NOT_FOUND"
          });
        }
        extraFiles.push({
          filename: `${safeFilename(attached.documentNumber ?? `document-${attached.id}`)}.pdf`,
          pdf: await pdfRenderer.render(attachedHtml)
        });
      }
      const receipt = await cloudSign.requestSignature({
        documentTitle: title, note: `案件：${document.issueKey}`,
        filename: `${safeFilename(document.documentNumber ?? `document-${id}`)}.pdf`,
        pdf, extraFiles, participants, cc, sendNow, idempotencyKey
      });
      if (requestHistory) {
        await requestHistory.record({
          idempotencyKey, documentId: document.id,
          cloudSignDocumentId: receipt.cloudSignDocumentId, status: receipt.status,
          participantCount: participants.length,
          recordedBy: response.locals.currentUser?.email ?? "unknown"
        });
        // 添付文書にも同じ依頼を記録（各文書の履歴パネルに表示されるように・キーは文書別に派生）。
        for (const attached of attachedDocuments) {
          await requestHistory.record({
            idempotencyKey: createHash("sha256").update(`${idempotencyKey}:attached:${attached.id}`).digest("hex"),
            documentId: attached.id,
            cloudSignDocumentId: receipt.cloudSignDocumentId, status: receipt.status,
            participantCount: participants.length,
            recordedBy: response.locals.currentUser?.email ?? "unknown"
          }).catch(() => { /* 派生記録の失敗は依頼成立を妨げない */ });
        }
      }
      if (options.matterSends && document.matterId != null) {
        try {
          for (const target of [document, ...attachedDocuments]) {
            await options.matterSends.record(document.matterId, {
              documentId: target.id, channel: "cloudsign",
              recipient: participants.map((p) => p.email).join(", "),
              // 下書き作成は queued＝送信待ち（CloudSign 画面から送信した時点で webhook/sync が反映）。
              status: sendNow ? "sent" : "queued", subject: title,
              messageId: receipt.cloudSignDocumentId,
              sentBy: response.locals.currentUser?.email ?? null
            });
          }
        } catch { /* 台帳未整備でも依頼は成立している */ }
      }
      return response.status(201).json({
        receipt,
        cloudSignUrl: consoleUrl(receipt.cloudSignDocumentId),
        attachedCount: attachedDocuments.length,
        integrations: { cloudsign: sendNow ? "requested" : "drafted" }
      });
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
