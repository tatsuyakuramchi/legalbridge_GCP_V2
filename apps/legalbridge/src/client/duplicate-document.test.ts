import assert from "node:assert/strict";
import test from "node:test";
import {
  DUPLICATE_CLEARED_KEYS, clearedKeysFor, describeDuplicate, duplicateFormData
} from "./duplicate-document.js";

// 「同じ内容の発注書を取引先A・Bの2通」への対応。1通目を確定したあと、
// その内容を引き継いで相手先だけ差し替える。
const ORDER_FOR_A = {
  // 引き継ぐ中身
  items: [
    { item_name: "イラスト", quantity: 1, unit_price: 100000, amount_ex_tax: 100000,
      calc_method: "FIXED", delivery_date: "2026-09-30" }
  ],
  other_fees: [{ fee_name: "振込手数料", amount: 880 }],
  financial_conditions: [{ condition_name: "国内販売", rate_pct: 8 }],
  SPECIAL_TERMS: "本件の権利は発注者に帰属する。",
  REMARKS_FREE: "納品はギガファイル便で。",
  ORDER_DATE: "2026-08-17",
  STAFF_NAME: "法務担当",
  grandTotalExTax: 100880,
  // 落とす情報
  documentNumber: "ARC-PO-2026-00001",
  発注番号: "ARC-PO-2026-00001",
  VENDOR_NAME: "株式会社A",
  VENDOR_IS_CORPORATION: "法人",
  VENDOR_SUFFIX: "御中",
  VENDOR_ADDRESS: "東京都千代田区…",
  BANK_NAME: "みずほ銀行",
  ACCOUNT_NUMBER: "1234567",
  ACCOUNT_HOLDER_KANA: "カブシキガイシャエー",
  VENDOR_ACCEPT_NAME: "A社 担当",
  VENDOR_ACCEPT_DATE: "2026-08-20"
};

test("明細・金額・特約・備考はそのまま引き継ぐ", () => {
  const next = duplicateFormData(ORDER_FOR_A);
  assert.deepEqual(next.items, ORDER_FOR_A.items);
  assert.deepEqual(next.other_fees, ORDER_FOR_A.other_fees);
  assert.deepEqual(next.financial_conditions, ORDER_FOR_A.financial_conditions);
  assert.equal(next.SPECIAL_TERMS, "本件の権利は発注者に帰属する。");
  assert.equal(next.REMARKS_FREE, "納品はギガファイル便で。");
  assert.equal(next.STAFF_NAME, "法務担当");
});

test("前の相手先は残さない（宛名・住所・敬称・区分）", () => {
  const next = duplicateFormData(ORDER_FOR_A);
  for (const key of ["VENDOR_NAME", "VENDOR_ADDRESS", "VENDOR_SUFFIX", "VENDOR_IS_CORPORATION"]) {
    assert.equal(key in next, false, `${key} を引き継がない`);
  }
});

test("振込先は必ず選び直させる（前の相手先の口座で出さない）", () => {
  const next = duplicateFormData(ORDER_FOR_A);
  for (const key of ["BANK_NAME", "ACCOUNT_NUMBER", "ACCOUNT_HOLDER_KANA"]) {
    assert.equal(key in next, false, `${key} を引き継がない`);
  }
});

test("前の文書番号・再発行情報は落とす（2通目は新規採番）", () => {
  const next = duplicateFormData(ORDER_FOR_A);
  assert.equal("documentNumber" in next, false);
  assert.equal("発注番号" in next, false);
  for (const key of ["base_document_number", "REVISION", "isReissue", "superseded_by"]) {
    assert.equal(key in next, false);
  }
});

test("相手先の承諾・署名の記録は引き継がない", () => {
  const next = duplicateFormData(ORDER_FOR_A);
  assert.equal("VENDOR_ACCEPT_NAME" in next, false);
  assert.equal("VENDOR_ACCEPT_DATE" in next, false);
});

test("落とすキーは削除する（空文字で残さない）", () => {
  // 空文字で残すと「入力済み」に見えて、相手先ボタンの自動入力や敬称の導出が走らない。
  const next = duplicateFormData(ORDER_FOR_A);
  assert.equal(Object.values(next).includes(""), false);
  assert.equal(Object.keys(next).some((k) => DUPLICATE_CLEARED_KEYS.includes(k)), false);
});

test("複製元が空でも壊れない", () => {
  assert.deepEqual(duplicateFormData({}), {});
  assert.deepEqual(duplicateFormData(undefined as never), {});
});

test("何を引き継ぎ何を消したかを数えられる", () => {
  const summary = describeDuplicate(ORDER_FOR_A);
  assert.equal(summary.carried, Object.keys(duplicateFormData(ORDER_FOR_A)).length);
  assert.ok(summary.cleared.includes("VENDOR_NAME"));
  assert.ok(summary.cleared.includes("BANK_NAME"));
  // 元が持っていなかったキーは「消した」に数えない。
  assert.equal(summary.cleared.includes("LICENSOR_NAME"), false);
});

test("許諾側の文書でも許諾者を選び直させる", () => {
  const next = duplicateFormData({ LICENSOR_NAME: "山田 太郎", 許諾者種別: "個人", 対象作品: "作品X" });
  assert.equal("LICENSOR_NAME" in next, false);
  assert.equal("許諾者種別" in next, false);
  assert.equal(next.対象作品, "作品X");
});

// ── 同じ相手先へ別の内容を出す（取引先Aへ2件目の別発注）─────────────────
test("内容違いの複製では相手先と振込先を引き継ぐ", () => {
  const next = duplicateFormData(ORDER_FOR_A, "content");
  assert.equal(next.VENDOR_NAME, "株式会社A");
  assert.equal(next.VENDOR_IS_CORPORATION, "法人");
  assert.equal(next.VENDOR_SUFFIX, "御中");
  assert.equal(next.VENDOR_ADDRESS, "東京都千代田区…");
  assert.equal(next.BANK_NAME, "みずほ銀行");
  assert.equal(next.ACCOUNT_NUMBER, "1234567");
});

test("内容違いの複製では明細・金額・集計を空にする", () => {
  // 前の明細が残ったまま別の発注を出すと、金額だけ直したつもりで別品目が紛れる。
  const next = duplicateFormData(ORDER_FOR_A, "content");
  for (const key of ["items", "other_fees", "financial_conditions",
    "grandTotalExTax", "itemsSubtotalExTax", "otherFeesTotal"]) {
    assert.equal(key in next, false, `${key} を引き継がない`);
  }
});

test("内容違いの複製でも文書番号と承諾記録は落とす", () => {
  const next = duplicateFormData(ORDER_FOR_A, "content");
  assert.equal("documentNumber" in next, false);
  assert.equal("VENDOR_ACCEPT_NAME" in next, false);
  assert.equal("VENDOR_ACCEPT_DATE" in next, false);
});

test("内容違いでも特約・備考・担当者は引き継ぐ（定型文の再利用）", () => {
  const next = duplicateFormData(ORDER_FOR_A, "content");
  assert.equal(next.SPECIAL_TERMS, "本件の権利は発注者に帰属する。");
  assert.equal(next.REMARKS_FREE, "納品はギガファイル便で。");
  assert.equal(next.STAFF_NAME, "法務担当");
});

test("2つの複製は消す対象が逆になっている", () => {
  const vendor = new Set(clearedKeysFor("vendor"));
  const content = new Set(clearedKeysFor("content"));
  // 相手先違い: 相手先を消して明細は残す
  assert.ok(vendor.has("VENDOR_NAME"));
  assert.ok(!vendor.has("items"));
  // 内容違い: 明細を消して相手先は残す
  assert.ok(content.has("items"));
  assert.ok(!content.has("VENDOR_NAME"));
  // どちらでも必ず消すもの
  for (const key of ["documentNumber", "VENDOR_ACCEPT_DATE"]) {
    assert.ok(vendor.has(key) && content.has(key), `${key} は両方で消す`);
  }
});

test("既定は相手先違い（引数なしの呼び出しは従来動作）", () => {
  assert.deepEqual(duplicateFormData(ORDER_FOR_A), duplicateFormData(ORDER_FOR_A, "vendor"));
  assert.deepEqual(clearedKeysFor("vendor"), DUPLICATE_CLEARED_KEYS);
});

test("空配列の明細は「消した」に数えない", () => {
  const summary = describeDuplicate({ items: [], VENDOR_NAME: "株式会社A" }, "content");
  assert.equal(summary.cleared.includes("items"), false);
});

test("内容違いの要約は明細を消したことを示す", () => {
  const summary = describeDuplicate(ORDER_FOR_A, "content");
  assert.ok(summary.cleared.includes("items"));
  assert.equal(summary.cleared.includes("VENDOR_NAME"), false);
});
