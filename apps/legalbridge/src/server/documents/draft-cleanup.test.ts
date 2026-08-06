import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createDocumentRouter } from "./routes.js";
import { MemoryDraftRepository } from "./draft-repository.js";
import { MemoryTemplateRepository } from "./template-repository.js";

async function seeded() {
  const drafts = new MemoryDraftRepository();
  await drafts.save({ issueKey: "A-1", templateType: "purchase_order", formData: {}, updatedBy: "a@example.com" });
  await drafts.save({ issueKey: "B-1", templateType: "purchase_order", formData: {}, updatedBy: "b@example.com" });
  return drafts;
}

// リポジトリ単体。staleDays=-1 は cutoff を未来に置き、保存済み全件を確実に対象化する
// （境界0だと保存とcutoffが同msになりフレークするため）。owner スコープ挙動を検証。
test("listStale/purgeStale は owner でスコープする", async () => {
  const drafts = await seeded();
  assert.equal((await drafts.listStale(-1, "")).length, 2);
  assert.equal((await drafts.listStale(-1, "a@example.com")).length, 1);
  assert.equal(await drafts.purgeStale(-1, "a@example.com"), 1);
  assert.equal((await drafts.listStale(-1, "")).length, 1);
});

function appFor(drafts: MemoryDraftRepository, role: string) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@example.com", subject: "t", role, source: "test" } as never;
    next();
  });
  app.use("/api/v2", createDocumentRouter(new MemoryTemplateRepository([]), drafts, true));
  return app;
}

test("GET /document-drafts/stale は件数を返す", async () => {
  const app = appFor(await seeded(), "admin");
  const res = await request(app).get("/api/v2/document-drafts/stale?days=0");
  // days は 1..3650。0 は 400。
  assert.equal(res.status, 400);
  const ok = await request(app).get("/api/v2/document-drafts/stale?days=30");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.days, 30);
  assert.equal(typeof ok.body.count, "number");
});

test("POST /document-drafts/purge は削除件数を返す", async () => {
  const drafts = await seeded();
  const app = appFor(drafts, "admin");
  const bad = await request(app).post("/api/v2/document-drafts/purge").send({ days: 0 });
  assert.equal(bad.status, 400);
  // days=1 では今日保存の下書きは対象外（0件）。
  const res = await request(app).post("/api/v2/document-drafts/purge").send({ days: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.purgedCount, 0);
});

test("stale/purge は下書きワークスペース無効時403", async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.currentUser = { email: "u@example.com", subject: "t", role: "admin", source: "test" } as never; next(); });
  app.use("/api/v2", createDocumentRouter(new MemoryTemplateRepository([]), await seeded(), false));
  const res = await request(app).get("/api/v2/document-drafts/stale?days=30");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DRAFT_WORKSPACE_DISABLED");
});
