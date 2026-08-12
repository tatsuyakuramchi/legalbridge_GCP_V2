import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createCloudSignRouter } from "./cloudsign-routes.js";
import { MemoryDocumentRegistryRepository, type RegisteredDocument } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import type { CloudSignAdapter, CloudSignSignatureRequest } from "../integrations/cloudsign-adapter.js";
import { MemoryCloudSignRequestRepository } from "../integrations/cloudsign-request-repository.js";

const doc: RegisteredDocument = {
  id: 5, documentNumber: "DOC-2026-0005", issueKey: "LB-5", templateType: "license",
  templateVersionId: 1, title: "ライセンス契約", counterparty: "株式会社甲",
  driveLink: "", createdAt: "2026-08-04T00:00:00.000Z", createdBy: "legal@arclight.co.jp", formData: {}
};

// renderStoredDocumentHtml が使うのは findRenderSource / findPartials のみ。
// document.templateVersionId(1) と一致させて版ズレ例外を避ける。
const templatesStub = {
  async findRenderSource() { return { templateVersionId: 1, htmlSource: "<h1>{{TITLE}}</h1>" }; },
  async findPartials() { return {}; }
} as unknown as TemplateRepository;
const pdfRenderer: PdfRenderer = { async render() { return Buffer.from("%PDF-1.4 test"); } };

class CapturingCloudSign implements CloudSignAdapter {
  readonly configured = true;
  sent: CloudSignSignatureRequest | null = null;
  sendCount = 0;
  async requestSignature(req: CloudSignSignatureRequest) {
    this.sent = req; this.sendCount += 1;
    return { cloudSignDocumentId: "cs-1", status: req.sendNow ? "sent" : "draft", participantIds: ["pt-1"] };
  }
  async fetchStatus(cloudSignDocumentId: string) {
    return { cloudSignDocumentId, status: "completed", completed: true, participants: [] };
  }
}

function appFor(options: {
  role?: "admin" | "legal" | "requester"; live?: boolean; adapter?: CloudSignAdapter;
  allowedRecipients?: Set<string>; requestHistory?: MemoryCloudSignRequestRepository;
  extraDocs?: RegisteredDocument[];
}) {
  const registry = new MemoryDocumentRegistryRepository([doc, ...(options.extraDocs ?? [])]);
  const adapter = options.adapter ?? new CapturingCloudSign();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createCloudSignRouter(registry, templatesStub, pdfRenderer, adapter, {
    integrationMode: options.live ? "live" : "local",
    cloudSignCapabilityEnabled: options.live ?? false,
    adapterConfigured: adapter.configured
  }, { allowedRecipients: options.allowedRecipients, requestHistory: options.requestHistory }));
  return { app, adapter };
}

const body = { participants: [{ email: "a@example.com", name: "甲" }] };

test("プレビューはローカルでも署名者とブロック理由を返す", async () => {
  const { app } = appFor({ live: false });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/preview").send(body);
  assert.equal(response.status, 200);
  assert.match(response.body.preview.documentTitle, /DOC-2026-0005/);
  assert.equal(response.body.gate.dispatchAllowed, false);
  assert.ok(response.body.gate.blockerLabels.length > 0);
});

test("依頼者ロールはプレビューできない", async () => {
  const { app } = appFor({ role: "requester" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/preview").send(body);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "CLOUDSIGN_FORBIDDEN");
});

test("ローカルモードでは実依頼を409でブロックする", async () => {
  const { app, adapter } = appFor({ live: false });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CLOUDSIGN_DISPATCH_BLOCKED");
  assert.equal((adapter as CapturingCloudSign).sent, null);
});

test("ライブモードかつ管理者はPDFを描画して署名依頼する", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 201);
  assert.equal(response.body.receipt.cloudSignDocumentId, "cs-1");
  const sent = (adapter as CapturingCloudSign).sent;
  assert.notEqual(sent, null);
  assert.ok(sent && sent.pdf.length > 0);
});

test("法務ロールは実依頼できない（管理者限定）", async () => {
  const { app } = appFor({ live: true, role: "legal" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "CLOUDSIGN_ADMIN_REQUIRED");
});

test("allowlist設定時、許可外の宛先は422でブロックする", async () => {
  const allowedRecipients = new Set(["allowed@example.com"]);
  const { app, adapter } = appFor({ live: true, role: "admin", allowedRecipients });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ participants: [{ email: "a@example.com", name: "甲" }] });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_RECIPIENT_NOT_ALLOWED");
  assert.equal((adapter as CapturingCloudSign).sendCount, 0);
});

test("allowlist設定時、全宛先が許可内なら送信する", async () => {
  const allowedRecipients = new Set(["a@example.com"]);
  const { app, adapter } = appFor({ live: true, role: "admin", allowedRecipients });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 201);
  assert.equal((adapter as CapturingCloudSign).sendCount, 1);
});

test("既定は下書き作成：drafted＋CloudSign画面URLを返しCCも受け付ける", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, cc: [{ email: "cc@example.com", name: "共有" }] });
  assert.equal(response.status, 201);
  assert.equal(response.body.integrations.cloudsign, "drafted");
  assert.equal(response.body.receipt.status, "draft");
  assert.match(String(response.body.cloudSignUrl), /^https:\/\/app\.cloudsign\.jp\/documents\//);
  const captured = (adapter as CapturingCloudSign).sent!;
  assert.equal(captured.sendNow, false);
  assert.deepEqual(captured.cc, [{ email: "cc@example.com", name: "共有" }]);
});

test("CCがallowlist外なら422で拒否する", async () => {
  const allowedRecipients = new Set(["a@example.com"]);
  const { app } = appFor({ live: true, role: "admin", allowedRecipients });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, cc: [{ email: "outside@example.com" }] });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_RECIPIENT_NOT_ALLOWED");
});

test("同一案件の文書はまとめて1つのCloudSign書類に添付できる", async () => {
  const primary = { ...doc, matterId: 77 };
  const sibling: RegisteredDocument = { ...doc, id: 6, documentNumber: "DOC-2026-0006", matterId: 77 };
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app, adapter } = appForWithDocs([primary, sibling], { requestHistory });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, attachDocumentIds: [6] });
  assert.equal(response.status, 201);
  assert.equal(response.body.attachedCount, 1);
  const captured = (adapter as CapturingCloudSign).sent!;
  assert.equal(captured.extraFiles?.length, 1);
  assert.match(captured.extraFiles![0].filename, /DOC-2026-0006/);
  // 添付文書の履歴も記録される（各文書のパネルに表示するため）。
  assert.equal((await requestHistory.listByDocument(6)).length, 1);
  assert.equal((await requestHistory.listByDocument(5)).length, 1);
});

test("別案件の文書を添付しようとすると422で拒否する", async () => {
  const primary = { ...doc, matterId: 77 };
  const other: RegisteredDocument = { ...doc, id: 7, documentNumber: "DOC-2026-0007", matterId: 99 };
  const { app } = appForWithDocs([primary, other], {});
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, attachDocumentIds: [7] });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_ATTACH_DIFFERENT_MATTER");
});

function appForWithDocs(docs: RegisteredDocument[], options: {
  requestHistory?: MemoryCloudSignRequestRepository;
}) {
  const registry = new MemoryDocumentRegistryRepository(docs);
  const adapter = new CapturingCloudSign();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createCloudSignRouter(registry, templatesStub, pdfRenderer, adapter, {
    integrationMode: "live", cloudSignCapabilityEnabled: true, adapterConfigured: true
  }, { requestHistory: options.requestHistory }));
  return { app, adapter };
}

test("履歴有効時、同一文書の再依頼は冪等で再送しない(duplicate)", async () => {
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app, adapter } = appFor({ live: true, role: "admin", requestHistory });
  const first = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send({ ...body, sendNow: true });
  assert.equal(first.status, 201);
  assert.equal(first.body.integrations.cloudsign, "requested");
  const second = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(second.status, 200);
  assert.equal(second.body.integrations.cloudsign, "duplicate");
  assert.equal(second.body.receipt.cloudSignDocumentId, "cs-1");
  assert.equal((adapter as CapturingCloudSign).sendCount, 1);
});

test("履歴有効時、cloudSignDocumentId が永続化されステータス取得で更新される", async () => {
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app } = appFor({ live: true, role: "admin", requestHistory });
  await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  const stored = await requestHistory.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].cloudSignDocumentId, "cs-1");
  assert.equal(stored[0].participantCount, 1);
  // ステータス取得で status が completed に反映される。
  await request(app).get("/api/v2/cloudsign/cs-1/status");
  const after = await requestHistory.findByKey(stored[0].idempotencyKey);
  assert.equal(after?.status, "completed");
});

test("履歴無効なら従来通り毎回送信する（後方互換）", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal((adapter as CapturingCloudSign).sendCount, 2);
});
