import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderPlan, draftInputFromOrder, type RawOrderCondition } from "./from-order.js";

const order = { id: 50, documentNo: "ARC-PO-2026-0050", title: "イベント運営", templateKey: "purchase_order", issuedOn: "2026-10-01",
                matterId: 9, agreementId: null, counterparty: { id: 3, name: "株式会社サンプル" } };
const cond = (over: Partial<RawOrderCondition>): RawOrderCondition => ({
  id: 1, conditionNo: "CL-1", name: "運営業務", kind: "service", currency: "JPY", flatAmount: 300000, unitAmount: null, quantity: null,
  timeSettlement: false, contractForm: "請負", closed: false, settledOnIssued: false, events: [], ...over
});
const raw = () => [
  cond({ events: [
    { id: 101, occurredOn: "2026-10-20", amount: 300000, quantity: 1, label: "当日運営", documentNo: null },
    { id: 100, occurredOn: "2026-09-20", amount: 50000, quantity: 1, label: "前回分", documentNo: "ARC-INS-2026-0001" }
  ] }),
  cond({ id: 2, conditionNo: "CL-2", name: "交通費", kind: "expense", flatAmount: 12000 }),
  cond({ id: 3, conditionNo: "CL-3", name: "手配手数料", kind: "fee", flatAmount: 5000 }),
  cond({ id: 4, conditionNo: "CL-4", name: "宿泊費", kind: "expense", flatAmount: 20000, settledOnIssued: true })
];

test("発注書の条件を 委託料（実績つき）と 実費・手数料 に分け、ひな形を決める", () => {
  const p = buildOrderPlan(order, raw());
  assert.deepEqual(p.lines.map((l) => l.conditionId), [1]);
  assert.equal(p.lines[0].openEvents, 1);
  assert.equal(p.lines[0].settled, false);
  assert.deepEqual(p.extras.map((x) => [x.conditionId, x.kind, x.plannedAmount, x.settled]),
    [[2, "expense", 12000, false], [3, "fee", 5000, false], [4, "expense", 20000, true]]);
  assert.equal(p.templateKey, "inspection_certificate");
  assert.deepEqual(p.warnings, []);
});

test("準委任・時間精算は役務提供完了通知書、海外の発注書は海外の検収書", () => {
  assert.equal(buildOrderPlan(order, [cond({ contractForm: "準委任" })]).templateKey, "service_completion_notice");
  assert.equal(buildOrderPlan({ ...order, templateKey: "intl_purchase_order" }, raw()).templateKey, "intl_inspection_certificate");
});

test("実績の無い委託料・全部検収済みは注意を出す", () => {
  assert.match(buildOrderPlan(order, [cond({})]).warnings.join(), /実績が無い条件があります/);
  const done = buildOrderPlan(order, [cond({ events: [{ id: 1, occurredOn: null, amount: 1, quantity: null, label: null, documentNo: "X" }] })]);
  assert.match(done.warnings.join(), /すべて検収済み/);
});

test("かかった実費だけを実額で載せ、今回はかからなかった実費は載せない。以後も発生しない実費は決定時に完了扱い", () => {
  const p = buildOrderPlan(order, raw());
  const d = draftInputFromOrder(p, {
    eventIds: [101],
    extras: [
      { conditionId: 2, kind: "expense", name: "交通費", status: "incurred", amount: 8420, spentOn: "2026-10-20", remarks: "東京⇔大阪" },
      { conditionId: 3, kind: "fee", name: "手配手数料", status: "none" },
      { conditionId: null, kind: "expense", name: "駐車場代", status: "incurred", amount: 1500 }
    ]
  });
  assert.equal(d.templateKey, "inspection_certificate");
  assert.deepEqual(d.conditionIds, [1, 2], "委託料＋かかった発注書の実費（追加の実費は決定のとき条件になる）");
  assert.deepEqual(d.eventIds, [101]);
  assert.equal(d.matterId, 9);
  const m = d.manualInputs as any;
  assert.deepEqual(m.expenses, [
    { condition_id: 2, expense_name: "交通費", amount_inc_tax: 8420, spent_date: "2026-10-20", remarks: "東京⇔大阪" },
    { expense_name: "駐車場代", amount_inc_tax: 1500, spent_date: null, remarks: "" }
  ]);
  assert.deepEqual(m.other_fees, [], "かからなかった手数料は載せない（空でも渡して、条件から見込みの行を起こさせない）");
  assert.deepEqual(m._eventIds, [101]);
  assert.deepEqual(m._closeExtrasOnIssue, [3]);
  assert.equal(m._fromOrderId, 50);
});

test("実額の無い「かかった」・ほかの発注書の条件・検収済みの実績は弾く", () => {
  const p = buildOrderPlan(order, raw());
  assert.throws(() => draftInputFromOrder(p, { eventIds: [101], extras: [{ conditionId: 2, kind: "expense", name: "交通費", status: "incurred", amount: 0 }] }),
    /実額を入れてください/);
  assert.throws(() => draftInputFromOrder(p, { eventIds: [101], extras: [{ conditionId: 99, kind: "expense", name: "x", status: "skip" }] }),
    /この発注書のものではありません/);
  assert.throws(() => draftInputFromOrder(p, { eventIds: [100], extras: [] }), /もう決済文書に結んであります/);
  assert.throws(() => draftInputFromOrder(p, { eventIds: [999], extras: [] }), /この発注書の条件のものではありません/);
});

test("実績を選ばなければ、実績の残っている委託料を載せる", () => {
  const p = buildOrderPlan(order, raw());
  assert.deepEqual(draftInputFromOrder(p, { eventIds: [], extras: [] }).conditionIds, [1]);
});
