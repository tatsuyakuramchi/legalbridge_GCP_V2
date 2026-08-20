import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DocumentRegistryRepository, RegisteredDocument } from "./registry-repository.js";
import type { GmailDeliveryAdapter, GmailAttachment } from "../integrations/gmail-delivery-adapter.js";
import { isValidEmail, parseRecipientList } from "../integrations/gmail-delivery-adapter.js";
import {
  evaluateGmailDispatchGate, type GmailDispatchGateSettings
} from "../integrations/gmail-dispatch-gate.js";
import type { GmailSendHistoryRepository } from "../integrations/gmail-send-history-repository.js";
import type { MatterSendRepository } from "../matters/matter-send-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import type { DriveStorage } from "./drive-storage.js";
import { resolveCloudSignSourcePdf, looksLikePdf } from "./cloudsign-source-pdf.js";
import { driveFileIdFromLink } from "./drive-storage.js";

import { DEFAULT_COMPANY_PROFILE, type CompanyProfile } from "../settings/company-profile.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });
const bodySchema = z.object({
  to: z.string().trim().min(1, "宛先が必要です").max(500),
  cc: z.string().trim().max(500).optional().default(""),
  // PDF添付（V1同等）。既定ON・失敗したらリンクのみで送る（best-effort）。
  attachPdf: z.boolean().optional().default(true)
});

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

// 金額（V1と同じ優先順位）。整形済み（…Str）を優先し、生値しか無ければ桁区切りに整形する。
function amountOf(formData: Record<string, unknown>): string {
  const raw = formData.grandTotalPayableStr ?? formData.totalPaymentStr ?? formData.totalAmountStr
    ?? formData.grandTotalPayable ?? formData.totalAmount ?? formData.GRAND_TOTAL ?? formData.TOTAL_AMOUNT ?? "";
  const text = String(raw).trim();
  if (!text) return "";
  const numeric = Number(text);
  return Number.isFinite(numeric) ? `¥${numeric.toLocaleString("ja-JP")}` : text;
}

type MailKind = "inspection" | "royalty" | "general";
function mailKindOf(templateType: string): MailKind {
  if (templateType === "inspection_certificate" || templateType.startsWith("inspection")) return "inspection";
  if (templateType === "royalty_statement" || templateType.includes("license_calculation")) return "royalty";
  return "general";
}

// 文書送付メールの件名/本文（V1の既定テンプレートを移植）。検収書・利用許諾料
// 計算書は専用文面、その他の文書は「書類のご送付＋内容ご確認のお願い」の汎用文面。
// 会社名・住所は会社プロフィール設定（app_settings・未整備なら既定へ縮退）から差し込む。
export function buildFinalizeNotification(
  document: RegisteredDocument,
  to: string,
  options: { cc?: string; attached?: boolean; company?: CompanyProfile } = {}
) {
  const label = document.documentNumber ?? document.issueKey;
  const company = options.company ?? DEFAULT_COMPANY_PROFILE;
  const kind = mailKindOf(document.templateType);
  const amount = amountOf(document.formData ?? {});
  const issuedOn = new Date().toLocaleDateString("ja-JP");
  const delivery = options.attached ? "添付のとおり" : "下記URLのとおり";
  const subject = `【${company.name}】${
    kind === "inspection" ? "検収書のご送付" : kind === "royalty" ? "利用許諾料計算書のご送付" : "書類のご送付"
  }（${label}）`;
  const signature = [
    "──────────────────────",
    company.name,
    company.address,
    ...(company.tel ? [`TEL：${company.tel}`] : []),
    "──────────────────────"
  ];
  const opening = kind === "royalty"
    ? ["いつも大変お世話になっております。", `${company.name}でございます。`]
    : ["いつもお世話になっております。", `${company.name}でございます。`];
  const lead = kind === "inspection"
    ? ["このたび納品いただきました内容につきまして検収が完了いたしましたので、", `検収書を${delivery}お送りいたします。`]
    : kind === "royalty"
      ? ["このたび、利用許諾契約に基づく利用許諾料が確定いたしましたので、", `利用許諾料計算書を${delivery}お送りいたします。`]
      : [`書類（${document.title}）を${delivery}お送りいたします。`];
  const facts = [
    `■ 文書番号：${label}`,
    ...(kind === "inspection" && amount ? [`■ 検収金額：${amount}`] : []),
    ...(kind === "royalty" && amount ? [`■ 利用許諾料額：${amount}`] : []),
    `■ 発行日　：${issuedOn}`
  ];
  const closing = kind === "royalty"
    ? [
      "計算の内訳につきましては、計算書をご確認ください。",
      "お支払いは、契約に定める支払条件に基づきお手続きいたします。",
      "",
      "なお、計算内容にご不明な点や相違等がございましたら、",
      "お手数ですが本メールへご返信のうえお知らせくださいますよう",
      "お願い申し上げます。",
      "",
      "引き続きどうぞよろしくお願い申し上げます。"
    ]
    : [
      "内容をご確認のうえ、相違等がございましたら、お手数ですが",
      "本メールへのご返信にてご連絡ください。",
      ...(kind === "inspection" ? ["お支払いは、契約に定める支払条件に基づきお手続きいたします。"] : []),
      "",
      "今後ともどうぞよろしくお願い申し上げます。"
    ];
  const lines = [
    `${document.counterparty || "ご担当者"} 御中`,
    "",
    ...opening,
    "",
    ...lead,
    "",
    ...facts,
    ...(document.driveLink ? ["", `文書URL：${document.driveLink}`] : []),
    "",
    ...closing,
    "",
    ...signature
  ];
  const bodyText = lines.join("\n");
  // 冪等キー: 宛先集合を正規化（小文字化・整列）して指紋を取る。単一宛先なら
  // 従来のキーと一致する＝過去の送信履歴と互換。CC・添付有無はキーに含めない
  // （同じ文書×同じ宛先はCCだけ変えても再送しない。再送したければ宛先を変える）。
  const normalizedTo = parseRecipientList(to).map((email) => email.toLowerCase()).sort().join(",");
  const idempotencyKey = createHash("sha256")
    .update(`gmail:${document.id}:${document.documentNumber ?? document.issueKey}:${normalizedTo}`)
    .digest("hex");
  return { to: parseRecipientList(to).join(", "), cc: parseRecipientList(options.cc ?? "").join(", "), subject, bodyText, idempotencyKey };
}

// PDF添付に使う描画依存（CloudSign送信と同じ調達経路を再利用する）＋文面の会社差込。
export interface GmailAttachmentDeps {
  templates?: TemplateRepository;
  pdfRenderer?: PdfRenderer;
  driveStorage?: DriveStorage;
  companyProfile?: () => Promise<CompanyProfile>;
}

export function createGmailNotificationRouter(
  documents: DocumentRegistryRepository | undefined,
  gmail: GmailDeliveryAdapter | undefined,
  gateSettings: GmailDispatchGateSettings,
  sendHistory?: GmailSendHistoryRepository,
  matterSends?: MatterSendRepository,
  attachmentDeps: GmailAttachmentDeps = {}
) {
  const router = Router();

  // 添付できる見込みがあるか（プレビュー用・実描画はしない）。
  //   テンプレートがある文書 → 描画パイプラインでPDF化できる。
  //   テンプレートが無い文書（案件添付） → Drive の実体が PDF ならそのまま添付できる。
  async function planAttachment(document: RegisteredDocument): Promise<{ planned: boolean; note: string }> {
    if (!attachmentDeps.pdfRenderer || !attachmentDeps.templates) {
      return { planned: false, note: "PDF添付は未設定です（リンクのみで送信します）" };
    }
    try {
      const template = await attachmentDeps.templates.findRenderSource(document.templateType);
      if (template) return { planned: true, note: `${document.documentNumber ?? document.issueKey}.pdf を添付します` };
    } catch { /* 判定できなければ Drive 側の判定へ */ }
    if (attachmentDeps.driveStorage?.downloadFile && driveFileIdFromLink(document.driveLink) && looksLikePdf(document)) {
      return { planned: true, note: "Drive上のPDFをそのまま添付します" };
    }
    return { planned: false, note: "この文書はPDF添付できません（リンクのみで送信します）" };
  }

  async function load(id: number, to: string, cc: string, attachPdf: boolean) {
    const document = await documents!.find(id);
    if (!document) return null;
    const attachment = attachPdf
      ? await planAttachment(document)
      : { planned: false, note: "添付なし（リンクのみ）を選択中" };
    let company = DEFAULT_COMPANY_PROFILE;
    try {
      company = attachmentDeps.companyProfile ? await attachmentDeps.companyProfile() : DEFAULT_COMPANY_PROFILE;
    } catch { /* 設定未整備は既定の会社情報で送る */ }
    const content = buildFinalizeNotification(document, to, { cc, attached: attachment.planned, company });
    let gate = evaluateGmailDispatchGate(
      { to: content.to, subject: content.subject, bodyText: content.bodyText },
      gateSettings
    );
    // CC も宛先と同じ基準で検査する（不正CCで Gmail API がまるごと失敗するのを防ぐ）。
    const ccList = parseRecipientList(cc);
    if (ccList.some((email) => !isValidEmail(email))) {
      gate = { ...gate, dispatchAllowed: false, blockerLabels: [...gate.blockerLabels, "CCのメールアドレスが不正です"] };
    }
    // 文書リンクなしの通知を送れてしまう問題（監査W3 A2.9）：Drive 保存前は本文に
    // 文書URLが入らない。ただし PDF を添付するなら受け手は文書を読めるので許可する。
    if (!document.driveLink && !attachment.planned) {
      gate = {
        ...gate,
        dispatchAllowed: false,
        blockerLabels: [...gate.blockerLabels, "文書がまだDriveに保存されていません（先に「Driveへ保存」を実行するか、PDF添付を有効にしてください）"]
      };
    }
    return { document, content, gate, attachment, company };
  }

  // 送信前プレビュー（送信しない）。ゲートのブロック理由と添付の見込みも返す。
  router.post("/documents/:id/gmail-notification/preview", async (request, response, next) => {
    try {
      if (!documents) return response.status(503).json({ error: "document registry unavailable", code: "GMAIL_REGISTRY_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "GMAIL_FORBIDDEN" });
      }
      const { id } = idPath.parse(request.params);
      const { to, cc, attachPdf } = bodySchema.parse(request.body);
      const loaded = await load(id, to, cc, attachPdf);
      if (!loaded) return response.status(404).json({ error: "文書が見つかりません", code: "GMAIL_DOCUMENT_NOT_FOUND" });
      return response.status(200).json({
        preview: { to: loaded.content.to, cc: loaded.content.cc, subject: loaded.content.subject, bodyText: loaded.content.bodyText },
        gate: loaded.gate,
        attachment: loaded.attachment
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
      const { to, cc, attachPdf } = bodySchema.parse(request.body);
      const recipients = parseRecipientList(to);
      if (!recipients.length || recipients.some((email) => !isValidEmail(email))) {
        return response.status(400).json({ error: "宛先メールアドレスが不正です", code: "GMAIL_RECIPIENT_INVALID" });
      }
      if (parseRecipientList(cc).some((email) => !isValidEmail(email))) {
        return response.status(400).json({ error: "CCのメールアドレスが不正です", code: "GMAIL_RECIPIENT_INVALID" });
      }
      const loaded = await load(id, to, cc, attachPdf);
      if (!loaded) return response.status(404).json({ error: "文書が見つかりません", code: "GMAIL_DOCUMENT_NOT_FOUND" });
      if (!loaded.gate.dispatchAllowed) {
        return response.status(409).json({
          error: "送信条件が整っていません", code: "GMAIL_DISPATCH_BLOCKED", blockers: loaded.gate.blockerLabels
        });
      }
      // 冪等強制：送信履歴が有効なら、同一指紋の既送信は再送せず受領情報を返す。
      // PDF描画（Chromium）より先に判定して、重複時の無駄な描画を避ける。
      if (sendHistory) {
        const prior = await sendHistory.findByKey(loaded.content.idempotencyKey);
        if (prior) {
          return response.status(200).json({
            receipt: { messageId: prior.messageId, threadId: prior.threadId },
            integrations: { gmail: "duplicate" }
          });
        }
      }
      // PDF添付（best-effort・V1同等）。失敗しても送信は止めない＝リンクのみで送る。
      // ただし添付前提で Drive リンク無しを許可していた場合は、添付できなければ止める。
      let attachments: GmailAttachment[] = [];
      let attached = false;
      let attachmentError: string | null = null;
      if (loaded.attachment.planned && attachmentDeps.templates && attachmentDeps.pdfRenderer) {
        try {
          const source = await resolveCloudSignSourcePdf(loaded.document, {
            templates: attachmentDeps.templates,
            pdfRenderer: attachmentDeps.pdfRenderer,
            driveStorage: attachmentDeps.driveStorage
          });
          attachments = [{
            filename: `${loaded.document.documentNumber ?? loaded.document.issueKey}.pdf`,
            content: source.pdf,
            mimeType: "application/pdf"
          }];
          attached = true;
        } catch (error) {
          attachmentError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!attached && !loaded.document.driveLink) {
        return response.status(409).json({
          error: "PDF添付に失敗し、Driveリンクも無いため文書を届けられません",
          code: "GMAIL_DISPATCH_BLOCKED",
          blockers: [attachmentError ?? "PDFを生成できませんでした"]
        });
      }
      // 本文は実際の添付結果で組み直す（「添付のとおり」と書いて添付が無い事故を防ぐ）。
      const content = buildFinalizeNotification(loaded.document, to, { cc, attached, company: loaded.company });
      const receipt = await gmail.send({
        to: content.to, cc: content.cc || undefined,
        subject: content.subject, bodyText: content.bodyText,
        fromEmail: gateSettings.senderEmail, fromName: "LegalBridge",
        idempotencyKey: content.idempotencyKey,
        ...(attachments.length ? { attachments } : {})
      });
      if (sendHistory) {
        await sendHistory.record({
          idempotencyKey: content.idempotencyKey,
          documentId: loaded.document.id,
          recipient: content.to,
          messageId: receipt.messageId,
          threadId: receipt.threadId,
          recordedBy: response.locals.currentUser?.email ?? "unknown"
        });
      }
      // 案件の送信履歴へ自動記録（手動での二重記帳を廃止・監査W3 A3.7）。失敗しても送信自体は成功扱い。
      if (matterSends && loaded.document.matterId != null) {
        try {
          await matterSends.record(loaded.document.matterId, {
            documentId: loaded.document.id, channel: "email", recipient: content.to,
            status: "sent", subject: content.subject,
            messageId: receipt.messageId, sentBy: response.locals.currentUser?.email ?? null
          });
        } catch { /* 台帳未整備でも送信は成立している */ }
      }
      return response.status(201).json({
        receipt,
        integrations: { gmail: "sent" },
        attached,
        ...(attachmentError ? { attachmentNote: `PDF添付に失敗したためリンクのみで送信しました：${attachmentError}` } : {})
      });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
