import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createSnippetsRouter } from "./snippets-routes.js";
import { MemorySnippetsRepository } from "./snippets-repository.js";

function seedRows() {
  return [
    { id: 1, category: "special_terms", title: "秘密保持条項", body: "本契約の内容は…", sortOrder: 0, isActive: true },
    { id: 2, category: "work_item", title: "イラスト制作", body: "キャラクターイラスト1点", sortOrder: 0, isActive: true },
    { id: 3, category: "special_terms", title: "旧・廃止済み", body: "使わない", sortOrder: 0, isActive: false }
  ];
}

function appFor(opts: { enabled?: boolean; role?: string; forbidden?: boolean } = {}) {
  const repository = new MemorySnippetsRepository(seedRows(), opts.forbidden ?? false);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createSnippetsRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("スニペット: 全ロールが有効行のみ読める（requester含む）", async () => {
  const res = await request(appFor({ role: "requester" }).app).get("/api/v2/snippets").expect(200);
  assert.equal(res.body.snippets.length, 2);
  assert.equal(res.body.writeEnabled, false);
  assert.ok(!res.body.snippets.some((s: { id: number }) => s.id === 3));
});

test("スニペット: category → sort_order 順で返す", async () => {
  const res = await request(appFor({}).app).get("/api/v2/snippets").expect(200);
  assert.deepEqual(res.body.snippets.map((s: { id: number }) => s.id), [1, 2]);
});

test("スニペット: 書込無効時は503（保存）", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .post("/api/v2/snippets").send({ title: "X" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SNIPPETS_WRITE_UNAVAILABLE");
});

test("スニペット: requester は編集403", async () => {
  const res = await request(appFor({ enabled: true, role: "requester" }).app)
    .post("/api/v2/snippets").send({ title: "X" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "SNIPPETS_FORBIDDEN");
});

test("スニペット: 新規追加（insert）", async () => {
  const target = appFor({ enabled: true, role: "legal" });
  const res = await request(target.app).post("/api/v2/snippets")
    .send({ category: "other", title: "支払条件", body: "月末締め翌月末払い", sortOrder: 5 }).expect(200);
  assert.equal(res.body.mode, "insert");
  const list = await target.repository.list();
  assert.ok(list.some((s) => s.title === "支払条件" && s.sortOrder === 5));
});

test("スニペット: 既存更新（update）", async () => {
  const target = appFor({ enabled: true });
  const res = await request(target.app).post("/api/v2/snippets")
    .send({ id: 1, category: "special_terms", title: "秘密保持条項（改訂）", body: "改訂本文" }).expect(200);
  assert.equal(res.body.mode, "update");
  const list = await target.repository.list();
  assert.equal(list.find((s) => s.id === 1)?.title, "秘密保持条項（改訂）");
});

test("スニペット: タイトル必須（400）", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/snippets").send({ title: "  ", body: "本文だけ" });
  assert.equal(res.status, 400);
});

test("スニペット: 不正カテゴリは400", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/snippets").send({ title: "X", category: "bogus" });
  assert.equal(res.status, 400);
});

test("スニペット: 存在しないIDの更新は404", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/snippets").send({ id: 999, title: "X" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "SNIPPET_NOT_FOUND");
});

test("スニペット: 無効化（論理削除）で一覧から消える", async () => {
  const target = appFor({ enabled: true });
  await request(target.app).post("/api/v2/snippets/2/deactivate").expect(200);
  const list = await target.repository.list();
  assert.ok(!list.some((s) => s.id === 2));
});

test("スニペット: 無効化済みの再無効化は404", async () => {
  const res = await request(appFor({ enabled: true }).app).post("/api/v2/snippets/3/deactivate");
  assert.equal(res.status, 404);
});

test("スニペット: 不正IDの無効化は400", async () => {
  const res = await request(appFor({ enabled: true }).app).post("/api/v2/snippets/abc/deactivate");
  assert.equal(res.status, 400);
});

test("スニペット: 権限未整備(FORBIDDEN_DB)は503", async () => {
  const res = await request(appFor({ enabled: true, forbidden: true }).app)
    .post("/api/v2/snippets").send({ title: "X" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SNIPPETS_FORBIDDEN_DB");
});
