import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  PgConditionEconomicsRepository, MemoryConditionEconomicsRepository, createConditionEconomicsRouter,
  type ConditionEconomics
} from "./condition-economics.js";
import type { DatabasePool } from "../db/pool.js";

// 有効性（2026-09-02）: 巻き直しの旧版（superseded_by）・無効化文書の条件は
// 計算書の「条件から取得」で 409 になり、下地に使えない。

function poolFor(baseRow: Record<string, unknown>): DatabasePool {
  return {
    query: async (sql: string) => {
      if (/FROM condition_lines cl/.test(sql)) return { rows: [baseRow] };
      if (/FROM condition_events/.test(sql)) return { rows: [{ ag: "0", mg: "0", n: 0 }] };
      return { rows: [] };
    }
  } as unknown as DatabasePool;
}

const line = { id: 5, document_id: 9, group_no: null, line_no: 1, rate_pct: "5", mg_amount: "0", ag_amount: "0", currency: "JPY", condition_name: "原作" };

test("condition-economics: 有効な条件は effective=true", async () => {
  const repo = new PgConditionEconomicsRepository(poolFor({ ...line, lifecycle_status: null, superseded_by: null }));
  const economics = await repo.find(5);
  assert.equal(economics?.effective, true);
  assert.equal(economics?.ineffectiveReason, null);
});

test("condition-economics: 巻き直し旧版の条件は superseded・無効化文書は voided", async () => {
  const superseded = await new PgConditionEconomicsRepository(
    poolFor({ ...line, lifecycle_status: null, superseded_by: "LIC-2024-0012" })).find(5);
  assert.equal(superseded?.effective, false);
  assert.equal(superseded?.ineffectiveReason, "superseded");
  assert.equal(superseded?.supersededBy, "LIC-2024-0012");
  const voided = await new PgConditionEconomicsRepository(
    poolFor({ ...line, lifecycle_status: "voided", superseded_by: null })).find(5);
  assert.equal(voided?.ineffectiveReason, "voided");
});

test("condition-economics ルート: 無効な条件は 409 で止め、有効版の番号を案内する", async () => {
  const base: ConditionEconomics = {
    conditionLineId: 7, representativeLineId: 7, conditionName: "旧・原作", currency: "JPY",
    ratePct: 5, mgAmount: 0, agAmount: 0, agConsumed: 0, mgConsumed: 0, eventCount: 0, agRemaining: 0, groupSize: 1,
    effective: false, ineffectiveReason: "superseded", supersededBy: "LIC-2024-0012"
  };
  const app = express();
  app.use("/api/v2", createConditionEconomicsRouter(new MemoryConditionEconomicsRepository({ 7: base, 8: { ...base, effective: true, ineffectiveReason: null, supersededBy: null } })));
  const blocked = await request(app).get("/api/v2/royalty/condition-economics/7");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "CONDITION_LINE_INEFFECTIVE");
  assert.match(blocked.body.error, /LIC-2024-0012/);
  const ok = await request(app).get("/api/v2/royalty/condition-economics/8");
  assert.equal(ok.status, 200);
});
