import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createGmailInboundRouter } from "./gmail-inbound-routes.js";
import type { GmailInboundAdapter } from "../integrations/gmail-inbound-adapter.js";

class FakeInbound implements GmailInboundAdapter {
  readonly configured = true;
  async listContracts() {
    return [{ messageId: "m1", threadId: "t1", subject: "契約書", from: "cp@example.com", date: null,
      attachments: [{ attachmentId: "att-1", filename: "c.pdf", mimeType: "application/pdf", sizeBytes: 100 }] }];
  }
  async fetchAttachment() { return Buffer.from("%PDF-1.4 body"); }
}

function appFor(options: { role?: "admin" | "legal" | "requester"; enabled?: boolean }) {
  const app = express();
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createGmailInboundRouter(new FakeInbound(), {
    enabled: options.enabled ?? true, query: "has:attachment filename:pdf", mailbox: "legal@arclight.co.jp"
  }));
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
