import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createWorkWriteRouter } from "./write-routes.js";
import { MemoryWorkWriteRepository } from "./write-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const repository = new MemoryWorkWriteRepository();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "editor@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createWorkWriteRouter(repository, options.enabled));
  return { app, repository };
}

test("作品検証は作品名必須を課す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/works/validate").send({ title: "" });
  assert.equal(response.status, 400);
  assert.ok(response.body.errors.some((e: { field: string }) => e.field === "title"));
});

test("書込み無効時は作品作成を拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/works").send({ title: "新作品" });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "WORK_WRITE_UNAVAILABLE");
});

test("依頼者ロールは作品を編集できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).post("/api/v2/works").send({ title: "新作品" });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "WORK_EDIT_FORBIDDEN");
});

test("作品を作成し自動採番コードを返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/works").send({ title: "作品タイトル" });
  assert.equal(response.status, 201);
  assert.equal(typeof response.body.id, "number");
  assert.match(response.body.workCode, /^WRK-\d{5}$/);
});

test("存在しない作品の更新は404を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).patch("/api/v2/works/999").send({ title: "改題" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "WORK_NOT_FOUND");
});

test("作品を部分更新できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/works").send({ title: "旧題" });
  const response = await request(app).patch(`/api/v2/works/${created.body.id}`).send({ title: "新題", remarks: "更新" });
  assert.equal(response.status, 200);
  assert.equal(response.body.id, created.body.id);
});

test("kind: null は「変更しない」＝既存の区分を保持したまま保存できる（監査④）", async () => {
  const { app, repository } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/works").send({ title: "区分保持", kind: "licensed_in" });
  // 旧クライアント互換: kind: null を送っても 23502 で落とさず、区分は保持される。
  const response = await request(app).patch(`/api/v2/works/${created.body.id}`)
    .send({ title: "区分保持（改題）", kind: null });
  assert.equal(response.status, 200);
  assert.equal(repository.works.get(created.body.id)!.kind, "licensed_in");
  assert.equal(repository.works.get(created.body.id)!.title, "区分保持（改題）");
});

test("編集用に作品の生値を返す", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/works").send({ title: "生値作品", ledgerCode: "LG-1" });
  const response = await request(app).get(`/api/v2/works/${created.body.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.work.title, "生値作品");
  assert.equal(response.body.work.ledgerCode, "LG-1");
});

test("CSV一括取込は有効行を登録し無効行を報告する", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/works/import").send({
    rows: [
      { title: "作品A" },
      { title: "" },
      { title: "作品B", ledgerCode: "LG-2" }
    ]
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.insertedCount, 2);
  assert.equal(response.body.failedCount, 1);
  assert.equal(response.body.failed[0].index, 1);
});

test("作品一括取込は書込み無効時に拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/works/import").send({ rows: [{ title: "A" }] });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "WORK_WRITE_UNAVAILABLE");
});

test("依頼者ロールは作品の生値を取得できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).get("/api/v2/works/1");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "WORK_EDIT_FORBIDDEN");
});

test("拡張列（種別・系譜・権利者）を更新し生値で返す", async () => {
  const { app } = appFor({ enabled: true });
  const parent = await request(app).post("/api/v2/works").send({ title: "原作", isOriginal: true, kind: "own" });
  const child = await request(app).post("/api/v2/works").send({ title: "派生" });
  const patched = await request(app).patch(`/api/v2/works/${child.body.id}`).send({
    kind: "licensed_in", derivationType: "licensed_derivative", isOriginal: false,
    parentWorkId: parent.body.id, rightsHolderVendorId: 7, creatorName: "作者名", titleKana: "ハセイ"
  });
  assert.equal(patched.status, 200);
  const raw = await request(app).get(`/api/v2/works/${child.body.id}`);
  assert.equal(raw.body.work.kind, "licensed_in");
  assert.equal(raw.body.work.parentWorkId, parent.body.id);
  assert.equal(raw.body.work.rightsHolderVendorId, 7);
  assert.equal(raw.body.work.creatorName, "作者名");
  assert.equal(raw.body.work.titleKana, "ハセイ");
  assert.equal(raw.body.work.isOriginal, false);
});

test("親を自分自身に設定すると422（閉路防止）", async () => {
  const { app } = appFor({ enabled: true });
  const w = await request(app).post("/api/v2/works").send({ title: "自己" });
  const res = await request(app).patch(`/api/v2/works/${w.body.id}`).send({ parentWorkId: w.body.id });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "WORK_LINEAGE_CYCLE");
});

test("子孫を親に設定すると422（系譜循環）", async () => {
  const { app } = appFor({ enabled: true });
  const a = await request(app).post("/api/v2/works").send({ title: "A" });
  const b = await request(app).post("/api/v2/works").send({ title: "B" });
  // B の親を A にする（A→B）。
  await request(app).patch(`/api/v2/works/${b.body.id}`).send({ parentWorkId: a.body.id });
  // A の親を B にすると循環（A→B→A）。
  const res = await request(app).patch(`/api/v2/works/${a.body.id}`).send({ parentWorkId: b.body.id });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "WORK_LINEAGE_CYCLE");
});

test("親をnullでクリアできる", async () => {
  const { app } = appFor({ enabled: true });
  const parent = await request(app).post("/api/v2/works").send({ title: "親" });
  const child = await request(app).post("/api/v2/works").send({ title: "子", parentWorkId: parent.body.id });
  const res = await request(app).patch(`/api/v2/works/${child.body.id}`).send({ parentWorkId: null });
  assert.equal(res.status, 200);
  const raw = await request(app).get(`/api/v2/works/${child.body.id}`);
  assert.equal(raw.body.work.parentWorkId, null);
});

test("kindは列挙のみ許可", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/works/validate").send({ title: "x", kind: "invalid" });
  assert.equal(res.status, 400);
});

test("系譜関係(work_relations)を追加できる", async () => {
  const { app } = appFor({ enabled: true });
  const parent = await request(app).post("/api/v2/works").send({ title: "原作" });
  const child = await request(app).post("/api/v2/works").send({ title: "派生" });
  const res = await request(app).post("/api/v2/work-relations").send({ childWorkId: child.body.id, parentWorkId: parent.body.id });
  assert.equal(res.status, 201);
  assert.equal(res.body.created, true);
  // 重複は200・created:false（冪等）。
  const dup = await request(app).post("/api/v2/work-relations").send({ childWorkId: child.body.id, parentWorkId: parent.body.id });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.created, false);
});

test("系譜関係の自己参照は400", async () => {
  const { app } = appFor({ enabled: true });
  const w = await request(app).post("/api/v2/works").send({ title: "自己" });
  const res = await request(app).post("/api/v2/work-relations").send({ childWorkId: w.body.id, parentWorkId: w.body.id });
  assert.equal(res.status, 400);
});

test("系譜関係の循環は422", async () => {
  const { app } = appFor({ enabled: true });
  const a = await request(app).post("/api/v2/works").send({ title: "A" });
  const b = await request(app).post("/api/v2/works").send({ title: "B" });
  // B の親を A に（parent_work_id: A→B）。
  await request(app).patch(`/api/v2/works/${b.body.id}`).send({ parentWorkId: a.body.id });
  // A の派生元を B にすると循環。
  const res = await request(app).post("/api/v2/work-relations").send({ childWorkId: a.body.id, parentWorkId: b.body.id });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "WORK_LINEAGE_CYCLE");
});

test("系譜関係の追加は書込み無効時に拒否", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).post("/api/v2/work-relations").send({ childWorkId: 2, parentWorkId: 1 });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "WORK_WRITE_UNAVAILABLE");
});
