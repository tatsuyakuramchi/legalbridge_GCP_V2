import assert from "node:assert/strict";
import test from "node:test";
import { canSplitSubscription, splitCount, splitSubscriptionLine } from "./subscription-split.js";

// 検収書のサブスク明細を周期ごとの行へ分割する純関数のテスト。
// サブスクは1行に複数周期が入るため、行単位の検収状態では「3期まで支払済み・
// 今期を検収」を表現できない → 周期ごとに行を分けて既存の行ステータスを使う。

const SUBSC_ROW = {
  item_name: "保守サブスク", spec: "月次保守", calc_method: "SUBSCRIPTION",
  inspection_status: "now", ordered_quantity: 3, inspected_quantity: 3,
  unit_price: 100000, ordered_amount_ex_tax: 300000, inspected_amount_ex_tax: 300000,
  acceptance_ratio: 1, delivery_date: "", deliverable_ownership: "発注者"
};

test("サブスクかつ周期2以上のときだけ分割できる", () => {
  assert.equal(canSplitSubscription(SUBSC_ROW), true);
  assert.equal(canSplitSubscription({ ...SUBSC_ROW, calc_method: "FIXED" }), false);
  assert.equal(canSplitSubscription({ ...SUBSC_ROW, inspected_quantity: 1, ordered_quantity: 1 }), false);
  assert.equal(splitSubscriptionLine({ ...SUBSC_ROW, calc_method: "FIXED" }), null);
});

test("周期数は 支払予定日の行数 → 今回周期数 → 発注周期数 の順で決まる", () => {
  assert.equal(splitCount(SUBSC_ROW), 3);
  assert.equal(splitCount({
    ...SUBSC_ROW,
    payment_schedule: [
      { date: "2026-09-30", amount: 90000 }, { date: "2026-10-30", amount: 90000 },
      { date: "2026-11-30", amount: 90000 }, { date: "2026-12-30", amount: 30000 }
    ]
  }), 4);
  assert.equal(splitCount({ ...SUBSC_ROW, inspected_quantity: "", ordered_quantity: 12 }), 12);
});

test("支払予定日があれば各期の日付・金額をそのまま引き継ぐ", () => {
  const rows = splitSubscriptionLine({
    ...SUBSC_ROW,
    inspected_amount_ex_tax: 300000,
    payment_schedule: [
      { date: "2026-09-30", amount: 100000 },
      { date: "2026-10-30", amount: 150000 },
      { date: "2026-11-30", amount: 50000 }
    ]
  })!;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.inspected_amount_ex_tax), [100000, 150000, 50000]);
  assert.deepEqual(rows.map((r) => r.delivery_date), ["2026-09-30", "2026-10-30", "2026-11-30"]);
  assert.equal(rows[0].item_name, "保守サブスク（第1期）");
  assert.equal(rows[2].item_name, "保守サブスク（第3期）");
});

test("支払予定日が無ければ 単価（1周期の金額）を各期の金額にする", () => {
  const rows = splitSubscriptionLine(SUBSC_ROW)!;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.inspected_amount_ex_tax), [100000, 100000, 100000]);
  assert.deepEqual(rows.map((r) => r.unit_price), [100000, 100000, 100000]);
});

test("単価も無ければ均等割・端数は最終期に寄せて合計を保存する", () => {
  const rows = splitSubscriptionLine({
    ...SUBSC_ROW, unit_price: "", inspected_amount_ex_tax: 100000, ordered_amount_ex_tax: 100000
  })!;
  assert.deepEqual(rows.map((r) => r.inspected_amount_ex_tax), [33333, 33333, 33334]);
  const total = rows.reduce((s, r) => s + Number(r.inspected_amount_ex_tax), 0);
  assert.equal(total, 100000);
});

test("分割後の行は 未検収・数量1 で始まり、支払予定日と履歴系の列は引き継がない", () => {
  const rows = splitSubscriptionLine({
    ...SUBSC_ROW, paid_date: "2026-01-31", history_source: "ARC-IC-2026-0001",
    change_reason: "旧理由",
    payment_schedule: [{ date: "2026-09-30", amount: 150000 }, { date: "2026-10-30", amount: 150000 }]
  })!;
  for (const row of rows) {
    assert.equal(row.inspection_status, "skip");
    assert.equal(row.inspected_quantity, 1);
    assert.equal(row.ordered_quantity, 1);
    assert.equal(row.calc_method, "SUBSCRIPTION");
    assert.equal(row.payment_schedule, undefined);
    assert.equal(row.paid_date, "");
    assert.equal(row.history_source, "");
    assert.equal(row.change_reason, "");
    // 分割済みの行（周期1）は再分割の対象にならない。
    assert.equal(canSplitSubscription(row), false);
  }
  // 仕様・帰属などの他の列は引き継ぐ。
  assert.equal(rows[0].spec, "月次保守");
  assert.equal(rows[0].deliverable_ownership, "発注者");
});
