import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createGmailNotificationRouter, buildFinalizeNotification, type GmailAttachmentDeps } from "./gmail-notification-routes.js";
import { MemoryDocumentRegistryRepository, type RegisteredDocument } from "./registry-repository.js";
import type { GmailDeliveryAdapter, GmailDeliveryRequest } from "../integrations/gmail-delivery-adapter.js";
import { MemoryGmailSendHistoryRepository } from "../integrations/gmail-send-history-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";

const doc: RegisteredDocument = {
  id: 7, documentNumber: "DOC-2026-0007", issueKey: "LB-7", templateType: "license",
  templateVersionId: 1, title: "英語版ライセンス契約", counterparty: "株式会社サンプル",
  driveLink: "https://drive.google.com/file/d/x/view", createdAt: "2026-08-04T00:00:00.000Z",
  createdBy: "legal@arclight.co.jp", formData: {}
};

const inspectionDoc: RegisteredDocument = {
  ...doc, id: 8, documentNumber: "ARC-AC-2026-0008", templateType: "inspection_certificate",
  title: "検収書"
};

class CapturingGmailAdapter implements GmailDeliveryAdapter {
  readonly configured = true;
  sent: GmailDeliveryRequest | null = null;
  sendCount = 0;
  async send(req: GmailDeliveryRequest) { this.sent = req; this.sendCount += 1; return { messageId: "m1", threadId: "t1" }; }
}

// 版ズレ例外を避けるため templateVersionId は文書側(1)と一致させる。
const templatesStub = {
  async findRenderSource() { return { templateVersionId: 1, htmlSource: "<h1>{{TITLE}}</h1>" }; },
  async findPartials() { return {}; },
  async findCurrent() { return { templateKey: "license", label: "license", templateVersionId: 1, fields: [] }; }
} as unknown as TemplateRepository;
const pdfRenderer: PdfRenderer = { async render() { return Buffer.from("%PDF-1.4 test"); } };

function appFor(options: {
  role?: "admin" | "legal" | "requester"; live?: boolean; adapter?: GmailDeliveryAdapter;
  history?: MemoryGmailSendHistoryRepository; attachmentDeps?: GmailAttachmentDeps;
}) {
  const registry = new MemoryDocumentRegistryRepository([doc, inspectionDoc]);
  const adapter = options.adapter ?? new CapturingGmailAdapter();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createGmailNotificationRouter(registry, adapter, {
    integrationMode: options.live ? "live" : "local",
    gmailCapabilityEnabled: options.live ?? false,
    adapterConfigured: adapter.configured,
    senderEmail: "legal@arclight.co.jp"
  }, options.history, undefined, options.attachmentDeps ?? {}));
  return { app, adapter };
}

test("汎用文書は「書類のご送付」文面（確認のお願い＋会社署名）になる", () => {
  const content = buildFinalizeNotification(doc, "to@example.com");
  assert.match(content.subject, /^【株式会社アークライト】書類のご送付（DOC-2026-0007）$/);
  assert.match(content.bodyText, /株式会社サンプル 御中/);
  assert.match(content.bodyText, /内容をご確認のうえ、相違等がございましたら/);
  assert.match(content.bodyText, /株式会社アークライト/);
  assert.match(content.idempotencyKey, /^[a-f0-9]{64}$/);
});

test("検収書は「検収書のご送付」文面になり、添付ありは「添付のとおり」と書く", () => {
  const content = buildFinalizeNotification(
    { ...inspectionDoc, formData: { grandTotalPayableStr: "¥110,000" } },
    "to@example.com", { attached: true }
  );
  assert.match(content.subject, /検収書のご送付（ARC-AC-2026-0008）/);
  assert.match(content.bodyText, /検収が完了いたしましたので/);
  assert.match(content.bodyText, /検収書を添付のとおりお送りいたします/);
  assert.match(content.bodyText, /■ 検収金額：¥110,000/);
});

test("利用許諾料計算書は専用文面＋利用許諾料額（生値は桁区切りへ整形）", () => {
  const royaltyDoc: RegisteredDocument = { ...doc, id: 9, templateType: "royalty_statement", formData: { totalPayment: 0, totalAmount: 123456 } };
  const content = buildFinalizeNotification(royaltyDoc, "to@example.com", { attached: true });
  assert.match(content.subject, /利用許諾料計算書のご送付/);
  assert.match(content.bodyText, /利用許諾料が確定いたしましたので/);
  assert.match(content.bodyText, /■ 利用許諾料額：¥123,456/);
});

test("会社プロフィールを渡すと件名・署名に反映される", () => {
  const content = buildFinalizeNotification(doc, "to@example.com", {
    company: {
      name: "テスト商事株式会社", nameKana: "", postalCode: "", address: "東京都テスト区1-2-3",
      tel: "03-0000-0000", fax: "", rep: "", invoiceNo: "", bankInfo: "", sealNote: ""
    }
  });
  assert.match(content.subject, /^【テスト商事株式会社】/);
  assert.match(content.bodyText, /東京都テスト区1-2-3/);
  assert.match(content.bodyText, /TEL：03-0000-0000/);
});

test("冪等キーは宛先の順序・大文字小文字に依存しない（単一宛先は従来と互換）", () => {
  const single = buildFinalizeNotification(doc, "to@example.com");
  const singleUpper = buildFinalizeNotification(doc, "TO@example.com ");
  assert.equal(single.idempotencyKey, singleUpper.idempotencyKey);
  const pair = buildFinalizeNotification(doc, "a@example.com, b@example.com");
  const pairReversed = buildFinalizeNotification(doc, "b@example.com,a@example.com");
  assert.equal(pair.idempotencyKey, pairReversed.idempotencyKey);
  assert.notEqual(single.idempotencyKey, pair.idempotencyKey);
});

test("プレビューはローカルでも本文とブロック理由を返す", async () => {
  const { app } = appFor({ live: false });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/preview").send({ to: "to@example.com" });
  assert.equal(response.status, 200);
  assert.match(response.body.preview.subject, /書類のご送付/);
  assert.equal(response.body.gate.dispatchAllowed, false);
  assert.ok(response.body.gate.blockerLabels.length > 0);
  // 添付の見込みも返す（描画依存が無いので planned=false）。
  assert.equal(response.body.attachment.planned, false);
});

test("依頼者ロールはプレビューできない", async () => {
  const { app } = appFor({ role: "requester" });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/preview").send({ to: "to@example.com" });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "GMAIL_FORBIDDEN");
});

test("ローカルモードでは実送信を409でブロックする", async () => {
  const { app, adapter } = appFor({ live: false });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/dispatch").send({ to: "to@example.com" });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "GMAIL_DISPATCH_BLOCKED");
  assert.equal((adapter as CapturingGmailAdapter).sent, null);
});

test("ライブモードかつ管理者は実送信し受領を返す", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/dispatch").send({ to: "to@example.com" });
  assert.equal(response.status, 201);
  assert.equal(response.body.receipt.messageId, "m1");
  assert.notEqual((adapter as CapturingGmailAdapter).sent, null);
});

test("複数宛先（カンマ区切り）とCCがアダプタへそのまま渡る", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/dispatch")
    .send({ to: "a@example.com, b@example.com", cc: "cc@example.com" });
  assert.equal(response.status, 201);
  const sent = (adapter as CapturingGmailAdapter).sent!;
  assert.equal(sent.to, "a@example.com, b@example.com");
  assert.equal(sent.cc, "cc@example.com");
});

test("不正なCCは400で止める", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/dispatch")
    .send({ to: "a@example.com", cc: "not-an-email" });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "GMAIL_RECIPIENT_INVALID");
  assert.equal((adapter as CapturingGmailAdapter).sent, null);
});

test("attachPdf=true でテンプレート文書はPDFを添付して送る", async () => {
  const { app, adapter } = appFor({
    live: true, role: "admin",
    attachmentDeps: { templates: templatesStub, pdfRenderer }
  });
  const response = await request(app).post("/api/v2/documents/8/gmail-notification/dispatch")
    .send({ to: "to@example.com", attachPdf: true });
  assert.equal(response.status, 201);
  assert.equal(response.body.attached, true);
  const sent = (adapter as CapturingGmailAdapter).sent!;
  assert.equal(sent.attachments?.length, 1);
  assert.equal(sent.attachments?.[0].filename, "ARC-AC-2026-0008.pdf");
  assert.equal(sent.attachments?.[0].mimeType, "application/pdf");
  assert.match(sent.bodyText, /添付のとおり/);
});

test("PDF生成に失敗してもDriveリンクがあればリンクのみで送る（best-effort）", async () => {
  const failingRenderer: PdfRenderer = { async render() { throw new Error("chromium down"); } };
  const { app, adapter } = appFor({
    live: true, role: "admin",
    attachmentDeps: { templates: templatesStub, pdfRenderer: failingRenderer }
  });
  const response = await request(app).post("/api/v2/documents/8/gmail-notification/dispatch")
    .send({ to: "to@example.com", attachPdf: true });
  assert.equal(response.status, 201);
  assert.equal(response.body.attached, false);
  assert.match(String(response.body.attachmentNote ?? ""), /リンクのみで送信/);
  const sent = (adapter as CapturingGmailAdapter).sent!;
  assert.equal(sent.attachments, undefined);
  // 本文は添付結果で組み直す＝「添付のとおり」ではなくURL案内になる。
  assert.doesNotMatch(sent.bodyText, /添付のとおり/);
  assert.match(sent.bodyText, /下記URLのとおり/);
});

test("attachPdf=false なら従来どおりリンクのみで送る", async () => {
  const { app, adapter } = appFor({
    live: true, role: "admin",
    attachmentDeps: { templates: templatesStub, pdfRenderer }
  });
  const response = await request(app).post("/api/v2/documents/8/gmail-notification/dispatch")
    .send({ to: "to@example.com", attachPdf: false });
  assert.equal(response.status, 201);
  assert.equal(response.body.attached, false);
  assert.equal((adapter as CapturingGmailAdapter).sent!.attachments, undefined);
});

test("法務ロールは実送信できない（管理者限定）", async () => {
  const { app } = appFor({ live: true, role: "legal" });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/dispatch").send({ to: "to@example.com" });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "GMAIL_ADMIN_REQUIRED");
});

test("送信履歴有効時、同一宛先の再送は冪等で実送信をスキップする", async () => {
  const history = new MemoryGmailSendHistoryRepository();
  const { app, adapter } = appFor({ live: true, role: "admin", history });
  const first = await request(app).post("/api/v2/documents/7/gmail-notification/dispatch").send({ to: "to@example.com" });
  assert.equal(first.status, 201);
  assert.equal(first.body.integrations.gmail, "sent");
  const second = await request(app).post("/api/v2/documents/7/gmail-notification/dispatch").send({ to: "to@example.com" });
  assert.equal(second.status, 200);
  assert.equal(second.body.integrations.gmail, "duplicate");
  assert.equal(second.body.receipt.messageId, "m1");
  // アダプタは1回しか呼ばれない（二重送信しない）。
  assert.equal((adapter as CapturingGmailAdapter).sendCount, 1);
});

test("送信履歴が無効なら従来通り毎回送信する（後方互換）", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  await request(app).post("/api/v2/documents/7/gmail-notification/dispatch").send({ to: "to@example.com" });
  await request(app).post("/api/v2/documents/7/gmail-notification/dispatch").send({ to: "to@example.com" });
  assert.equal((adapter as CapturingGmailAdapter).sendCount, 2);
});
