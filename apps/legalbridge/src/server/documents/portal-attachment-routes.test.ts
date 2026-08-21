import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createPortalAttachmentRouter, MemoryPortalIssueResolver } from "./portal-attachment-routes.js";
import { MemoryAttachmentsRepository } from "./attachments-repository.js";
import { MemoryDriveStorage } from "./drive-storage.js";

// V1 検索ポータル互換の資料アップロード受け口（V1停止・案A）のテスト。
// 契約: POST /api/attachments/by-issue（multipart: issueKey/docKind/originalName/file、
// ヘッダ x-lb-portal-secret / x-lb-uploader-email、応答 snake_case）。

const BOUNDARY = "PortalBoundary1";
const SECRET = "portal-secret-value";

function multipartBody(parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string }>) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename !== undefined
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`
      : `Content-Disposition: form-data; name="${part.name}"`;
    const typeHeader = part.contentType ? `\r\nContent-Type: ${part.contentType}` : "";
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${disposition}${typeHeader}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function appFor(opts: {
  secret?: string; enabled?: boolean; storage?: MemoryDriveStorage | null;
  postComment?: (issueKey: string, text: string) => Promise<void>;
} = {}) {
  const repository = new MemoryAttachmentsRepository([]);
  const resolver = new MemoryPortalIssueResolver(["LEGAL-123", "LEGAL-777"], { "LEGAL-123": 42 });
  const storage = opts.storage === null ? null : (opts.storage ?? new MemoryDriveStorage());
  const app = express();
  app.use(createPortalAttachmentRouter({
    repository, resolver, storage,
    postComment: opts.postComment,
    writeEnabled: opts.enabled ?? true,
    portalSecret: () => opts.secret ?? SECRET
  }));
  return { app, repository };
}

function bodyFor(issueKey: string) {
  return multipartBody([
    { name: "issueKey", data: issueKey },
    { name: "docKind", data: "counterparty_draft" },
    { name: "originalName", data: "先方ドラフト.pdf" },
    { name: "file", filename: "draft.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 test") }
  ]);
}

function post(app: express.Express, body: Buffer, headers: Record<string, string> = {}) {
  let req = request(app).post("/api/attachments/by-issue")
    .set("Content-Type", `multipart/form-data; boundary=${BOUNDARY}`);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body);
}

test("portal-attach: シークレット未設定は404（fail-closed）", async () => {
  const { app } = appFor({ secret: "" });
  const res = await post(app, bodyFor("LEGAL-123"), { "x-lb-portal-secret": "anything" });
  assert.equal(res.status, 404);
});

test("portal-attach: シークレット不一致は401", async () => {
  const { app } = appFor();
  const res = await post(app, bodyFor("LEGAL-123"), { "x-lb-portal-secret": "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test("portal-attach: 正常系はDrive格納＋ATT採番＋snake_case応答（案件解決あり）", async () => {
  const comments: string[] = [];
  const { app, repository } = appFor({
    postComment: async (_key, text) => { comments.push(text); }
  });
  const res = await post(app, bodyFor("LEGAL-123"), {
    "x-lb-portal-secret": SECRET, "x-lb-uploader-email": "biz@arclight.co.jp"
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // ページ互換: d.document.document_number を表示に使う
  assert.match(String(res.body.document.document_number), /^ATT-\d{4}-\d{5}$/);
  assert.equal(res.body.document.matter_id, 42);
  const saved = repository.registered[0];
  assert.equal(saved.matterId, 42);
  assert.equal(saved.issueKey, "LEGAL-123");
  assert.equal(saved.templateType, "counterparty_draft");
  // Backlog コメント（V1 文言）
  assert.match(comments[0], /資料アップロードページから資料が格納されました/);
  assert.match(comments[0], /biz@arclight\.co\.jp/);
});

test("portal-attach: 案件未解決でも matter_id=null で登録できる（V1同様）", async () => {
  const { app, repository } = appFor();
  const res = await post(app, bodyFor("LEGAL-777"), { "x-lb-portal-secret": SECRET });
  assert.equal(res.status, 200);
  assert.equal(res.body.document.matter_id, null);
  assert.equal(repository.registered[0].matterId, null);
});

test("portal-attach: 実在しない課題番号は404、番号形式不正は400", async () => {
  const { app } = appFor();
  const notFound = await post(app, bodyFor("LEGAL-999"), { "x-lb-portal-secret": SECRET });
  assert.equal(notFound.status, 404);
  assert.match(String(notFound.body.error), /LEGAL-999/);
  const badKey = await post(app, bodyFor("not a key"), { "x-lb-portal-secret": SECRET });
  assert.equal(badKey.status, 400);
});

test("portal-attach: 機能未点火（writeEnabled=false）は503", async () => {
  const { app } = appFor({ enabled: false });
  const res = await post(app, bodyFor("LEGAL-123"), { "x-lb-portal-secret": SECRET });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
});
