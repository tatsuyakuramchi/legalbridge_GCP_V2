import test from "node:test";
import assert from "node:assert/strict";
import { contactPlan, noticeContactOf, payOnChanges } from "./write-back.js";

const condition = { id: 5, name: "原稿制作", kind: "service", counterparty: { id: 9, kind: "corporate", name: "株式会社A" } };
const orderContext = {
  condition, conditions: [condition],
  schedules: [
    { id: 11, conditionId: 5, seq: 1, label: "原稿", plannedAmount: 300000, dueOn: "2026-06-30", payOn: "2026-07-31", triggerKind: "on_delivery" },
    { id: 12, conditionId: 5, seq: 2, label: "修正", plannedAmount: 100000, dueOn: "2026-08-31", payOn: "2026-09-30", triggerKind: "on_delivery" }
  ]
};

test("発注書：行で直した支払日はその回の予定へ。既定のままの行は書き戻さない", () => {
  const manual = { items: [
    { condition_id: 5, schedule_id: 11, payment_date: "2026-08-20" },
    { condition_id: 5, schedule_id: 12, payment_date: "2026-09-30" }
  ] };
  assert.deepEqual(payOnChanges("purchase_order", manual, orderContext),
    [{ scheduleId: 11, conditionId: 5, eventIds: [], from: "2026-07-31", to: "2026-08-20", source: "line" }]);
});

test("発注書：回の無い古い下書きの行は、条件の回が 1 つならその回。2 つ以上なら決められないので触らない", () => {
  const one = { ...orderContext, schedules: [orderContext.schedules[0]] };
  assert.equal(payOnChanges("purchase_order", { items: [{ condition_id: 5, payment_date: "2026-08-20" }] }, one)[0]?.scheduleId, 11);
  assert.deepEqual(payOnChanges("purchase_order", { items: [{ condition_id: 5, payment_date: "2026-08-20" }] }, orderContext), []);
  // 何回分かを 1 行にまとめた行（期間の支払日）は書き戻さない。
  assert.deepEqual(payOnChanges("purchase_order", { items: [{ condition_id: 5, schedule_id: 11, folded: true, payment_date: "2026-08-20" }] }, orderContext), []);
});

const inspectionContext = {
  condition, conditions: [condition],
  schedules: orderContext.schedules,
  events: [
    { id: 70, conditionId: 5, eventType: "delivery", occurredOn: "2026-06-10", amount: 300000, schedule: { id: 11, seq: 1, payOn: "2026-07-31" } },
    { id: 71, conditionId: 5, eventType: "delivery", occurredOn: "2026-06-12", amount: 50000, schedule: null }
  ]
};

test("検収書：行で直した支払日は、その実績の回の予定と支払へ。予定の無い実績は支払だけ", () => {
  const manual = { delivery_line_items: [
    { event_id: 70, payment_date: "2026-08-20" },
    { event_id: 71, payment_date: "2026-08-25" }
  ] };
  assert.deepEqual(payOnChanges("inspection_certificate", manual, inspectionContext), [
    { scheduleId: 11, conditionId: 5, eventIds: [70], from: "2026-07-31", to: "2026-08-20", source: "line" },
    { scheduleId: null, conditionId: 5, eventIds: [71], from: "2026-07-31", to: "2026-08-25", source: "line" }
  ]);
});

test("検収書：行の支払日が納品日からの既定のままなら、予定の支払日と違っても書き戻さない", () => {
  // 法人・6/10 納品の既定は 7/31。予定の支払日（ここでは 7/31）と同じでも違っても、人が直したとは限らない。
  const ctx = { ...inspectionContext, events: [{ ...inspectionContext.events[0], schedule: { id: 11, seq: 1, payOn: "2026-08-15" } }] };
  assert.deepEqual(payOnChanges("inspection_certificate", { delivery_line_items: [{ event_id: 70, payment_date: "2026-07-31" }] }, ctx), []);
});

test("頭書きの支払日は、行で直していない実績に効く", () => {
  const changes = payOnChanges("service_completion_notice", { sc_payment_date: "2026-08-31" }, inspectionContext);
  assert.deepEqual(changes.map((c) => [c.scheduleId, c.eventIds, c.to, c.source]),
    [[11, [70], "2026-08-31", "header"], [null, [71], "2026-08-31", "header"]]);
  assert.deepEqual(payOnChanges("royalty_statement", { paymentDueDate: "2026-07-31" }, { events: [inspectionContext.events[0]] }), [],
    "予定と同じ日なら何もしない");
});

test("通知先：相手方の欄から読む。許諾者の欄は相手方が許諾者（IN）のときだけ", () => {
  assert.deepEqual(noticeContactOf({ NOTICE_CONTACT_NAME: "山田 花子", NOTICE_CONTACT_EMAIL: "h@a.jp" }, false),
    { department: null, name: "山田 花子", email: "h@a.jp", phone: null });
  const pub = { licensorContact: "編集部 ／ 佐藤 一郎 ／ s@a.jp ／ 03-1234-5678" };
  assert.deepEqual(noticeContactOf(pub, true), { department: "編集部", name: "佐藤 一郎", email: "s@a.jp", phone: "03-1234-5678" });
  assert.equal(noticeContactOf(pub, false), null, "OUT の文書の許諾者は当社");
  assert.equal(noticeContactOf({}, true), null);
});

test("通知先：同じ人がいれば違うところを直して主担当に、いなければ足す。同じなら何もしない", () => {
  const stored = [
    { id: 1, name: "山田 花子", email: "old@a.jp", phone: null, department: null, roles: ["signer"] },
    { id: 2, name: "鈴木", email: "s@a.jp", phone: null, department: null, roles: ["primary"] }
  ];
  assert.deepEqual(contactPlan(stored, { department: null, name: "山田　花子", email: "h@a.jp", phone: null }),
    { kind: "update", id: 1, set: { email: "h@a.jp" }, makePrimary: true });
  assert.deepEqual(contactPlan(stored, { department: null, name: "鈴木", email: "s@a.jp", phone: null }), { kind: "none" });
  assert.deepEqual(contactPlan(stored, { department: null, name: "田中", email: null, phone: null }), { kind: "insert" });
  assert.deepEqual(contactPlan(stored, { department: null, name: null, email: "S@A.JP", phone: "03" }),
    { kind: "update", id: 2, set: { phone: "03" }, makePrimary: false }, "氏名が無ければメールで同じ人を探す");
});
