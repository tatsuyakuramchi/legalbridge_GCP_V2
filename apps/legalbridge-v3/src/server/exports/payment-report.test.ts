import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PaymentReportRepository } from "./payment-report.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, payment_no: "PAY-2026-00001", currency: "JPY",
  amount: 300000, tax_amount: 30000, withholding_amount: 30630,
  due_on: new Date(2026, 8, 30), paid_on: new Date(2026, 8, 28), status: "paid",
  note: null, party_id: 5, party_name: "フリーランス太郎", party_kind: "individual",
  invoice_no: "T1", conditions: "CL-2026-00001", ...over
});

const build = (rows: any[]) =>
  new PaymentReportRepository(new FakeDatabase((t) => (t.includes("FROM payments") ? rows : undefined)));

test("相手先ごとにまとめ、明細から合計を足し直す", async () => {
  const r = await build([
    row(), row({ id: 2, payment_no: "PAY-2026-00002", amount: 100000, tax_amount: 10000, withholding_amount: 10210 })
  ]).build({ from: "2026-09-01", to: "2026-09-30" });

  assert.equal(r.groups.length, 1);
  const g = r.groups[0];
  assert.equal(g.lines.length, 2);
  assert.equal(g.total.amount, 400000);
  assert.equal(g.total.withholdingAmount, 40840);
  assert.equal(g.total.netAmount, 400000 + 40000 - 40840, "差引＝税抜＋消費税−源泉");
  assert.equal(r.count, 2);
});

test("相手先が違えば分ける", async () => {
  const r = await build([row(), row({ id: 2, party_id: 9, party_name: "株式会社甲", party_kind: "corporate" })])
    .build({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(r.groups.length, 2);
  assert.deepEqual(r.groups.map((g) => g.partyName), ["フリーランス太郎", "株式会社甲"]);
});

test("既定は支払日で切る。経理の月次はこちら", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM payments") ? [] : undefined));
  await new PaymentReportRepository(db).build({ from: "2026-09-01", to: "2026-09-30" });
  assert.match(db.find("FROM payments")!.text, /y\.paid_on BETWEEN/);
});

test("期日で切ることもできる。これから払う分の確認", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM payments") ? [] : undefined));
  await new PaymentReportRepository(db).build({ from: "2026-09-01", to: "2026-09-30", basis: "due" });
  assert.match(db.find("FROM payments")!.text, /y\.due_on BETWEEN/);
});

test("支払う側だけを対象にする。入金は報告書に混ぜない", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM payments") ? [] : undefined));
  await new PaymentReportRepository(db).build({ from: "2026-09-01", to: "2026-09-30" });
  assert.match(db.find("FROM payments")!.text, /direction = 'out'/);
});

test("該当が無ければ空で返す。0件と失敗を取り違えない", async () => {
  const r = await build([]).build({ from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(r.groups, []);
  assert.deepEqual(r.totals, []);
  assert.equal(r.count, 0);
});

test("通貨をまたいで足さない。混ざった合計は意味を持たない", async () => {
  const r = await build([
    row(),
    row({ id: 2, party_id: 9, party_name: "海外社", party_kind: "corporate",
          currency: "USD", amount: 100000, tax_amount: 0, withholding_amount: 0 })
  ]).build({ from: "2026-09-01", to: "2026-09-30" });

  assert.equal(r.totals.length, 2);
  const jpy = r.totals.find((t) => t.currency === "JPY")!;
  const usd = r.totals.find((t) => t.currency === "USD")!;
  assert.equal(jpy.amount, 300000);
  assert.equal(usd.amount, 100000);
  assert.equal(r.count, 2);
});
