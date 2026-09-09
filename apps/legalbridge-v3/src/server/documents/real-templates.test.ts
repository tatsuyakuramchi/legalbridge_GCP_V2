import test from "node:test";
import assert from "node:assert/strict";
import { resolveAllLegacyVariables } from "./legacy-variables.js";
import { buildTemplateContext } from "./template-context.js";

/**
 * 本番のひな形が実際に差している名前を、そのまま突き合わせる。
 *
 * これまで V1 のソースから変数名を起こしていて、いくつか外していた
 * （本番の検収書は bankName / accountNo という camelCase、こちらは BANK_NAME）。
 * 名前は本文との契約なので、実物から取った一覧をここに置いて見張る。
 *
 * 一覧の出どころ:
 *   SELECT regexp_matches(v.html_source, '\\{\\{[#/]?\\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶ]+)', 'g')
 * を本番の document_template_versions に対して実行した結果（2026-09-09）。
 */

const context = {
  document: { number: "ARC-INS-2026-0072", issuedOn: "2026-09-09" },
  company: {
    name: "株式会社アークライト", address: "東京都千代田区神田小川町1-2",
    rep: "代表取締役　野澤 邦仁", tel: "03-6811-0730",
    postalCode: "101-0052", invoiceNo: "T7010001071296"
  },
  agreement: { no: "AGR-2026-0088", title: "制作業務委託基本契約", executedOn: "2026-04-01" },
  matter: { title: "挿絵 追加発注" },
  conditions: [{ id: 1, taxCategory: "taxable" }],
  condition: {
    id: 1, name: "挿絵 第4巻 制作委託", notes: "（1）専門的助言", currency: "JPY",
    taxCategory: "taxable", pricingModel: "fixed", flatAmount: 280000,
    ratePct: 12.5, mgAmount: 1_200_000, agAmount: 800_000,
    paymentTerms: "毎月20日", termStart: "2026-04-01", termEnd: "2027-03-31",
    counterparty: {
      name: "合同会社アトリエ蒼", kind: "corporate", kana: "アトリエアオ",
      invoiceNo: "T9010001000001", address: "東京都千代田区外神田1-1", phone: "03-1111-2222"
    },
    work: { title: "星降る夜のミュゼ", code: "WRK-10013" }
  },
  contacts: [{ role: "primary", name: "青井 蒼", email: "ao@example.test", phone: "03-3333-4444",
               department: "制作部" },
             { role: "signer", name: "代表社員 青井 蒼" }],
  owner: { name: "浅井 崇", department: "制作部", email: "asai@example.test", phone: "03-5555-6666" },
  bank: { bankName: "三菱UFJ銀行", branchName: "神保町支店", accountType: "ordinary",
          accountNumber: "2513200", holderKana: "ヨシザワ　アツオ" },
  events: [{ id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 280000,
             plannedAmount: 280000, quantity: null,
             schedule: { payOn: "2026-09-20", dueOn: "2026-08-31" } }],
  schedules: [{ id: 1, conditionId: 1, seq: 1, label: "2026年8月分", plannedAmount: 280000,
                dueOn: "2026-08-31", payOn: "2026-09-20" }],
  // 実際の文脈は events[0] を event、その予定を schedule として持つ。
  event: { id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 280000, period: "2026年8月分" },
  schedule: { seq: 1, label: "2026年8月分", dueOn: "2026-08-31", payOn: "2026-09-20" },
  related: [{ id: 3, documentNo: "ARC-PO-2026-0032", templateKey: "purchase_order" }],
  backlogKey: "LEGAL-1234",
  royalty: {
    salesInput: 10_000_000, quantity: null, grossExTax: 1_250_000, mgTopup: 0,
    agOffset: 800_000, agRemaining: 0, agConsumedBefore: 0,
    netExTax: 450_000, taxAmount: 45_000, totalIncTax: 495_000
  },
  totals: { exTax: 280000, tax: 28000, incTax: 308000, taxRate: 10, currency: "JPY" }
};

/** 本文に値が届くまでの合成。発行時に焼き付けるものと同じ順で重ねる。 */
function rendered(templateKey: string, manual: Record<string, unknown> = {}) {
  return {
    ...resolveAllLegacyVariables(context),
    ...buildTemplateContext(templateKey, context, manual)
  } as Record<string, unknown>;
}

const has = (values: Record<string, unknown>, name: string) => {
  const v = values[name];
  return v !== undefined && v !== null && String(v).trim() !== "";
};

function assertFilled(templateKey: string, names: string[], manual = {}) {
  const values = rendered(templateKey, manual);
  const missing = names.filter((n) => !has(values, n));
  assert.deepEqual(missing, [], `${templateKey} で空になる差し込み: ${missing.join(", ")}`);
}

// ---- 検収書 -------------------------------------------------------------

test("検収書：本番の名前で振込先が全部出る", () => {
  // ここが揃っていなかったので、振込先に口座番号と名義しか出なかった。
  assertFilled("inspection_certificate",
    ["bankName", "branchName", "accountType", "accountNo", "accountHolder"]);
  assert.equal(rendered("inspection_certificate").accountType, "普通", "英字のまま出さない");
});

test("検収書：消費税と合計が出る", () => {
  const v = rendered("inspection_certificate");
  assert.equal(v.taxRate, 10);
  assert.equal(v.deliveredAmountStr, "280,000");
  assert.equal(v.taxAmountStr, "28,000");
  assert.equal(v.totalAmountStr, "308,000");
});

test("検収書：当事者と検収者と日付が出る", () => {
  assertFilled("inspection_certificate", [
    "counterparty", "COUNTERPARTY_IS_CORPORATION", "counterpartyRep", "counterpartyTni",
    "inspectorDept", "inspectorName", "inspectorEmail",
    "documentDate", "deliveredAt", "inspectionCompletedAt", "paymentDueDate",
    "paymentConditionSummary", "projectTitle"
  ]);
  assert.equal(rendered("inspection_certificate").COUNTERPARTY_IS_CORPORATION, "法人");
});

test("検収書：見出しの発注番号は発注書から辿る", () => {
  assert.equal(rendered("inspection_certificate").parent_po_number, "ARC-PO-2026-0032");
  assert.equal(rendered("inspection_certificate").issueKey, "LEGAL-1234");
});

test("検収書：明細の列名が本文と一致する", () => {
  const lines = rendered("inspection_certificate").delivery_line_items as Array<Record<string, unknown>>;
  assert.equal(lines.length, 1);
  // 本文が読むのはこの名前。別名で出しても表は空欄になる。
  for (const key of ["item_name", "spec", "inspected_quantity", "delivery_date",
                     "paid_date", "inspected_amount_ex_tax", "amount_ex_tax"]) {
    assert.ok(key in lines[0], `明細に ${key} が無い`);
  }
  assert.equal(lines[0].paid_date, "2026-09-20");
  assert.equal(lines[0].inspected_amount_ex_tax, 280000);
});

// ---- 発注書 -------------------------------------------------------------

test("発注書：当事者・自社・振込先・合計が出る", () => {
  assertFilled("purchase_order", [
    "ORDER_NO", "ORDER_DATE", "発注日", "発行日", "PROJECT_TITLE",
    "VENDOR_NAME", "VENDOR_SUFFIX", "VENDOR_ADDRESS", "VENDOR_EMAIL",
    "VENDOR_CONTACT_NAME", "VENDOR_CONTACT_PHONE", "VENDOR_REPRESENTATIVE_SAMA",
    "PARTY_A_NAME", "PARTY_A_ADDRESS", "PARTY_A_REP",
    "STAFF_NAME", "STAFF_DEPARTMENT", "STAFF_EMAIL", "STAFF_PHONE",
    "BANK_NAME", "BRANCH_NAME", "ACCOUNT_TYPE", "ACCOUNT_NUMBER",
    "ACCOUNT_HOLDER_KANA", "INVOICE_REGISTRATION_NUMBER", "BANK_INFO",
    "grandTotalExTax", "itemsSubtotalExTax", "summaryDeliveryDate", "summaryPaymentDate",
    "MASTER_CONTRACT_REF"
  ]);
});

test("発注書：明細は予定から組む", () => {
  const items = rendered("purchase_order").items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].amount_ex_tax, 280000);
  assert.equal(rendered("purchase_order").grandTotalExTax, 280000);
});

// ---- 利用許諾料計算書 ---------------------------------------------------

test("計算書：宣言の無い差し込みも出る（DOC_NO・moneyUnit・担当）", () => {
  // field_schema に宣言が無い名前。本文は平気で差してくる。
  assertFilled("royalty_statement",
    ["DOC_NO", "moneyUnit", "STAFF_NAME", "STAFF_DEPARTMENT", "STAFF_EMAIL", "STAFF_PHONE"]);
  assert.equal(rendered("royalty_statement").moneyUnit, "¥");
  assert.equal(rendered("royalty_statement").DOC_NO, "ARC-INS-2026-0072");
});

test("計算書：当事者・自社・契約番号が出る", () => {
  assertFilled("royalty_statement", [
    "licensor", "LICENSOR_SUFFIX", "VENDOR_REPRESENTATIVE_SAMA", "licensee",
    "COMPANY_ADDRESS", "COMPANY_TEL", "COMPANY_INVOICE_NO", "COMPANY_POSTAL_CODE",
    "originalWork", "productName", "currency", "documentDate", "linked_contract_number"
  ]);
  assert.equal(rendered("royalty_statement").linked_contract_number, "AGR-2026-0088");
});

test("計算書：金額が全部出る", () => {
  const v = rendered("royalty_statement");
  assert.equal(v.msrpStr, "10,000,000");
  assert.equal(v.grossRoyaltyStr, "1,250,000");
  assert.equal(v.agApplied, true);
  assert.equal(v.agConsumedThisTimeStr, "800,000");
  assert.equal(v.actualRoyaltyStr, "450,000");
  assert.equal(v.taxAmount, "45,000");
  assert.equal(v.totalPaymentStr, "495,000");
});

test("計算書：振込先は宣言に供給元が無くても名前で引ける", () => {
  // royalty_statement の口座欄には dbField が無い。名前だけが手がかり。
  assertFilled("royalty_statement",
    ["bankName", "branchName", "accountType", "accountNo", "accountHolder",
     "invoiceRegistrationNumber"]);
});
