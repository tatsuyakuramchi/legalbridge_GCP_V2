import test from "node:test";
import assert from "node:assert/strict";
import { buildTemplateContext } from "./template-context.js";
import { computeInspectionTotals, inspectionTaxBreakdown } from "./legacy-totals.js";
import { DocumentRepository, TAX_ROUNDING_VARIABLE } from "./repository.js";
import { bindVariables } from "./binding.js";
import { FakeDatabase } from "../core/fake-db.js";
import { SERVICE_COMPLETION_KEY } from "./settlement-docs.js";

/**
 * 検収書・役務提供完了通知書の消費税の端数処理（書類ごとに人が選ぶ）。
 * 発注書の消費税が切り捨てで出ていると、切り上げの検収書と 1 円ずれる。
 */

// 12,345 円 × 10% = 1,234.5 円。丸め方で 1 円変わる額。
const line = { item_name: "挿絵", inspected_amount_ex_tax: 12345, inspection_status: "now" };
const ctx = () => ({
  document: { number: "ARC-INS-2026-0100", issuedOn: "2026-10-28" },
  conditions: [{ id: 1, name: "挿絵", taxCategory: "taxable", flatAmount: 12345 }],
  condition: { id: 1, name: "挿絵", taxCategory: "taxable", flatAmount: 12345 },
  events: [], schedules: [], bank: null
});

test("選ばなければ従来どおり切り上げ（既存の書類の額は変わらない）", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), { delivery_line_items: [{ ...line }] });
  assert.equal(c.taxAmountStr, "1,235");
  assert.equal(c.combinedTaxStr, "1,235");
  assert.equal(c.grandTotalPayableStr, "13,580");
});

test("切り捨てを選ぶと、本文の消費税・合計・税区分の内訳が切り捨てになる", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(),
    { delivery_line_items: [{ ...line }], tax_rounding: "切り捨て" });
  assert.equal(c.taxAmountStr, "1,234");
  assert.equal(c.totalAmountStr, "13,579");
  assert.equal(c.combinedTaxStr, "1,234");
  assert.equal(c.grandTotalPayableStr, "13,579");
  assert.equal((c.taxBreakdown as { tax: number }).tax, 1234);
});

test("四捨五入も選べる", () => {
  const half = buildTemplateContext("inspection_certificate", ctx(),
    { delivery_line_items: [{ ...line }], tax_rounding: "四捨五入" });
  assert.equal(half.combinedTaxStr, "1,235");
  const below = buildTemplateContext("inspection_certificate", ctx(),
    { delivery_line_items: [{ ...line, inspected_amount_ex_tax: 12344 }], tax_rounding: "四捨五入" });
  assert.equal(below.combinedTaxStr, "1,234");
});

test("役務提供完了通知書も同じ選択で丸める", () => {
  const c = buildTemplateContext(SERVICE_COMPLETION_KEY, ctx(),
    { delivery_line_items: [{ ...line }], tax_rounding: "切り捨て" });
  assert.equal(c.combinedTaxStr, "1,234");
  assert.equal(c.taxableTotalIncTaxStr, "13,579");
});

test("支払日ごとのまとまり（検収済みの回がある検収書）も選んだ丸め方", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), {
    tax_rounding: "切り捨て",
    delivery_line_items: [
      { ...line, inspection_status: "paid", payment_date: "2026-09-30" },
      { ...line, payment_date: "2026-10-31" }
    ]
  });
  const groups = c.paymentGroups as Array<{ taxAmountStr: string }>;
  assert.ok(groups.length > 0);
  for (const g of groups) assert.equal(g.taxAmountStr, "1,234");
});

test("合計の計算は taxRounding を受ける。軽減の内訳も同じ丸め方", () => {
  const source = { delivery_line_items: [{ ...line }], taxRate: 10, taxRounding: "floor",
                   other_fees: [{ amount_ex_tax: 1255, tax_category: "reduced" }] };
  assert.equal(computeInspectionTotals(source).tax, 1234);
  // 12,345 × 10% → 1,234 ／ 1,255 × 8% = 100.4 → 100
  assert.equal(inspectionTaxBreakdown(source).tax, 1334);
  assert.equal(inspectionTaxBreakdown({ ...source, taxRounding: "ceil" }).tax, 1235 + 101);
});

test("検収書・役務提供完了通知書には端数処理の欄が付く（海外用・発注書には付けない）", async () => {
  const declared = [
    { name: "confirm_deadline", label: "確認期限", type: "date", group: "I. 基本情報" },
    { name: "remarks", label: "備考（追記）", type: "textarea", group: "III. 備考" }
  ];
  const variablesOf = async (templateKey: string, variables: unknown[] = declared) => {
    const db = new FakeDatabase(() => [{ template_id: 1, version_id: 2, template_key: templateKey, label: "x",
                                         category: null, number_prefix: null, html_source: "", variables }]);
    return (await new DocumentRepository(db).templateSource(db, { templateKey })).variables.map((v) => v.name);
  };
  // III の区分の前に置く（区分は最初に出た順に並ぶ）。
  assert.deepEqual(await variablesOf(SERVICE_COMPLETION_KEY), ["confirm_deadline", "tax_rounding", "remarks"]);
  assert.ok((await variablesOf("inspection_certificate", [])).includes("tax_rounding"));
  assert.ok(!(await variablesOf("intl_inspection_certificate")).includes("tax_rounding"));
  assert.ok(!(await variablesOf("purchase_order")).includes("tax_rounding"));
  // データベースに同じ名前の宣言があればそちら（二重にしない）。
  const own = [{ name: "tax_rounding", label: "端数", type: "select" }];
  assert.deepEqual(await variablesOf("inspection_certificate", own), ["tax_rounding"]);
});

test("端数処理の欄は既定で「切り上げ」が入り、名前の推測で他の値を拾わない", () => {
  const r = bindVariables([TAX_ROUNDING_VARIABLE], {}, {}, { templateKey: "inspection_certificate" });
  const field = r.fields.find((f) => f.name === "tax_rounding")!;
  assert.equal(field.value, "切り上げ");
  assert.equal(field.type, "select");
  assert.deepEqual(field.options, ["切り上げ", "切り捨て", "四捨五入"]);
  assert.equal(r.values.tax_rounding, "切り上げ");
  const chosen = bindVariables([TAX_ROUNDING_VARIABLE], {}, { tax_rounding: "切り捨て" },
    { templateKey: "inspection_certificate" });
  assert.equal(chosen.values.tax_rounding, "切り捨て");
});
