import assert from "node:assert/strict";
import test from "node:test";
import { inspectionTaxBreakdown, statementTaxBreakdown, sumTaxBreakdown, taxBreakdownFor } from "./document-tax-breakdown.js";

test("検収書: 納品額＋手数料（課税）／経費は税区分別、区分の無い旧経費は税込のまま別枠", () => {
  const b = inspectionTaxBreakdown({
    taxRate: 10,
    delivery_line_items: [
      { item_name: "制作", inspected_amount_ex_tax: 300000, inspection_status: "now" },
      { item_name: "過去分", inspected_amount_ex_tax: 100000, inspection_status: "paid" },   // 今回の支払には含めない
      { item_name: "未", inspected_amount_ex_tax: 50000, inspection_status: "skip" }
    ],
    other_fees: [
      { fee_name: "振込手数料", amount: 440, tax_category: "taxable" },
      { fee_name: "印紙", amount: 200, tax_category: "exempt" },
      { fee_name: "旧手数料（区分なし）", amount: 1000 }
    ],
    expenses: [
      { expense_name: "交通費（立替）", amount_ex_tax: 20000, tax_category: "exempt" },
      { expense_name: "書籍", amount_inc_tax: 1080, tax_category: "reduced" },          // 税込から逆算 1000
      { expense_name: "旧経費（区分なし）", amount_inc_tax: 5500 }
    ]
  });
  assert.equal(b.taxable10, 301440);       // 300000 + 440 + 1000
  assert.equal(b.reduced8, 1000);
  assert.equal(b.exempt, 20200);           // 200 + 20000
  assert.equal(b.legacyIncTax, 5500);
  assert.equal(b.tax, 30144 + 80);         // ceil(301440×10%) + ceil(1000×8%)
  assert.equal(b.totalIncTax, 301440 + 1000 + 20200 + 30224 + 5500);
});

test("検収書（旧データ・税区分なし）: 従来の検収計算の総支払額と一致する", () => {
  const formData = {
    taxRate: 10,
    delivery_line_items: [{ inspected_amount_ex_tax: 100000 }],
    other_fees: [{ amount: 1000 }],
    expenses: [{ amount_inc_tax: 3300 }]
  };
  const b = inspectionTaxBreakdown(formData);
  // 従来: (100000+1000) + ceil(101000×10%) + 3300 = 114,400
  assert.equal(b.totalIncTax, 114400);
  assert.equal(b.legacyIncTax, 3300);
});

test("計算書: 支払額（税抜）は課税10%・消費税と税込は共有エンジン", () => {
  const b = statementTaxBreakdown({ statementMode: "single", rsCalcType: "period", rsBasisKind: "sales", rsMsrp: 1000000, rsRatePct: 3, taxRate: 10 });
  assert.deepEqual(b, { taxable10: 30000, reduced8: 0, exempt: 0, legacyIncTax: 0, tax: 3000, totalIncTax: 33000 });
  assert.equal(taxBreakdownFor("nda", {}).totalIncTax, 0);
  const sum = sumTaxBreakdown([b, b]);
  assert.equal(sum.taxable10, 60000);
  assert.equal(sum.totalIncTax, 66000);
});
