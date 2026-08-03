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
