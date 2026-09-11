import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService, type ConditionInput } from "./write-service.js";

const base: ConditionInput = {
  name: "配信許諾", direction: "out", kind: "license", counterpartyId: 5,
  pricingModel: "revenue_rate", ratePpm: 125_000
};

const build = () => new FakeDatabase((text) => {
  if (text.includes("FROM parties WHERE id")) return [{ id: 5, name: "取引先A" }];
  if (text.includes("FROM works WHERE id")) return [{ id: 9 }];
  if (text.includes("FROM work_parts WHERE id")) return [{ id: 3 }];
  if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
  if (text.includes("UPDATE document_sequences")) return [{ current_value: 336 }];
  if (text.includes("FROM conditions WHERE condition_no")) return [];
  if (text.includes("INSERT INTO conditions")) return [{ id: 77, condition_no: "CL-2026-00336" }];
  return undefined;
});

test("採番して登録する", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).create(base, "kuramochi");
  assert.equal(r.id, 77);
  assert.equal(r.conditionNo, "CL-2026-00336");
  assert.ok(db.find("INSERT INTO audit_events"), "監査に残す");
});

test("値の無い計算方式は選べない", async () => {
  const svc = new ConditionWriteService(build());
  await assert.rejects(
    () => svc.create({ ...base, pricingModel: "unit_rate", ratePpm: null }, "k"),
    /単価を入れてください/);
  await assert.rejects(
    () => svc.create({ ...base, pricingModel: "fixed", ratePpm: null }, "k"),
    /定額を入れてください/);
  await assert.rejects(
    () => svc.create({ ...base, pricingModel: "revenue_rate", ratePpm: null }, "k"),
    /料率を入れてください/);
});

test("計算しない条件は値が無くてよい", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).create(
    { name: "無償許諾", direction: "out", kind: "license", counterpartyId: 5, pricingModel: "none" },
    "k");
  assert.equal(r.id, 77);
});

test("料率は 0〜100% に収める", async () => {
  const svc = new ConditionWriteService(build());
  await assert.rejects(() => svc.create({ ...base, ratePpm: 1_000_001 }, "k"), /0〜100%/);
  await assert.rejects(() => svc.create({ ...base, ratePpm: -1 }, "k"), /0〜100%/);
});

test("終了が開始より前なら受け付けない", async () => {
  const svc = new ConditionWriteService(build());
  await assert.rejects(
    () => svc.create({ ...base, termStart: "2026-04-01", termEnd: "2026-03-31" }, "k"),
    /終了日が開始日より前/);
});

test("作品なしでパートだけ指定できない", async () => {
  const svc = new ConditionWriteService(build());
  await assert.rejects(
    () => svc.create({ ...base, workPartId: 3 }, "k"), /作品も指定/);
});

test("知らない取引先には作れない", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM parties WHERE id") ? [] : undefined));
  await assert.rejects(
    () => new ConditionWriteService(db).create(base, "k"), /取引先 5 が見つかりません/);
});

test("許諾範囲も同じトランザクションで入れる", async () => {
  const db = build();
  await new ConditionWriteService(db).create(
    { ...base, scopes: [
      { scopeType: "region", label: "日本", code: "JP" },
      { scopeType: "language", label: "", code: null }   // 空は捨てる
    ] }, "k");
  const scopes = db.queries.filter((q) => q.text.includes("INSERT INTO condition_scopes"));
  assert.equal(scopes.length, 1, "空のラベルは入れない");
  assert.equal(scopes[0].params[2], "日本");
});
