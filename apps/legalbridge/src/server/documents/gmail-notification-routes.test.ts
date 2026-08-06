import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createGmailNotificationRouter, buildFinalizeNotification } from "./gmail-notification-routes.js";
import { MemoryDocumentRegistryRepository, type RegisteredDocument } from "./registry-repository.js";
import type { GmailDeliveryAdapter } from "../integrations/gmail-delivery-adapter.js";
import { MemoryGmailSendHistoryRepository } from "../integrations/gmail-send-history-repository.js";

const doc: RegisteredDocument = {
  id: 7, documentNumber: "DOC-2026-0007", issueKey: "LB-7", templateType: "license",
  templateVersionId: 1, title: "英語版ライセンス契約", counterparty: "株式会社サンプル",
  driveLink: "https://drive.google.com/file/d/x/view", createdAt: "2026-08-04T00:00:00.000Z",
  createdBy: "legal@arclight.co.jp", formData: {}
};

class CapturingGmailAdapter implements GmailDeliveryAdapter {
  readonly configured = true;
  sent: unknown = null;
  sendCount = 0;
  async send(req: unknown) { this.sent = req; this.sendCount += 1; return { messageId: "m1", threadId: "t1" }; }
}

function appFor(options: {
  role?: "admin" | "legal" | "requester"; live?: boolean; adapter?: GmailDeliveryAdapter;
  history?: MemoryGmailSendHistoryRepository;
}) {
  const registry = new MemoryDocumentRegistryRepository([doc]);
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
  }, options.history));
  return { app, adapter };
}

test("確定通知の件名・本文・冪等キーを組み立てる", () => {
  const content = buildFinalizeNotification(doc, "to@example.com");
  assert.match(content.subject, /DOC-2026-0007/);
  assert.match(content.bodyText, /株式会社サンプル 御中/);
  assert.match(content.idempotencyKey, /^[a-f0-9]{64}$/);
});

test("プレビューはローカルでも本文とブロック理由を返す", async () => {
  const { app } = appFor({ live: false });
  const response = await request(app).post("/api/v2/documents/7/gmail-notification/preview").send({ to: "to@example.com" });
  assert.equal(response.status, 200);
  assert.match(response.body.preview.subject, /確定のお知らせ/);
  assert.equal(response.body.gate.dispatchAllowed, false);
  assert.ok(response.body.gate.blockerLabels.length > 0);
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
