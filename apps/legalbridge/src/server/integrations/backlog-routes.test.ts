import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createBacklogRequestRouter, createBacklogCommentRouter } from "./backlog-routes.js";
import { BacklogApiError, type BacklogReadClient, type BacklogWriteClient, type BacklogIssueSummary } from "./backlog-web-api.js";

function app(opts: { role?: string; client?: BacklogReadClient } = {}) {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createBacklogRequestRouter(opts.client));
  return a;
}

const issue = (over: Partial<BacklogIssueSummary> & { id: number }): BacklogIssueSummary => ({
  issueKey: `LEGAL-${over.id}`, summary: "件名", statusName: "未対応", assigneeName: null,
  created: null, updated: null, ...over
});

test("admin/legal以外は403", async () => {
  const res = await request(app({ role: "requester" })).get("/api/v2/backlog/issues");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "BACKLOG_ROLE_REQUIRED");
});

test("クライアント未構成（未設定）は enabled:false で空", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/backlog/issues");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.deepEqual(res.body.issues, []);
});

test("legalは課題一覧を取得できる", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => [issue({ id: 1 }), issue({ id: 2 })]
  };
  const res = await request(app({ role: "admin", client })).get("/api/v2/backlog/issues?keyword=NDA");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.issues.length, 2);
  assert.equal(res.body.issues[0].issueKey, "LEGAL-1");
});

test("Backlog APIエラーは502", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => { throw new BacklogApiError(403); }
  };
  const res = await request(app({ role: "legal", client })).get("/api/v2/backlog/issues");
  assert.equal(res.status, 502);
  assert.equal(res.body.code, "BACKLOG_API_ERROR");
});

function commentApp(opts: { role?: string; enabled?: boolean; client?: BacklogWriteClient } = {}) {
  const a = express();
  a.use(express.json());
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role ? ({ email: "u@x", role: opts.role, subject: "u", source: "test" } as never) : undefined;
    next();
  });
  a.use("/api/v2", createBacklogCommentRouter(opts.client, opts.enabled ?? false));
  return a;
}
const okWriteClient: BacklogWriteClient = { addComment: async () => ({ id: 999 }) };

test("コメント: 書込み無効時は503", async () => {
  const res = await request(commentApp({ role: "legal", enabled: false, client: okWriteClient }))
    .post("/api/v2/backlog/issues/LEGAL-1/comments").send({ content: "確認しました", confirmation: "COMMIT_BACKLOG_COMMENT" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "BACKLOG_COMMENT_WRITE_UNAVAILABLE");
});

test("コメント: 確認トークン不正は400", async () => {
  const res = await request(commentApp({ role: "legal", enabled: true, client: okWriteClient }))
    .post("/api/v2/backlog/issues/LEGAL-1/comments").send({ content: "x", confirmation: "WRONG" });
  assert.equal(res.status, 400);
});

test("コメント: admin/legal以外は403", async () => {
  const res = await request(commentApp({ role: "requester", enabled: true, client: okWriteClient }))
    .post("/api/v2/backlog/issues/LEGAL-1/comments").send({ content: "x", confirmation: "COMMIT_BACKLOG_COMMENT" });
  assert.equal(res.status, 403);
});

test("コメント: 有効かつトークン一致で投稿", async () => {
  let captured: { key: string; content: string } | null = null;
  const client: BacklogWriteClient = { addComment: async (key, content) => { captured = { key, content }; return { id: 42 }; } };
  const res = await request(commentApp({ role: "admin", enabled: true, client }))
    .post("/api/v2/backlog/issues/LEGAL-9/comments").send({ content: "レビュー完了", confirmation: "COMMIT_BACKLOG_COMMENT" });
  assert.equal(res.status, 201);
  assert.equal(res.body.commentId, 42);
  assert.deepEqual(captured, { key: "LEGAL-9", content: "レビュー完了" });
});
