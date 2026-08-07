import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createGmailInboundRouter } from "./gmail-inbound-routes.js";
import type { GmailInboundAdapter } from "../integrations/gmail-inbound-adapter.js";
import { MemoryInboundContractRepository } from "../integrations/inbound-contract-repository.js";

class FakeInbound implements GmailInboundAdapter {
  readonly configured = true;
  fetchCount = 0;
  constructor(private readonly body = "%PDF-1.4 body") {}
  async listContracts() {
    return [{ messageId: "m1", threadId: "t1", subject: "契約書", from: "cp@example.com", date: null,
      attachments: [{ attachmentId: "att-1", filename: "c.pdf", mimeType: "application/pdf", sizeBytes: 100 }] }];
  }
  async fetchAttachment() { this.fetchCount += 1; return Buffer.from(this.body); }
}

function appFor(options: {
  role?: "admin" | "legal" | "requester"; enabled?: boolean;
  intake?: MemoryInboundContractRepository; inbound?: FakeInbound;
}) {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  const inbound = options.inbound ?? new FakeInbound();
  app.use("/api/v2", createGmailInboundRouter(inbound, {
    enabled: options.enabled ?? true, query: "has:attachment filename:pdf", mailbox: "legal@arclight.co.jp"
  }, options.intake));
  return app;
}

test("有効時は契約候補メール一覧を返す", async () => {
  const response = await request(appFor({ enabled: true })).get("/api/v2/gmail-inbound/contracts");
  assert.equal(response.status, 200);
  assert.equal(response.body.live, true);
  assert.equal(response.body.messages[0].subject, "契約書");
});

test("無効時は live=false で空一覧を返す", async () => {
  const response = await request(appFor({ enabled: false })).get("/api/v2/gmail-inbound/contracts");
  assert.equal(response.status, 200);
  assert.equal(response.body.live, false);
  assert.deepEqual(response.body.messages, []);
});

test("依頼者ロールは受信取込できない", async () => {
  const response = await request(appFor({ role: "requester" })).get("/api/v2/gmail-inbound/contracts");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "GMAIL_INBOUND_FORBIDDEN");
});

test("有効時は添付PDFをapplication/pdfで返す", async () => {
  const response = await request(appFor({ enabled: true }))
    .get("/api/v2/gmail-inbound/messages/m1/attachments/att-1");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /application\/pdf/);
});

test("無効時の添付取得は409", async () => {
  const response = await request(appFor({ enabled: false }))
    .get("/api/v2/gmail-inbound/messages/m1/attachments/att-1");
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "GMAIL_INBOUND_DISABLED");
});

test("取込台帳が無い場合、登録は409", async () => {
  const response = await request(appFor({ enabled: true }))
    .post("/api/v2/gmail-inbound/messages/m1/attachments/att-1/register").send({});
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "GMAIL_INBOUND_INTAKE_DISABLED");
});

test("取込登録は台帳に1件記録し、再登録は冪等(duplicate)", async () => {
  const intake = new MemoryInboundContractRepository();
  const inbound = new FakeInbound();
  const app = appFor({ enabled: true, intake, inbound });
  const first = await request(app)
    .post("/api/v2/gmail-inbound/messages/m1/attachments/att-1/register")
    .send({ filename: "c.pdf", from: "cp@example.com", subject: "契約書" });
  assert.equal(first.status, 201);
  assert.equal(first.body.intake, "captured");
  assert.equal(first.body.record.status, "captured");
  assert.equal(first.body.record.filename, "c.pdf");
  const second = await request(app)
    .post("/api/v2/gmail-inbound/messages/m1/attachments/att-1/register").send({});
  assert.equal(second.status, 200);
  assert.equal(second.body.intake, "duplicate");
  // 重複時はバイト再取得しない（1回目のみ fetch）。
  assert.equal(inbound.fetchCount, 1);
  const list = await request(app).get("/api/v2/gmail-inbound/registered");
  assert.equal(list.body.enabled, true);
  assert.equal(list.body.records.length, 1);
});

test("PDFでない添付の登録は422", async () => {
  const intake = new MemoryInboundContractRepository();
  const app = appFor({ enabled: true, intake, inbound: new FakeInbound("not a pdf") });
  const response = await request(app)
    .post("/api/v2/gmail-inbound/messages/m1/attachments/att-1/register").send({});
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "GMAIL_INBOUND_NOT_PDF");
});

test("取込レコードの状態遷移(captured→dismissed)", async () => {
  const intake = new MemoryInboundContractRepository();
  const app = appFor({ enabled: true, intake });
  const created = await request(app)
    .post("/api/v2/gmail-inbound/messages/m1/attachments/att-1/register").send({});
  const key = created.body.record.idempotencyKey;
  const updated = await request(app)
    .post(`/api/v2/gmail-inbound/registered/${key}/status`).send({ status: "dismissed" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.record.status, "dismissed");
  const active = await request(app).get("/api/v2/gmail-inbound/registered?status=captured");
  assert.equal(active.body.records.length, 0);
});

test("台帳が無いと registered は enabled=false", async () => {
  const response = await request(appFor({ enabled: true })).get("/api/v2/gmail-inbound/registered");
  assert.equal(response.status, 200);
  assert.equal(response.body.enabled, false);
});
