import test from "node:test";
import assert from "node:assert/strict";
import { blankPlaceholders, documentWarnings, referencedNames } from "./preflight.js";

test("本文が差している名前を拾う", () => {
  assert.deepEqual(
    referencedNames("<p>{{A}} と {{{B}}} と {{ C }}</p>"), ["A", "B", "C"]);
});

test("繰り返しの中は見ない（行ごとの項目で、文脈の値ではない）", () => {
  const html = "{{DOC_NO}}{{#each rows}}<td>{{spec}}{{amount}}</td>{{/each}}{{TOTAL}}";
  assert.deepEqual(referencedNames(html), ["DOC_NO", "TOTAL"]);
});

test("条件で囲まれた中も見ない（本文が出す出さないを決めている）", () => {
  // {{#if FAX}}FAX: {{FAX}}{{/if}} は、空なら出さないと本文が言っている。
  assert.deepEqual(referencedNames("{{TEL}}{{#if FAX}}FAX {{FAX}}{{/if}}"), ["TEL"]);
});

test("入れ子の繰り返しも畳む", () => {
  const html = "{{A}}{{#each xs}}{{#if y}}{{z}}{{/if}}{{w}}{{/each}}{{B}}";
  assert.deepEqual(referencedNames(html), ["A", "B"]);
});

test("ヘルパとパス付きは値として見ない", () => {
  assert.deepEqual(
    referencedNames("{{@index}}{{this.name}}{{../up}}{{!メモ}}{{> part}}{{X}}"), ["X"]);
});

test("空で出るものだけ挙げる", () => {
  const blank = blankPlaceholders(
    "{{A}}{{B}}{{C}}{{D}}", { A: "値", B: "", C: "   ", D: null });
  assert.deepEqual(blank, ["B", "C", "D"]);
});

test("ひな形が宣言している項目は重ねて出さない", () => {
  // 宣言済みの未入力は bindVariables が missing として別に報告する。
  assert.deepEqual(blankPlaceholders("{{A}}{{B}}", { A: "", B: "" }, ["A"]), ["B"]);
});

test("振込先の欠けは、何が無いかまで言う", () => {
  const w = documentWarnings(
    "{{BANK_NAME}}{{BRANCH_NAME}}{{ACCOUNT_NUMBER}}{{ACCOUNT_HOLDER_KANA}}",
    { BANK_NAME: "", BRANCH_NAME: "", ACCOUNT_NUMBER: "2513200",
      ACCOUNT_HOLDER_KANA: "カ）アトリエアオ" });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "bank");
  assert.match(w[0].message, /銀行名・支店名/);
  assert.doesNotMatch(w[0].message, /口座番号/, "入っているものは挙げない");
});

test("自社情報の空欄は、どこで直すかまで言う", () => {
  const w = documentWarnings("{{COMPANY_TEL}}{{COMPANY_INVOICE_NO}}",
    { COMPANY_TEL: "", COMPANY_INVOICE_NO: "" });
  assert.equal(w[0].kind, "company");
  assert.match(w[0].message, /自社電話番号・自社の登録番号/);
  assert.match(w[0].message, /運用＞設定＞自社情報/);
});

test("埋まっていれば何も言わない", () => {
  assert.deepEqual(documentWarnings("{{BANK_NAME}}{{COMPANY_TEL}}",
    { BANK_NAME: "みずほ銀行", COMPANY_TEL: "03-6811-0730" }), []);
});

/**
 * 本番の検収書の本文（振込先の並びをそのまま写したもの）。
 * 実際に「口座番号と名義だけ」の書類が発行されたときの形。
 */
const INSPECTION = `
<h1>検収書</h1>
<p>担当：{{STAFF_NAME}}</p>
{{#each delivery_line_items}}<tr><td>{{spec}}</td><td>{{amount_ex_tax}}</td></tr>{{/each}}
<p>消費税({{taxRate}}%) ¥{{taxAmountStr}}</p>
<h2>■ 振込先</h2>
<p>{{BANK_NAME}} {{BRANCH_NAME}}<br>{{ACCOUNT_TYPE}} {{ACCOUNT_NUMBER}}<br>
口座名義: {{ACCOUNT_HOLDER_KANA}}</p>
<p>{{COMPANY_NAME}}／{{COMPANY_ADDRESS}}／TEL {{COMPANY_TEL}}／{{COMPANY_INVOICE_NO}}</p>`;

test("実物の検収書で、あの不完全な振込先が発行前に挙がる", () => {
  const w = documentWarnings(INSPECTION, {
    STAFF_NAME: "倉持", taxRate: 10, taxAmountStr: "28,000",
    BANK_NAME: "", BRANCH_NAME: "", ACCOUNT_TYPE: "",
    ACCOUNT_NUMBER: "2513200", ACCOUNT_HOLDER_KANA: "カ）アトリエアオ",
    COMPANY_NAME: "株式会社アークライト", COMPANY_ADDRESS: "東京都千代田区神田小川町1-2",
    COMPANY_TEL: "", COMPANY_INVOICE_NO: "T5010001009670"
  }, ["STAFF_NAME", "taxRate", "taxAmountStr"]);

  const kinds = w.map((x) => x.kind);
  assert.deepEqual(kinds, ["bank", "company"], "行ごとの項目は挙がらない");
  assert.match(w[0].message, /銀行名・支店名・口座種別/);
  assert.match(w[1].message, /自社電話番号/);
});
