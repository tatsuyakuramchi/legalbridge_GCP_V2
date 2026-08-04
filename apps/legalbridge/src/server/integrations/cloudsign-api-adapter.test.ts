import assert from "node:assert/strict";
import test from "node:test";
import { CloudSignApiAdapter, type CloudSignApiClient } from "./cloudsign-api-adapter.js";

class FakeClient implements CloudSignApiClient {
  calls: string[] = [];
  async createDocument(input: { title: string }) { this.calls.push(`create:${input.title}`); return { id: "doc-1" }; }
  async addFile(documentId: string, filename: string) { this.calls.push(`file:${documentId}:${filename}`); return { id: "file-1" }; }
  async addParticipant(documentId: string, p: { email: string }) { this.calls.push(`participant:${p.email}`); return { id: `pt-${p.email}` }; }
  async send(documentId: string) { this.calls.push(`send:${documentId}`); return { status: "sent" }; }
}

const baseRequest = {
  documentTitle: "契約書（DOC-1）", note: "案件：LB-1", filename: "doc.pdf",
  pdf: Buffer.from("%PDF-1.4"), idempotencyKey: "k",
  participants: [{ email: "a@example.com", name: "甲" }, { email: "b@example.com", name: "乙" }]
};

test("署名依頼はcreate→file→participant→sendの順で発行する", async () => {
  const client = new FakeClient();
  const adapter = new CloudSignApiAdapter(client);
  const receipt = await adapter.requestSignature(baseRequest);
  assert.equal(receipt.cloudSignDocumentId, "doc-1");
  assert.equal(receipt.status, "sent");
  assert.deepEqual(receipt.participantIds, ["pt-a@example.com", "pt-b@example.com"]);
  assert.deepEqual(client.calls, [
    "create:契約書（DOC-1）", "file:doc-1:doc.pdf",
    "participant:a@example.com", "participant:b@example.com", "send:doc-1"
  ]);
});

test("署名者が空なら送信せず失敗する", async () => {
  const adapter = new CloudSignApiAdapter(new FakeClient());
  await assert.rejects(() => adapter.requestSignature({ ...baseRequest, participants: [] }), /participant/);
});

test("署名者のメールが不正なら送信せず失敗する", async () => {
  const adapter = new CloudSignApiAdapter(new FakeClient());
  await assert.rejects(
    () => adapter.requestSignature({ ...baseRequest, participants: [{ email: "bad", name: "甲" }] }),
    /valid participant email/);
});
