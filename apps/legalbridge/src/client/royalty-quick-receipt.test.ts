import assert from "node:assert/strict";
import test from "node:test";
import { buildQuickReceiptPatch, emptyQuickReceipt, quickReceiptJpy } from "./royalty-quick-receipt.js";

const inLine = { id: 501, documentNumber: "CT-2026-00042", conditionName: "原作ロイヤリティ", vendorName: "スタジオ雨宿り", workTitle: "エピローグ", currency: "JPY" };
const outLine = { id: 620, documentNumber: "CT-2026-00043", conditionName: "英語版ライセンス", vendorName: "Meridian Games", workTitle: "エピローグ", currency: "USD" };
const economics = { representativeLineId: 501, conditionName: "原作ロイヤリティ", ratePct: 5, mgAmount: 100000, agAmount: 0, agConsumed: 0 };

test("かんたん受領入力: 3 つの入力から計算書の欄（当事者・契約・製品・受領行・イン側料率）を一括で埋める", () => {
  const patch = buildQuickReceiptPatch({
    inLine, economics, outLine, companyName: "株式会社アークライト",
    receipt: { ...emptyQuickReceipt(), currency: "USD", amount: 12000, fxMode: "pre", fxRate: 148.2, receivedOn: "2026-05-10" }
  });
  assert.equal(patch.statementMode, "multi");
  assert.equal(patch.rsConditionLineId, 501);
  assert.equal(patch.rsInRatePct, 5);
  assert.equal(patch.rsMgAmount, 100000);
  assert.equal(patch.licensor, "スタジオ雨宿り");
  assert.equal(patch.designerName, "スタジオ雨宿り");
  assert.equal(patch.licensee, "株式会社アークライト");
  assert.equal(patch.linked_contract_number, "CT-2026-00042");
  assert.equal(patch.originalWork, "エピローグ");
  assert.equal(patch.productName, "英語版ライセンス");
  assert.equal(patch.payerCompany, "Meridian Games");     // 名称未入力ならアウト条件の相手先
  assert.equal(patch.intakeCurrency, "USD");
  assert.equal(patch.fxRate, 148.2);
  assert.equal(patch.currency, "JPY");
  const receipts = patch.rs_receipts as Array<Record<string, unknown>>;
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], { sublicensee: "Meridian Games", receivedOn: "2026-05-10", currency: "USD", amount: 12000, fxMode: "pre", fxRate: 148.2 });
});

test("かんたん受領入力: 円入金は換算なし、既存の受領行に追記、アウト条件が無ければ名称欄と作品名で埋める", () => {
  const patch = buildQuickReceiptPatch({
    inLine, economics, outLine: null, companyName: "",
    receipt: { ...emptyQuickReceipt(), sublicensee: "Seoul Tabletop", amount: 890000, receivedOn: "2026-06-20" },
    existing: { rs_receipts: [{ sublicensee: "Meridian Games", currency: "USD", amount: 12000 }, { sublicensee: "", amount: "" }] }
  });
  const receipts = patch.rs_receipts as Array<Record<string, unknown>>;
  assert.equal(receipts.length, 2);                        // 空行は捨てて追記
  assert.equal(receipts[1].fxMode, "post");
  assert.equal(receipts[1].fxRate, "");
  assert.equal(patch.payerCompany, "Seoul Tabletop");
  assert.equal(patch.productName, "エピローグ（サブライセンス受領分）");
  assert.equal("licensee" in patch, false);                // 自社名が取れないときは触らない
  assert.equal(quickReceiptJpy({ ...emptyQuickReceipt(), currency: "USD", amount: 12000, fxMode: "pre", fxRate: 148.2 }), 1778400);
  assert.equal(quickReceiptJpy({ ...emptyQuickReceipt(), amount: 890000 }), 890000);
});

test("発行元（自社）と担当者: 会社プロファイルと担当者マスタから COMPANY_* / STAFF_* を埋める（空は書かない）", () => {
  const patch = buildQuickReceiptPatch({
    inLine, economics, outLine, companyName: "",
    company: { name: "株式会社アークライト", postal_code: "101-0021", address: "東京都千代田区外神田…", tel: "03-0000-0000", invoice_no: "T1234567890123", rep: "" },
    staff: { staff_name: "倉持 達也", department: "法務", email: "k@example.com", phone: "" },
    receipt: { ...emptyQuickReceipt(), amount: 100000 }
  });
  assert.equal(patch.licensee, "株式会社アークライト");
  assert.equal(patch.COMPANY_POSTAL_CODE, "101-0021");
  assert.equal(patch.COMPANY_ADDRESS, "東京都千代田区外神田…");
  assert.equal(patch.COMPANY_TEL, "03-0000-0000");
  assert.equal(patch.COMPANY_INVOICE_NO, "T1234567890123");
  assert.equal("COMPANY_REP" in patch, false);
  assert.equal(patch.STAFF_NAME, "倉持 達也");
  assert.equal(patch.STAFF_DEPARTMENT, "法務");
  assert.equal(patch.STAFF_EMAIL, "k@example.com");
  assert.equal(patch.STAFF_PHONE, "");
});
