import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderDocumentHtml } from "./render.js";
import { buildTemplateContext } from "./template-context.js";

/**
 * 海外用の検収書（Acceptance Certificate）の本文（infra/v3/templates/intl_inspection_certificate.html）。
 * 金額は税込の総額で、税の行を出さない（約款 6.5 条）。
 */
const html = readFileSync(new URL("../../../../../infra/v3/templates/intl_inspection_certificate.html", import.meta.url), "utf8");

const context = {
  document: { number: "ARC-INS-2026-1010", issuedOn: "2026-09-28" },
  condition: { id: 1, name: "Character illustration", taxCategory: "included", currency: "USD",
               counterparty: { withholding: true } },
  conditions: [{ id: 1, name: "Character illustration", taxCategory: "included", flatAmount: 2400 }],
  events: [{ id: 9, conditionId: 1, occurredOn: "2026-09-10", inspectedOn: "2026-09-15", amount: 2400,
             schedule: { payOn: "2026-10-31" } }],
  schedules: [],
  bank: { bankName: "Sample Bank", swiftBic: "SMPLUS33", holderName: "Sample Studio Ltd.", accountNumber: "12345678", scope: "overseas" }
};

const render = (manual: Record<string, unknown> = {}) => {
  const computed = buildTemplateContext("intl_inspection_certificate", context, manual);
  return renderDocumentHtml(html, {
    ...computed, VENDOR_NAME: "Sample Studio Ltd.", PARTY_A_NAME: "Arclight, Inc.",
    parent_po_number: "ARC-IPO-2026-1001"
  });
};

test("Acceptance Certificate：税込の総額・通貨・PO 番号・受入日・支払予定日が出る", () => {
  const out = render({ other_fees: [{ fee_name: "Rush fee", amount_ex_tax: 100 }] });
  assert.match(out, /ACCEPTANCE CERTIFICATE/);
  assert.match(out, /Certificate No\.: ARC-INS-2026-1010/);
  assert.match(out, /PO No\.: ARC-IPO-2026-1001/);
  assert.match(out, /accepted\s+as of September 15, 2026/);
  assert.match(out, /USD 2,500(\.00)?<\/strong>/);
  assert.match(out, /Inclusive of any VAT, sales or similar taxes/);
  assert.match(out, /October 31, 2026/);
  assert.match(out, /SWIFT\/BIC: SMPLUS33/);
  assert.match(out, /Applicable — the Purchaser will deduct/);
});

test("Acceptance Certificate：消費税の行は出さない", () => {
  const out = render();
  assert.doesNotMatch(out, /Consumption|消費税|Tax Amount|excl\. tax/i);
});

test("基本契約に基づく発注なら、約款の条番号は出さない（約款は付いていない）", () => {
  const computed = buildTemplateContext("intl_inspection_certificate", context, {});
  const out = renderDocumentHtml(html, { ...computed, HAS_BASE_CONTRACT: true });
  assert.doesNotMatch(out, /Standard Terms/);
  assert.match(out, /Inclusive of any VAT/);
});

test("Acceptance Certificate：非居住者の源泉の税率を出す", () => {
  const nr = { ...context, condition: { ...context.condition,
    counterparty: { withholding: true, residency: "non_resident", residenceCountry: "United States" } } };
  const out = renderDocumentHtml(html, { ...buildTemplateContext("intl_inspection_certificate", nr, {}) });
  assert.match(out, /Applicable: 20\.42% \(Japanese domestic rate for non-residents\) — the Purchaser will deduct/);
});
