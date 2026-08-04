import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createCloudSignRouter } from "./cloudsign-routes.js";
import { MemoryDocumentRegistryRepository, type RegisteredDocument } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import type { CloudSignAdapter, CloudSignSignatureRequest } from "../integrations/cloudsign-adapter.js";

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
  async requestSignature(req: CloudSignSignatureRequest) {
    this.sent = req; return { cloudSignDocumentId: "cs-1", status: "sent", participantIds: ["pt-1"] };
  }
  async fetchStatus(cloudSignDocumentId: string) {
    return { cloudSignDocumentId, status: "completed", completed: true, participants: [] };
  }
}

function appFor(options: { role?: "admin" | "legal" | "requester"; live?: boolean; adapter?: CloudSignAdapter }) {
  const registry = new MemoryDocumentRegistryRepository([doc]);
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
  }));
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
