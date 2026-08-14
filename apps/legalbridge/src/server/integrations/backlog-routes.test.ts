import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createBacklogRequestRouter, createBacklogCommentRouter } from "./backlog-routes.js";
import { BacklogApiError, type BacklogReadClient, type BacklogWriteClient, type BacklogIssueSummary } from "./backlog-web-api.js";

function app(opts: {
  role?: string; client?: BacklogReadClient; host?: string;
  mentions?: { listCandidates(): Promise<Array<{ id: string; name: string }>> };
} = {}) {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createBacklogRequestRouter(opts.client, opts.host, opts.mentions));
  return a;
}

const issue = (over: Partial<BacklogIssueSummary> & { id: number }): BacklogIssueSummary => ({
  issueKey: `LEGAL-${over.id}`, summary: "件名", description: null, statusName: "未対応", assigneeName: null,
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

const emptyMetadata = async () => ({ statuses: [], customFields: [] });

test("legalは課題一覧を取得できる", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => [issue({ id: 1 }), issue({ id: 2 })],
    getProjectMetadata: emptyMetadata
  };
  const res = await request(app({ role: "admin", client })).get("/api/v2/backlog/issues?keyword=NDA");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.issues.length, 2);
  assert.equal(res.body.issues[0].issueKey, "LEGAL-1");
});

// 課題の「Backlogで開く」リンク用に host を返す（スキーム・末尾スラッシュは正規化）。
test("課題一覧はBacklogホストを正規化して返す", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => [issue({ id: 1 })],
    getProjectMetadata: emptyMetadata
  };
  const res = await request(app({ role: "admin", client, host: "https://arclight.backlog.com/" }))
    .get("/api/v2/backlog/issues");
  assert.equal(res.status, 200);
  assert.equal(res.body.host, "arclight.backlog.com");
});

// V1 の worker は課題本文に「依頼者: <@U…>」と Slack ユーザーIDを直接書いていた。
// 依頼一覧・抽出変数にIDが出ないよう、担当者マスタの氏名へ解決してから返す。
test("課題本文のSlackメンションを担当者名へ解決して返す", async () => {
  let calls = 0;
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => [issue({ id: 1, description: "依頼タイプ: nda\n依頼者: <@U0ABC123>\n担当: <@U0ZZZ999>" })],
    getProjectMetadata: emptyMetadata
  };
  const mentions = {
    listCandidates: async () => { calls += 1; return [{ id: "U0ABC123", name: "田中 太郎" }]; }
  };
  const a = app({ role: "legal", client, mentions });
  const res = await request(a).get("/api/v2/backlog/issues");
  assert.equal(res.status, 200);
  assert.equal(res.body.issues[0].description, "依頼タイプ: nda\n依頼者: @田中 太郎\n担当: @U0ZZZ999");
  // 担当者マスタの引き直しは短期キャッシュする（課題一覧のたびには引かない）。
  await request(a).get("/api/v2/backlog/issues");
  assert.equal(calls, 1);
});

test("担当者マスタの取得に失敗しても課題一覧は返る", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => [issue({ id: 1, description: "依頼者: <@U0ABC123>" })],
    getProjectMetadata: emptyMetadata
  };
  const mentions = { listCandidates: async () => { throw new Error("db down"); } };
  const res = await request(app({ role: "legal", client, mentions })).get("/api/v2/backlog/issues");
  assert.equal(res.status, 200);
  assert.equal(res.body.issues[0].description, "依頼者: @U0ABC123");
});

test("Backlog APIエラーは502", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => { throw new BacklogApiError(403); },
    getProjectMetadata: emptyMetadata
  };
  const res = await request(app({ role: "legal", client })).get("/api/v2/backlog/issues");
  assert.equal(res.status, 502);
  assert.equal(res.body.code, "BACKLOG_API_ERROR");
});

test("メタデータ: admin/legal以外は403", async () => {
  const res = await request(app({ role: "requester" })).get("/api/v2/backlog/metadata");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "BACKLOG_ROLE_REQUIRED");
});

test("メタデータ: クライアント未構成は enabled:false で空", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/backlog/metadata");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.deepEqual(res.body.statuses, []);
  assert.deepEqual(res.body.customFields, []);
});

test("メタデータ: legalは実IDを取得できる", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => [],
    getProjectMetadata: async () => ({
      statuses: [{ id: 1, name: "未対応" }, { id: 4, name: "完了" }],
      customFields: [{ id: 101, name: "契約種別", typeId: 6 }]
    })
  };
  const res = await request(app({ role: "legal", client })).get("/api/v2/backlog/metadata");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.statuses.length, 2);
  assert.equal(res.body.statuses[1].id, 4);
  assert.equal(res.body.customFields[0].id, 101);
  assert.equal(res.body.customFields[0].typeId, 6);
});

test("メタデータ: Backlog APIエラーは502", async () => {
  const client: BacklogReadClient = {
    getProject: async () => ({ id: 1, projectKey: "LEGAL", name: "法務" }),
    getIssues: async () => [],
    getProjectMetadata: async () => { throw new BacklogApiError(403); }
  };
  const res = await request(app({ role: "admin", client })).get("/api/v2/backlog/metadata");
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
const stubCreateIssue = async () => ({ issueKey: "LEGAL-0" });
const okWriteClient: BacklogWriteClient = { addComment: async () => ({ id: 999 }), createIssue: stubCreateIssue };

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
  const client: BacklogWriteClient = { addComment: async (key, content) => { captured = { key, content }; return { id: 42 }; }, createIssue: stubCreateIssue };
  const res = await request(commentApp({ role: "admin", enabled: true, client }))
    .post("/api/v2/backlog/issues/LEGAL-9/comments").send({ content: "レビュー完了", confirmation: "COMMIT_BACKLOG_COMMENT" });
  assert.equal(res.status, 201);
  assert.equal(res.body.commentId, 42);
  assert.deepEqual(captured, { key: "LEGAL-9", content: "レビュー完了" });
});
