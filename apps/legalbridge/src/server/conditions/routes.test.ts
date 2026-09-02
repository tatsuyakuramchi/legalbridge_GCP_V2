import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createConditionLineRouter } from "./routes.js";
import { MemoryConditionLineRepository, type ConditionLineRow } from "./repository.js";

function row(overrides: Partial<ConditionLineRow>): ConditionLineRow {
  return {
    id: 1, lineNo: 1, documentId: 10, documentNumber: "DOC-1", matterId: 5, templateType: "license",
    direction: "receivable", flowDirection: "out", transactionKind: "license", conditionName: "許諾A",
    vendorName: "取引先X", workTitle: "作品Y", territory: "日本", currency: "JPY",
    amountExTax: 100000, mgAmount: null, ratePct: 10, termStart: "2026-01-01",
    effective: true, supersededBy: null,
    ...overrides
  };
}

function appFor(rows: ConditionLineRow[] | undefined) {
  const app = express();
  app.use("/api/v2", createConditionLineRouter(
    rows === undefined ? undefined : new MemoryConditionLineRepository(rows)
  ));
  return app;
}

test("リポジトリ未接続時は503を返す", async () => {
  const response = await request(appFor(undefined)).get("/api/v2/condition-lines");
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CONDITION_LINES_UNAVAILABLE");
});

test("条件明細一覧を返す", async () => {
  const response = await request(appFor([row({ id: 1 }), row({ id: 2, conditionName: "支払B", direction: "payable" })]))
    .get("/api/v2/condition-lines");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
});

test("キーワードで絞り込む", async () => {
  const response = await request(appFor([
    row({ id: 1, conditionName: "許諾A" }),
    row({ id: 2, conditionName: "支払B", vendorName: "別会社" })
  ])).get("/api/v2/condition-lines?q=許諾");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].conditionName, "許諾A");
});

test("存在しない条件明細の詳細は404を返す", async () => {
  const response = await request(appFor([row({ id: 1 })])).get("/api/v2/condition-lines/999");
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "CONDITION_LINE_NOT_FOUND");
});

test("条件明細の詳細を返す", async () => {
  const response = await request(appFor([row({ id: 7, conditionName: "許諾C" })])).get("/api/v2/condition-lines/7");
  assert.equal(response.status, 200);
  assert.equal(response.body.detail.id, 7);
  assert.equal(response.body.detail.conditionName, "許諾C");
  assert.ok(Array.isArray(response.body.detail.regions));
  assert.ok(Array.isArray(response.body.detail.languages));
  // consumption is null without a DB-backed settlement source (grant 011).
  assert.equal(response.body.detail.consumption, null);
});

test("作品IDが無ければ重複チェックは400を返す", async () => {
  const response = await request(appFor([])).get("/api/v2/condition-lines/overlap");
  assert.equal(response.status, 400);
});

test("作品の既存条件を向き別件数と一覧で返す（重複警告）", async () => {
  const app = express();
  app.use("/api/v2", createConditionLineRouter(new MemoryConditionLineRepository([], [
    { workId: 3, id: 1, conditionName: "既存受取", direction: "receivable", flowDirection: "out", sourceMaterialId: null, materialName: null, amountExTax: 100000, mgAmount: null, currency: "JPY", documentNumber: "DOC-1" },
    { workId: 3, id: 2, conditionName: "素材コスト", direction: "payable", flowDirection: "in", sourceMaterialId: 9, materialName: "第1原稿", amountExTax: 20000, mgAmount: null, currency: "JPY", documentNumber: "DOC-2" },
    { workId: 4, id: 3, conditionName: "別作品", direction: "receivable", flowDirection: "out", sourceMaterialId: null, materialName: null, amountExTax: 1, mgAmount: null, currency: "JPY", documentNumber: null }
  ])));
  const response = await request(app).get("/api/v2/condition-lines/overlap?workId=3");
  assert.equal(response.status, 200);
  assert.equal(response.body.overlap.total, 2);
  assert.equal(response.body.overlap.receivableCount, 1);
  assert.equal(response.body.overlap.payableCount, 1);
  assert.equal(response.body.overlap.lines[0].sourceMaterialId, null);
});

test("集計サマリを向き・通貨で返す", async () => {
  const response = await request(appFor([
    row({ id: 1, direction: "receivable", currency: "JPY", amountExTax: 100000, mgAmount: 0 }),
    row({ id: 2, direction: "receivable", currency: "JPY", amountExTax: 50000, mgAmount: 0 }),
    row({ id: 3, direction: "payable", currency: "JPY", amountExTax: 30000, mgAmount: 0 })
  ])).get("/api/v2/condition-lines/summary");
  assert.equal(response.status, 200);
  const receivable = response.body.groups.find((g: { direction: string }) => g.direction === "receivable");
  assert.equal(receivable.lineCount, 2);
  assert.equal(receivable.totalAmount, 150000);
  const payable = response.body.groups.find((g: { direction: string }) => g.direction === "payable");
  assert.equal(payable.totalAmount, 30000);
  // settlement is null without the granted settlement tables (grant 011).
  assert.equal(response.body.settlement, null);
});

// --- 相手方補修（Phase 17・PATCH /condition-lines/:id/counterparty） ---

function repairApp(rows: ConditionLineRow[], opts: { enabled?: boolean; role?: string } = {}) {
  const repo = new MemoryConditionLineRepository(rows, [], new Map([[7, "新取引先"]]));
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@example.com", subject: "t", role: opts.role ?? "legal", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createConditionLineRouter(repo, opts.enabled ?? true));
  return { app, repo };
}

test("相手方補修: 未有効なら503", async () => {
  const { app } = repairApp([row({ vendorName: "" })], { enabled: false });
  const res = await request(app).patch("/api/v2/condition-lines/1/counterparty").send({ vendorId: 7 });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "CONDITION_REPAIR_UNAVAILABLE");
});

test("相手方補修: requester ロールは403", async () => {
  const { app } = repairApp([row({ vendorName: "" })], { role: "requester" });
  const res = await request(app).patch("/api/v2/condition-lines/1/counterparty").send({ vendorId: 7 });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "CONDITION_REPAIR_ROLE_REQUIRED");
});

test("相手方補修: 設定に成功し取引先名を返す", async () => {
  const { app, repo } = repairApp([row({ vendorName: "" })]);
  const res = await request(app).patch("/api/v2/condition-lines/1/counterparty").send({ vendorId: 7 });
  assert.equal(res.status, 200);
  assert.equal(res.body.vendorName, "新取引先");
  assert.equal((await repo.find(1))?.vendorName, "新取引先");
});

test("相手方補修: 存在しない取引先は400・存在しない明細は404", async () => {
  const { app } = repairApp([row({})]);
  const bad = await request(app).patch("/api/v2/condition-lines/1/counterparty").send({ vendorId: 99 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "VENDOR_NOT_FOUND");
  const missing = await request(app).patch("/api/v2/condition-lines/999/counterparty").send({ vendorId: 7 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "LINE_NOT_FOUND");
});
