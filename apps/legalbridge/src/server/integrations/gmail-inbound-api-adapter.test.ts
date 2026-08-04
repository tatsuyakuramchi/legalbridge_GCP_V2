import assert from "node:assert/strict";
import test from "node:test";
import { extractPdfAttachments, headerValue, isPdfBufferSafe } from "./gmail-inbound-adapter.js";
import { GmailInboundApiAdapter, type GmailInboundApiClient } from "./gmail-inbound-api-adapter.js";

test("ネストしたpartsからPDF添付だけを抽出する", () => {
  const payload = {
    parts: [
      { filename: "", mimeType: "text/plain", body: { size: 10 } },
      { parts: [
        { filename: "contract.pdf", mimeType: "application/pdf", body: { attachmentId: "att-1", size: 2048 } },
        { filename: "image.png", mimeType: "image/png", body: { attachmentId: "att-2", size: 5 } }
      ] }
    ]
  };
  const attachments = extractPdfAttachments(payload);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].attachmentId, "att-1");
  assert.equal(attachments[0].filename, "contract.pdf");
});

test("ヘッダ値を大文字小文字を無視して取得する", () => {
  const headers = [{ name: "Subject", value: "契約書送付" }, { name: "From", value: "a@example.com" }];
  assert.equal(headerValue(headers, "subject"), "契約書送付");
  assert.equal(headerValue(headers, "From"), "a@example.com");
});

test("PDFマジックバイトを検証する", () => {
  assert.equal(isPdfBufferSafe(Buffer.from("%PDF-1.4 ...")), true);
  assert.equal(isPdfBufferSafe(Buffer.from("not a pdf")), false);
});

class FakeClient implements GmailInboundApiClient {
  async listMessageIds() { return ["m1", "m2"]; }
  async getMessage(messageId: string) {
    if (messageId === "m2") return { threadId: "t2", payload: { headers: [], parts: [] } }; // 添付なし
    return {
      threadId: "t1",
      payload: {
        headers: [{ name: "Subject", value: "契約書" }, { name: "From", value: "cp@example.com" }, { name: "Date", value: "Mon, 4 Aug 2026" }],
        parts: [{ filename: "c.pdf", mimeType: "application/pdf", body: { attachmentId: "att-1", size: 100 } }]
      }
    };
  }
  async getAttachment() { return Buffer.from("%PDF-1.4 body").toString("base64url"); }
}

test("PDF添付のあるメールだけを契約候補として返す", async () => {
  const adapter = new GmailInboundApiAdapter(new FakeClient());
  const messages = await adapter.listContracts("q", 25);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "m1");
  assert.equal(messages[0].subject, "契約書");
  assert.equal(messages[0].attachments[0].attachmentId, "att-1");
});

test("添付取得はPDFをbufferで返す", async () => {
  const adapter = new GmailInboundApiAdapter(new FakeClient());
  const pdf = await adapter.fetchAttachment("m1", "att-1");
  assert.ok(isPdfBufferSafe(pdf));
});
