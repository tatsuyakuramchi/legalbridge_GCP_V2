import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createAttachmentsRouter } from "./attachments-routes.js";
import { MemoryAttachmentsRepository } from "./attachments-repository.js";
import { MemoryDriveStorage } from "./drive-storage.js";

const BOUNDARY = "TestBoundary123";

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
  enabled?: boolean; role?: string; forbidden?: boolean;
  storage?: MemoryDriveStorage | null;
  postComment?: (issueKey: string, text: string) => Promise<void>;
} = {}) {
  const repository = new MemoryAttachmentsRepository(
    [
      { id: 10, matterCode: "M-2025-0001", primaryIssueKey: "LEGAL-123" },
      { id: 11, matterCode: null, primaryIssueKey: null }
    ],
    opts.forbidden ?? false
  );
  const storage = opts.storage === null ? null : (opts.storage ?? new MemoryDriveStorage());
  const app = express();
  app.use((_req, res, next) => {
    res.locals.currentUser = {
      email: "legal@arclight.co.jp", subject: "t", role: opts.role ?? "legal", source: "test"
    } as never;
    next();
  });
  app.use("/api/v2", createAttachmentsRouter({
    repository, storage, postComment: opts.postComment, writeEnabled: opts.enabled ?? true
  }));
  return { app, repository, storage };
}

function post(app: express.Express, matterId: number, body: Buffer) {
  return request(app)
    .post(`/api/v2/matters/${matterId}/attachments`)
    .set("Content-Type", `multipart/form-data; boundary=${BOUNDARY}`)
    .send(body);
}

const pdfBytes = Buffer.from("%PDF-1.4 fake attachment body");

test("添付: アップロード成功（Drive 格納→ATT 採番→documents 登録）", async () => {
  const target = appFor({});
  const body = multipartBody([
    { name: "docKind", data: "counterparty_draft" },
    { name: "originalName", data: "相手方ドラフト.pdf" },
    { name: "file", filename: "draft.pdf", contentType: "application/pdf", data: pdfBytes }
  ]);
  const res = await post(target.app, 10, body).expect(200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.document.documentNumber, /^ATT-\d{4}-\d{5}$/);
  assert.equal(res.body.document.templateType, "counterparty_draft");
  // Drive のファイル名は「課題番号_アカウント_元ファイル名」
  assert.equal(target.storage!.fileUploads.length, 1);
  assert.equal(target.storage!.fileUploads[0].filename, "LEGAL-123_legal@arclight.co.jp_相手方ドラフト.pdf");
  assert.equal(target.storage!.fileUploads[0].mimeType, "application/pdf");
  const registered = target.repository.registered[0];
  assert.equal(registered.matterId, 10);
  assert.equal(registered.issueKey, "LEGAL-123");
});

test("添付: 課題キーが無い案件は案件コード/ID でファイル名を組む", async () => {
  const target = appFor({});
  const body = multipartBody([
    { name: "file", filename: "memo.txt", contentType: "text/plain", data: "memo" }
  ]);
  await post(target.app, 11, body).expect(200);
  assert.equal(target.storage!.fileUploads[0].filename, "M11_legal@arclight.co.jp_memo.txt");
});

test("添付: docKind 不明は reference に落とす（V1 同様）", async () => {
  const target = appFor({});
  const body = multipartBody([
    { name: "docKind", data: "bogus" },
    { name: "file", filename: "a.txt", data: "x" }
  ]);
  const res = await post(target.app, 10, body).expect(200);
  assert.equal(res.body.document.templateType, "reference");
});

test("添付: 書込無効時は503", async () => {
  const target = appFor({ enabled: false });
  const body = multipartBody([{ name: "file", filename: "a.txt", data: "x" }]);
  const res = await post(target.app, 10, body);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "ATTACHMENTS_WRITE_UNAVAILABLE");
});

test("添付: ストレージ未設定は503", async () => {
  const target = appFor({ storage: null });
  const body = multipartBody([{ name: "file", filename: "a.txt", data: "x" }]);
  const res = await post(target.app, 10, body);
  assert.equal(res.status, 503);
});

test("添付: requester は403", async () => {
  const target = appFor({ role: "requester" });
  const body = multipartBody([{ name: "file", filename: "a.txt", data: "x" }]);
  const res = await post(target.app, 10, body);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "ATTACHMENTS_FORBIDDEN");
});

test("添付: 存在しない案件は404", async () => {
  const target = appFor({});
  const body = multipartBody([{ name: "file", filename: "a.txt", data: "x" }]);
  const res = await post(target.app, 999, body);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "MATTER_NOT_FOUND");
});

test("添付: ファイル無しは400", async () => {
  const target = appFor({});
  const body = multipartBody([{ name: "docKind", data: "reference" }]);
  const res = await post(target.app, 10, body);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ATTACHMENTS_NO_FILE");
});

test("添付: multipart でない POST は400", async () => {
  const target = appFor({});
  const res = await request(target.app)
    .post("/api/v2/matters/10/attachments")
    .set("Content-Type", "application/json")
    .send(JSON.stringify({}));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ATTACHMENTS_NOT_MULTIPART");
});

test("添付: DB 権限未整備(42501)は503", async () => {
  const target = appFor({ forbidden: true });
  const body = multipartBody([{ name: "file", filename: "a.txt", data: "x" }]);
  const res = await post(target.app, 10, body);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "ATTACHMENTS_FORBIDDEN_DB");
});

test("添付: Drive 失敗は502で登録なし", async () => {
  const storage = new MemoryDriveStorage();
  storage.uploadFile = async () => { throw new Error("folder not found"); };
  const target = appFor({ storage });
  const body = multipartBody([{ name: "file", filename: "a.txt", data: "x" }]);
  const res = await post(target.app, 10, body);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, "ATTACHMENTS_DRIVE_FAILED");
  assert.equal(target.repository.registered.length, 0);
});

test("添付: Backlog コメントはベストエフォート（失敗しても200）", async () => {
  const comments: string[] = [];
  const target = appFor({
    postComment: async (issueKey, text) => {
      comments.push(`${issueKey}:${text.split("\n")[0]}`);
      throw new Error("backlog down");
    }
  });
  const body = multipartBody([{ name: "file", filename: "a.txt", data: "x" }]);
  await post(target.app, 10, body).expect(200);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /^LEGAL-123:/);
});

test("添付: 30MB 超は413", async () => {
  const target = appFor({});
  const big = Buffer.alloc(30 * 1024 * 1024 + 1, 0x41);
  const body = multipartBody([{ name: "file", filename: "big.bin", data: big }]);
  const res = await post(target.app, 10, body);
  assert.equal(res.status, 413);
});
