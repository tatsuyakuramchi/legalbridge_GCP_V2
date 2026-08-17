import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplateDocumentContext } from "./template-context-adapters.js";

function context(formData: Record<string, unknown>) {
  return buildTemplateDocumentContext("purchase_order", formData);
}

test("金銭条件が空でも、業績連動の明細があれば利用許諾条件表を出す", () => {
  // テンプレートは financial_conditions が空のとき ROYALTY 明細を条件表へ流し込む
  // 分岐を持つ。has_license_conditions が条件表の件数しか見ていないと、その分岐へ
  // 到達できず入力が丸ごと消える。
  const result = context({
    items: [{ item_name: "イラスト", calc_method: "ROYALTY", rate_pct: 5 }]
  });
  assert.equal(result.has_license_conditions, true);
  assert.equal(result.has_performance_incentive, true);
});

test("固定額の明細だけなら条件表は出さない", () => {
  const result = context({
    items: [{ item_name: "デザイン", calc_method: "FIXED", amount_ex_tax: 100000 }]
  });
  assert.equal(result.has_license_conditions, false);
  assert.equal(result.has_performance_incentive, false);
});

test("支払方法未設定の明細は固定額として扱う", () => {
  const result = context({ items: [{ item_name: "校正", amount_ex_tax: 50000 }] });
  assert.equal(result.has_license_conditions, false);
  assert.equal(result.has_performance_incentive, false);
});

test("明細の帰属先が受注者なら利用許諾料として表記する", () => {
  const seller = context({
    items: [{ item_name: "原稿", calc_method: "ROYALTY", deliverable_ownership: "受注者" }]
  });
  assert.equal(seller.has_seller_owned_license, true);
  const buyer = context({
    items: [{ item_name: "原稿", calc_method: "ROYALTY", deliverable_ownership: "発注者" }]
  });
  // 発注者帰属はインセンティブ報酬。利用許諾料の見出しにはしない。
  assert.equal(buyer.has_seller_owned_license, false);
  assert.equal(buyer.has_performance_incentive, true);
});

test("金銭条件表がある従来の入力はそのまま動く", () => {
  const result = context({
    items: [{ item_name: "デザイン", calc_method: "FIXED" }],
    financial_conditions: [{ condition_name: "国内販売", calc_method: "ROYALTY", rate_pct: 8 }]
  });
  assert.equal(result.has_license_conditions, true);
  assert.equal(result.has_performance_incentive, true);
  assert.equal(result.CALC_METHOD, "ROYALTY");
});

test("小計は業績連動の明細でも金額欄をそのまま集計する", () => {
  // ROYALTY 明細の金額0は「報酬は利用許諾料に含む」の意味で、確定額には乗らない。
  const result = context({
    items: [
      { item_name: "執筆", calc_method: "ROYALTY", amount_ex_tax: 30000 },
      { item_name: "監修", calc_method: "ROYALTY", amount_ex_tax: 0 },
      { item_name: "デザイン", calc_method: "FIXED", amount_ex_tax: 100000 }
    ]
  });
  assert.equal(result.itemsSubtotalExTax, 130000);
});

test("定期支払の明細でも条件表は増えない", () => {
  const result = context({
    items: [{ item_name: "顧問料", calc_method: "SUBSCRIPTION", cycle: "MONTHLY", billing_day: 31 }]
  });
  assert.equal(result.has_license_conditions, false);
  assert.equal(result.has_performance_incentive, false);
});

// ── 自動集計（画面の合計と PDF の合計を一致させる）─────────────────────────
test("合計金額は明細と手数料から算出する（手入力欄は当てにしない）", () => {
  const result = context({
    items: [{ amount_ex_tax: 100000 }, { unit_price: 20000, quantity: 2 }],
    other_fees: [{ fee_name: "振込手数料", amount: 880 }]
  });
  assert.equal(result.itemsSubtotalExTax, 140000);
  assert.equal(result.otherFeesTotal, 880);
  assert.equal(result.grandTotalExTax, 140880);
});

test("明細があるときは手入力の合計金額より集計値を採る", () => {
  const result = context({ grandTotalExTax: 999999, items: [{ amount_ex_tax: 100000 }] });
  assert.equal(result.grandTotalExTax, 100000);
});

test("明細が無ければ手入力の合計金額をそのまま使う（単一明細フォールバック）", () => {
  const result = context({ grandTotalExTax: 250000, ITEM_NAME: "監修一式" });
  assert.equal(result.grandTotalExTax, 250000);
});

test("納期・支払日を明細から集約し DELIVERY_DATE にも渡す", () => {
  const result = context({
    items: [
      { delivery_date: "2026-09-30", payment_date: "2026-10-31" },
      { delivery_date: "2026-10-31", payment_date: "2026-10-31" }
    ]
  });
  assert.equal(result.summaryDeliveryDate, "2026-09-30 〜 2026-10-31 (明細参照)");
  assert.equal(result.summaryPaymentDate, "2026-10-31");
  assert.equal(result.DELIVERY_DATE, "2026-09-30 〜 2026-10-31 (明細参照)");
});

test("納期が明示入力されていれば集約より優先する", () => {
  const result = context({
    DELIVERY_DATE: "2026-12-01", items: [{ delivery_date: "2026-09-30" }]
  });
  assert.equal(result.DELIVERY_DATE, "2026-12-01");
});

// ── 特約事項は備考へ流さない ─────────────────────────────────────────────
test("特約事項だけ入力しても備考枠は出さない", () => {
  // テンプレートは「特約事項」と「備考」を別枠で出す。SPECIAL_TERMS を REMARKS 系の
  // フォールバックに混ぜていたため、特約だけ入れると同じ文が両方に出ていた。
  const result = context({ SPECIAL_TERMS: "本件の権利は発注者に帰属する。" });
  assert.equal(result.SPECIAL_TERMS, "本件の権利は発注者に帰属する。");
  assert.equal(result.REMARKS, "");
  assert.equal(result.REMARKS_FREE, "");
  assert.equal(result.REMARKS_FIXED, "");
});

test("備考を入力すれば備考枠が出る（特約は空のまま）", () => {
  const result = context({ REMARKS_FREE: "納品はギガファイル便で。" });
  assert.equal(result.REMARKS_FREE, "納品はギガファイル便で。");
  assert.equal(result.REMARKS, "納品はギガファイル便で。", "備考枠の表示判定に使われる");
  assert.equal(result.SPECIAL_TERMS, "");
});

test("特約と備考を両方入力すればそれぞれの枠に入る", () => {
  const result = context({
    SPECIAL_TERMS: "特約の文", REMARKS_FIXED: "定型の文", REMARKS_FREE: "自由の文"
  });
  assert.equal(result.SPECIAL_TERMS, "特約の文");
  assert.equal(result.REMARKS_FIXED, "定型の文");
  assert.equal(result.REMARKS_FREE, "自由の文");
});

test("REMARKS だけの旧データは定型備考として表示する（後方互換）", () => {
  const result = context({ REMARKS: "旧テンプレの備考" });
  assert.equal(result.REMARKS_FIXED, "旧テンプレの備考");
  assert.equal(result.SPECIAL_TERMS, "");
});
