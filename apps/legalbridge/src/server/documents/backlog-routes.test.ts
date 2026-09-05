import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import type { DocumentRegistryRepository, RegisteredDocument } from "./registry-repository.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import { MemoryPdfRenderer } from "./pdf-renderer.js";
import { createDocumentBacklogRouter } from "./backlog-routes.js";
import type {
  BacklogAttachmentSummary,
  BacklogCommentSummary,
  BacklogIssueSummary,
  BacklogProjectSummary,
  BacklogWriteClient
} from "../integrations/backlog-web-api.js";

const document: RegisteredDocument = {
  id: 10,
  documentNumber: "ARC-LG-2026-0010",
  previousDocumentNumber: null,
  issueKey: "LEGAL-10",
  templateType: "legal_response",
  templateVersionId: 1,
  title: "法務回答",
  counterparty: "Test",
  driveLink: "",
  createdAt: "2026-09-05T00:00:00.000Z",
  createdBy: "legal@example.com",
  formData: {}
};

class DocumentRepo implements DocumentRegistryRepository {
  async list() { return [document]; }
  async find(id: number) { return id === document.id ? document : null; }
  async setDriveLink() {}
}

class BacklogFake implements BacklogWriteClient {
  project: BacklogProjectSummary = { id: 1, projectKey: "LEGAL", name: "法務" };
  issue: BacklogIssueSummary = {
    id: 100,
    projectId: 1,
    issueKey: "LEGAL-10",
    summary: "法務回答",
    statusName: "Open"
  };
  attachments: BacklogAttachmentSummary[] = [];
  uploads = 0;
  comments = 0;

  async getProject() { return this.project; }
  async getIssue() { return this.issue; }
  async listIssueAttachments() { return this.attachments; }
  async uploadAttachment(input: { filename: string; contentType: string; data: Uint8Array }) {
    this.uploads += 1;
    assert.equal(input.filename, "ARC-LG-2026-0010.pdf");
    assert.equal(input.contentType, "application/pdf");
    assert.ok(input.data.length > 0);
    return { id: 55, name: input.filename, size: input.data.length };
  }
  async addIssueComment(input: { issueIdOrKey: string; content: string; attachmentIds?: number[] }) {
    this.comments += 1;
    assert.equal(input.issueIdOrKey, "LEGAL-10");
    assert.deepEqual(input.attachmentIds, [55]);
    assert.match(input.content, /ARC-LG-2026-0010/);
    return { id: 77, content: input.content } satisfies BacklogCommentSummary;
  }
}

function app(client: BacklogWriteClient | null, live = false) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = {
      role: "legal",
      email: "legal@example.com",
      subject: "test",
      source: "disabled"
    };
    next();
  });
  const templates = new MemoryTemplateRepository(
    [{ templateKey: "legal_response", templateVersionId: 1, label: "法務回答", fields: [] }],
    { legal_response: "<h1>法務回答</h1>" }
  );
  app.use("/api/v2", createDocumentBacklogRouter(
    new DocumentRepo(),
    templates,
    new MemoryPdfRenderer(),
    client,
    live
  ));
  return app;
}

test("Backlog previewは課題と既存添付を参照するだけ", async () => {
  const client = new BacklogFake();
  const response = await request(app(client, false)).get("/api/v2/documents/10/backlog");
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, "readonly");
  assert.equal(response.body.issue.issueKey, "LEGAL-10");
  assert.equal(client.uploads, 0);
  assert.equal(client.comments, 0);
});

test("Backlog live無効時はdispatchしない", async () => {
  const client = new BacklogFake();
  const response = await request(app(client, false))
    .post("/api/v2/documents/10/backlog/dispatch");
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "BACKLOG_LIVE_DISABLED");
  assert.equal(client.uploads, 0);
});

test("同名PDFが既に課題にあれば重複送信しない", async () => {
  const client = new BacklogFake();
  client.attachments = [{ id: 44, name: "ARC-LG-2026-0010.pdf", size: 120 }];
  const response = await request(app(client, true))
    .post("/api/v2/documents/10/backlog/dispatch");
  assert.equal(response.status, 200);
  assert.equal(response.body.reused, true);
  assert.equal(client.uploads, 0);
  assert.equal(client.comments, 0);
});

test("live時だけPDFを一時添付し課題コメントへ結び付ける", async () => {
  const client = new BacklogFake();
  const response = await request(app(client, true))
    .post("/api/v2/documents/10/backlog/dispatch");
  assert.equal(response.status, 201);
  assert.equal(response.body.reused, false);
  assert.equal(response.body.attachment.id, 55);
  assert.equal(response.body.comment.id, 77);
  assert.equal(client.uploads, 1);
  assert.equal(client.comments, 1);
});

test("別プロジェクトの課題は拒否する", async () => {
  const client = new BacklogFake();
  client.issue = { ...client.issue, projectId: 999 };
  const response = await request(app(client, true))
    .post("/api/v2/documents/10/backlog/dispatch");
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "BACKLOG_PROJECT_MISMATCH");
  assert.equal(client.uploads, 0);
});
