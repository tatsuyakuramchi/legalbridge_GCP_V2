import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocumentHtml } from "./render.js";
import { buildTemplateContext, overseasBankVars } from "./template-context.js";

/**
 * 海外版の発注書（148）の Bank Account 欄（A-051）。
 * r1 は銀行名しか出なかった（SWIFT などの差し込み先が無かった）。
 * 値はすべて架空。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const body = readFileSync(
  path.resolve(here, "../../../../../infra/v3/templates/intl_purchase_order_v3_body.html"), "utf8");

const OVERSEAS = {
  bankName: "EXAMPLE BANK N.A.", branchName: "Main Branch", accountNumber: "000111222333",
  holderKana: null, scope: "overseas", holderName: "EXAMPLE STUDIO LLC",
  swiftBic: "EXAMUS33", iban: null, routingNumber: "000000001", country: "US",
  address: "1 Example Street, New York", currency: "USD",
  intermediaryName: "RELAY BANK", intermediarySwift: "RELAUS33"
};

test("海外口座：銀行名だけでなく SWIFT・受取人・口座番号・国・住所・中継銀行が出る", () => {
  const values = buildTemplateContext("intl_purchase_order", { bank: OVERSEAS });
  const out = renderDocumentHtml(body, values);
  for (const text of ["EXAMPLE BANK N.A.", "Main Branch", "SWIFT/BIC: EXAMUS33", "Country: US",
    "Beneficiary: EXAMPLE STUDIO LLC", "Account No.: 000111222333", "Routing No.: 000000001",
    "Currency: USD", "Bank Address: 1 Example Street, New York",
    "Intermediary: RELAY BANK / SWIFT RELAUS33"]) {
    assert.ok(out.includes(text), `${text} が出ていない`);
  }
  assert.ok(!out.includes("IBAN:"), "空の IBAN は出さない");
});

test("IBAN の口座（欧州）は IBAN を出し、口座番号が無ければ Account No. を出さない", () => {
  const out = renderDocumentHtml(body, buildTemplateContext("intl_purchase_order", {
    bank: { ...OVERSEAS, accountNumber: null, routingNumber: null, iban: "GB00EXAM00000000000000",
            intermediaryName: null, intermediarySwift: null, address: null }
  }));
  assert.ok(out.includes("IBAN: GB00EXAM00000000000000"));
  assert.ok(!out.includes("Account No.:"));
  assert.ok(!out.includes("Intermediary:"));
  assert.ok(!out.includes("Bank Address:"));
});

test("受取人名が無い国内口座は名義カナを Beneficiary に出す（ACCOUNT_HOLDER の意味は変えない）", () => {
  const vars = overseasBankVars({ bankName: "みずほ銀行", holderKana: "カ）テスト" });
  assert.equal(vars.BENEFICIARY_NAME, "カ）テスト");
  assert.equal(vars.SWIFT_BIC, "");
  assert.equal(vars.ACCOUNT_SCOPE, "domestic");
  assert.equal("ACCOUNT_HOLDER" in vars, false);
});

test("口座が無ければ Bank Account の行を出さない", () => {
  const out = renderDocumentHtml(body, buildTemplateContext("intl_purchase_order", {}));
  assert.ok(!out.includes("<th>Bank Account</th>"));
  assert.deepEqual(overseasBankVars(null).ACCOUNT_SCOPE, "");
});
