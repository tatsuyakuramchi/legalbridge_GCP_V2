import test from "node:test";
import assert from "node:assert/strict";
import { buildAdjustments, buildFeeTerms, ppmToPct, taxRateFor, toMajor, toMinor } from "./economics.js";
import { calculateFee } from "./calc.js";
import { DomainError } from "../core/errors.js";

const base = {
  id: 5, conditionNo: "CL-2026-00042", currency: "JPY",
  pricingModel: "revenue_rate" as const, ratePpm: 125000,
  unitAmount: null, flatAmount: null, mgAmount: null, agAmount: null,
  taxCategory: "taxable" as const
};

test("単位の変換：円は最小単位＝主単位、外貨は1/100", () => {
  assert.equal(toMajor(1200000, "JPY"), 1200000);
  assert.equal(toMinor(1200000, "JPY"), 1200000);
  assert.equal(toMajor(123456, "USD"), 1234.56);
  assert.equal(toMinor(1234.56, "USD"), 123456);
});

test("料率は百万分率で持ち、% に戻して計算する", () => {
  assert.equal(ppmToPct(125000), 12.5);
  assert.equal(ppmToPct(80000), 8);
  assert.equal(ppmToPct(null), 0);
});

test("税区分から税率が決まる（軽減8%・非課税0%）", () => {
  assert.equal(taxRateFor({ ...base, taxCategory: "taxable" }), 10);
  assert.equal(taxRateFor({ ...base, taxCategory: "reduced" }), 8);
  assert.equal(taxRateFor({ ...base, taxCategory: "exempt" }), 0);
});

test("売上報告型：外貨の報告は手入力レートで円に直してから料率を掛ける", () => {
  const terms = buildFeeTerms(
    { ...base, currency: "JPY" },
    { salesInput: 500000, intakeCurrency: "USD", fxRate: 150 }
  );
  // USD 5,000.00 × 150 = 750,000 円
  assert.deepEqual(terms, { type: "revenue", base_amount: 750000, rate_pct: 12.5 });
});

test("数量ベースは数量が無ければ計算しない", () => {
  assert.throws(
    () => buildFeeTerms({ ...base, pricingModel: "unit_rate", unitAmount: 1650 }, {}),
    (e: unknown) => e instanceof DomainError && e.code === "VALIDATION");
});

test("算定方法が未設定の条件は計算できない", () => {
  assert.throws(
    () => buildFeeTerms({ ...base, pricingModel: "none" }, {}),
    (e: unknown) => e instanceof DomainError && /算定方法/.test((e as Error).message));
});

// ── ここから意味論の固定（V1 で誤実装されていた箇所） ──

test("MGは下限であって消化されない：毎期おなじ下限が効く", () => {
  const condition = { ...base, mgAmount: 1200000 };
  const first = calculateFee(
    buildFeeTerms(condition, { salesInput: 4000000 }),   // 400万 × 12.5% = 50万
    buildAdjustments(condition, {}, 0), 10);
  assert.equal(first.actual_ex_tax, 1200000, "グロスがMGを下回るのでMGが採用される");
  assert.equal(first.mg_topup_this_time, 700000);
  assert.equal(first.mg_consumed_this_time, 0, "MGは消化しない");

  // 次の期も同じ MG が下限として効く（消化されていないため）
  const second = calculateFee(
    buildFeeTerms(condition, { salesInput: 4000000 }),
    buildAdjustments(condition, {}, 0), 10);
  assert.equal(second.actual_ex_tax, 1200000);
});

test("AGは累積で消化する：消化済みが増えると相殺が減る", () => {
  const condition = { ...base, agAmount: 800000 };
  const terms = buildFeeTerms(condition, { salesInput: 4000000 }); // gross 50万

  const first = calculateFee(terms, buildAdjustments(condition, {}, 0), 10);
  assert.equal(first.ag_offset_this_time, 500000, "AG残の範囲で全額相殺");
  assert.equal(first.actual_ex_tax, 0, "実支払はゼロ");
  assert.equal(first.ag_remaining_after, 300000);

  // 1回目の相殺 50万を渡すと、AG残は 30万
  const second = calculateFee(terms, buildAdjustments(condition, {}, 500000), 10);
  assert.equal(second.ag_offset_this_time, 300000);
  assert.equal(second.actual_ex_tax, 200000, "AGを使い切った分だけ支払が出る");
  assert.equal(second.ag_fully_consumed, true);
});

test("MG下限のあとにAG相殺が来る（順序が変わると金額が変わる）", () => {
  const condition = { ...base, mgAmount: 1200000, agAmount: 800000 };
  const result = calculateFee(
    buildFeeTerms(condition, { salesInput: 4000000 }),   // gross 50万
    buildAdjustments(condition, {}, 0), 10);
  // 50万 → MG下限で 120万 → AG 80万を相殺 → 40万
  assert.equal(result.after_acceptance, 500000);
  assert.equal(result.ag_offset_this_time, 800000);
  assert.equal(result.actual_ex_tax, 400000);
  assert.equal(result.tax_amount, 40000);
});

test("丸めは切り上げで統一（1円のズレを許容しない）", () => {
  const condition = { ...base, ratePpm: 33333 };          // 3.3333%
  const result = calculateFee(
    buildFeeTerms(condition, { salesInput: 100001 }),
    buildAdjustments(condition, {}, 0), 10);
  assert.equal(result.gross_ex_tax, Math.ceil(100001 * 0.033333));
  assert.equal(result.tax_amount, Math.ceil(result.actual_ex_tax * 0.1));
});

test("歩留率は検収での減額に効く", () => {
  const condition = { ...base, pricingModel: "unit_rate" as const, unitAmount: 1650, ratePpm: 100000 };
  const result = calculateFee(
    buildFeeTerms(condition, { quantity: 100 }),
    buildAdjustments(condition, { acceptanceRatio: 0.8 }, 0), 10);
  // 1650 × 100 × 10% = 16,500 → 歩留 80% → 13,200
  assert.equal(result.gross_ex_tax, 16500);
  assert.equal(result.after_acceptance, 13200);
});
