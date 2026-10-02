import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { AccountingExportRepository, documentTitleFrom } from "./accounting-repository.js";

/** 台帳から出した計算書の支払。案件が無く、実績も計算書に結ばれていない。 */
const payment = {
  id: 41, payment_no: "PAY-2026-01043", currency: "JPY", amount: 1352760, tax_amount: 135276,
  withholding_amount: 201756, due_on: "2026-10-20", paid_on: null, status: "planned",
  party_code: "V-1", party_name: "平沢 茂之", name_kana: null, party_kind: "individual",
  invoice_no: null, withholding: true, residency: null, treaty_rate_pct: null,
  treaty_docs_received_on: null, account_holder_kana: null,
  matter_no: null, matter_title: null, owner_name: null, owner_department: null
};

const db = (over: Record<string, any[]> = {}) => new FakeDatabase((t) => {
  for (const [fragment, rows] of Object.entries(over)) if (t.includes(fragment)) return rows;
  if (t.includes("FROM payments y")) return [payment];
  if (t.includes("FROM payment_allocations al\n    JOIN conditions c")) {
    return [{ payment_id: 41, amount: 1352760, condition_no: "CL-2026-00408", name: "自社製造・他社販売",
              tax_category: "taxable", kind: "license", currency: "JPY", unit_amount: null,
              quantity: null, occurred_on: "2026-09-30" }];
  }
  if (t.includes("FROM staff WHERE id = ANY")) return [{ id: 5, name: "加来 健", department: "ライセンス部" }];
  return [];
});

test("実績から書類に辿れない支払は、支払を立てたときの記録から書類を引く（件名・担当者も）", async () => {
  const repo = new AccountingExportRepository(db({
    "a.action = 'payment.create'": [{
      payment_id: 41, documents: 1, document_id: 900, document_no: "ARC-RS-2026-0123",
      template_key: "royalty_statement", owner_staff_id: 5,
      rendered_values: { 件名: "ゲームブック 利用許諾料のご報告" }
    }]
  }));
  const out = await repo.build({ from: "2026-10-01", to: "2026-10-31" });
  const group = out.groups[0]!;
  assert.equal(group.owner, "加来 健");
  const row = group.rows[0]!;
  assert.equal(row.documentNo, "ARC-RS-2026-0123");
  assert.equal(row.title, "ゲームブック 利用許諾料のご報告");
  assert.equal(row.department, "ライセンス部");
});

test("書類も担当も無ければ、これまでどおり条件名と「担当者未設定」", async () => {
  const out = await new AccountingExportRepository(db()).build({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(out.groups[0]!.owner, "(担当者未設定)");
  assert.equal(out.groups[0]!.rows[0]!.title, "自社製造・他社販売");
  assert.equal(out.groups[0]!.rows[0]!.documentNo, null);
});

test("案件の担当があればそちらが勝つ", async () => {
  const repo = new AccountingExportRepository(db({
    "FROM payments y": [{ ...payment, owner_name: "南", owner_department: "法務", matter_title: "案件A" }],
    "a.action = 'payment.create'": [{ payment_id: 41, documents: 1, document_id: 900, document_no: "ARC-RS-1",
      template_key: "royalty_statement", owner_staff_id: 5, rendered_values: { title: "紙の件名" } }]
  }));
  const out = await repo.build({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(out.groups[0]!.owner, "南");
  // 件名は紙に刷った件名（案件名より優先）。
  assert.equal(out.groups[0]!.rows[0]!.title, "紙の件名");
});

test("書類の件名は件名らしい欄を順に見る。無ければ原作名から作る", () => {
  assert.equal(documentTitleFrom({ PROJECT_TITLE: "保守", title: "" }), "保守");
  assert.equal(documentTitleFrom({ originalWork: "ゲームブック" }), "ゲームブック 利用許諾料");
  assert.equal(documentTitleFrom({}), null);
  assert.equal(documentTitleFrom(null), null);
});
