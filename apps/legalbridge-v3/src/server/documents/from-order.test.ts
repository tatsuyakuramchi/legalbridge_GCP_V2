import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderPlan, draftInputFromOrder, OrderSettlementService, type RawOrderCondition } from "./from-order.js";
import { FakeDatabase } from "../core/fake-db.js";

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

// ---- 単体契約（業務委託契約書に条件が直接付いたもの）から作る ----

const standalone = { ...order, id: 77, documentNo: "ARC-SV-2026-0077", templateKey: "standalone", agreementId: 77, source: "agreement" as const };

test("単体契約から：組の作り方は発注書と同じで、注意と目印は単体契約の言葉になる", () => {
  const p = buildOrderPlan(standalone, raw());
  assert.equal(p.templateKey, "inspection_certificate");
  assert.match(buildOrderPlan(standalone, []).warnings.join(), /この単体契約には委託料の条件が結ばれていません/);
  const d = draftInputFromOrder(p, { eventIds: [101], extras: [] });
  assert.equal(d.manualInputs._fromAgreementId, 77, "起点は単体契約");
  assert.equal(d.manualInputs._fromOrderId, undefined);
  assert.equal(d.agreementId, 77, "検収書は単体契約に結ぶ（発注番号は単体契約の番号になる）");
  assert.throws(() => draftInputFromOrder(p, { eventIds: [999], extras: [] }), /この単体契約の条件のものではありません/);
});

const agreementDb = (head: Record<string, unknown> | null, conds: Array<Record<string, unknown>> = [], events: Array<Record<string, unknown>> = []) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM agreements a LEFT JOIN parties p")) return head ? [head] : [];
    if (t.includes("WHERE c.agreement_id = $1")) return conds;
    if (t.includes("FROM condition_events e")) return events;
    return undefined;
  });
const head = { id: 77, agreement_no: "ARC-SV-2026-0077", title: "店舗内装デザイン業務委託契約", status: "executed", direction: "in",
               executed_on: "2026-09-01", kind: "standalone", parent_id: null, order_document_id: null, counterparty_id: 3, counterparty: "株式会社サンプル" };

test("単体契約から：契約に直接載った条件と、系列ぜんぶの実績を引く", async () => {
  const db = agreementDb(head, [
    { id: 11, condition_no: "CL-11", name: "デザイン業務", kind: "service", currency: "JPY", flat_amount: 500000, unit_amount: null, quantity: null,
      time_settlement: false, contract_form: "請負", status: "active", closed: false, lineage: [10, 11], settled_on_issued: false, matter_id: 9 },
    { id: 12, condition_no: "CL-12", name: "交通費", kind: "expense", currency: "JPY", flat_amount: 8000, unit_amount: null, quantity: null,
      time_settlement: false, contract_form: null, status: "active", closed: false, lineage: [12], settled_on_issued: false, matter_id: null }
  ], [{ id: 201, condition_id: 10, occurred_on: "2026-10-01", amount: 500000, quantity: 1, label: "納品", document_no: null }]);
  const p = await new OrderSettlementService(db).planForAgreement(77);
  assert.equal(p.order.source, "agreement");
  assert.equal(p.order.agreementId, 77);
  assert.equal(p.order.matterId, 9, "案件は条件の繋がりから");
  assert.deepEqual(p.lines.map((l) => [l.conditionId, l.events.map((e) => e.id)]), [[11, [201]]], "前の版（10）の実績も載る");
  assert.deepEqual(p.extras.map((x) => x.conditionId), [12]);
  const q = db.find("WHERE c.agreement_id = $1")!;
  assert.ok(q.text.includes("c.kind IN ('service', 'expense', 'fee')"), "利用許諾の条件は載せない");
});

test("単体契約から：基本契約・未締結・受け取る側は断る", async () => {
  const svc = (over: Record<string, unknown>) => new OrderSettlementService(agreementDb({ ...head, ...over }));
  await assert.rejects(svc({ kind: "master" }).planForAgreement(77), /単体契約を選んでください/);
  await assert.rejects(svc({ order_document_id: 5 }).planForAgreement(77), /単体契約を選んでください/, "発注書の器は発注書から");
  await assert.rejects(svc({ status: "negotiating" }).planForAgreement(77), /締結済みの単体契約/);
  await assert.rejects(svc({ direction: "out" }).planForAgreement(77), /支払う側/);
  await assert.rejects(new OrderSettlementService(agreementDb(null)).planForAgreement(77), /見つかりません/);
});

test("作る画面の候補：決定した発注書と、締結済みの単体契約の両方", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM documents d")) return [{ id: 50, document_no: "ARC-PO-2026-0050", title: "イベント運営", counterparty: "A社", issued_on: "2026-10-01", template_key: "purchase_order" }];
    if (t.includes("FROM agreements a")) return [{ id: 77, agreement_no: "ARC-SV-2026-0077", title: "業務委託契約", counterparty: "B社", executed_on: "2026-09-01" }];
    return undefined;
  });
  const r = await new OrderSettlementService(db).search("");
  assert.deepEqual(r.map((x) => [x.source, x.id]), [["order", 50], ["agreement", 77]]);
  assert.ok(db.find("FROM agreements a")!.text.includes("a.status = 'executed' AND a.direction = 'in'"));
});
