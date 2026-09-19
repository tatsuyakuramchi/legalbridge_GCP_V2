import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService, type ServiceSetInput } from "./write-service.js";

/**
 * 業務セット：業務1つ（案件×契約×相手先）で 委託料＋実費＋手数料 を N 本。
 */
const base: ServiceSetInput = {
  matterId: 501, title: "英語版 翻訳", counterpartyId: 5, agreementId: 3,
  termStart: "2026-10-01", termEnd: "2027-03-31", paymentTerms: "検収月の翌月末",
  contractForm: "ukeoi", deliverableOwnership: "orderer",
  rows: [
    { kind: "service", pricingModel: "unit_rate", unitAmount: 12, quantity: 10000, spec: "英訳・校正込み" },
    { kind: "expense", flatAmount: 30000, notes: "上限" },
    { kind: "fee", name: "振込手数料", flatAmount: 440 }
  ]
};

const build = () => {
  let next = 100;
  return new FakeDatabase((text) => {
    if (text.includes("FROM parties WHERE id")) return [{ id: 5, name: "受託者" }];
    if (text.includes("SELECT id FROM matters WHERE id")) return [{ id: 501 }];
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) return [{ current_value: next }];
    if (text.includes("FROM conditions WHERE condition_no")) return [];
    if (text.includes("INSERT INTO conditions")) { next += 1; return [{ id: next, condition_no: `CL-2026-00${next}` }]; }
    return undefined;
  });
};

test("委託料・実費・手数料を1トランザクションで作り、案件に繋ぐ。名前は業務名から付く", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).createServiceSet(base, "k");
  assert.deepEqual(r.conditions.map((c) => [c.usageType, c.id]), [["service", 101], ["expense", 102], ["fee", 103]]);
  const inserts = db.queries.filter((q) => q.text.includes("INSERT INTO conditions"));
  // [kind, name, pricing_model, unit_amount, flat_amount, tax_category, contract_form, deliverable_ownership, quantity]
  assert.deepEqual(inserts.map((q) => [q.params[3], q.params[4], q.params[14], q.params[16], q.params[17], q.params[20],
                                       q.params[28], q.params[25], q.params[27]]),
    [["service", "英語版 翻訳", "unit_rate", 12, 120000, "taxable", "ukeoi", "orderer", 10000],
     ["expense", "英語版 翻訳 実費", "fixed", null, 30000, "exempt", null, null, null],
     ["fee", "振込手数料", "fixed", null, 440, "taxable", null, null, null]]);
  assert.ok(inserts.every((q) => q.params[2] === "in" && q.params[5] === 5 && q.params[1] === 3), "全部 受け・同じ相手先・同じ契約");
  assert.equal(db.queries.filter((q) => q.text.includes("INSERT INTO matter_links")).length, 3, "3本とも案件に繋ぐ");
  assert.ok(db.texts.includes("COMMIT"));
});

test("委託料の行が無い・業務名が空なら止める", async () => {
  const svc = new ConditionWriteService(build());
  await assert.rejects(() => svc.createServiceSet({ ...base, rows: [{ kind: "expense", flatAmount: 1 }] }, "k"), /委託料の行/);
  await assert.rejects(() => svc.createServiceSet({ ...base, title: " " }, "k"), /業務名/);
});
