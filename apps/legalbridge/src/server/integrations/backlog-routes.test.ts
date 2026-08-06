import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createBacklogRequestRouter } from "./backlog-routes.js";
import { BacklogApiError, type BacklogReadClient, type BacklogIssueSummary } from "./backlog-web-api.js";

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
