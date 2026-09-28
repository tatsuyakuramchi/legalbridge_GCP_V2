import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderDocumentHtml } from "./render.js";

/**
 * 海外発注書の標準約款（Schedule A）。基本契約なしのときだけ末尾に付く（infra/v3/150）。
 * 部分テンプレートの本文は infra/v3/templates/terms_spot_intl_2026.html。
 */
const terms = readFileSync(new URL("../../../../../infra/v3/templates/terms_spot_intl_2026.html", import.meta.url), "utf8");
const po = `<html><body><p>PO</p>
{{#unless HAS_BASE_CONTRACT}}
{{> terms_spot_intl_2026}}
{{/unless}}
</body></html>`;
const render = (values: Record<string, unknown>) =>
  renderDocumentHtml(po, values, { terms_spot_intl_2026: terms });

test("基本契約なしなら Schedule A が付き、約款の差し込み項目も埋まる", () => {
  const html = render({ HAS_BASE_CONTRACT: false, LATE_PAYMENT_RATE: "14.6%", NDA_SURVIVAL_YEARS: 3 });
  assert.match(html, /Schedule A — Independent Contractor Standard Terms/);
  assert.match(html, /Article 23 — Miscellaneous/);
  assert.match(html, /interest at 14\.6% per annum/);
  assert.match(html, /survive termination for <strong>3 years<\/strong>/);
});

test("基本契約ありなら約款は付けない", () => {
  const html = render({ HAS_BASE_CONTRACT: true });
  assert.doesNotMatch(html, /Schedule A/);
});

test("版の日付が無ければ空の括弧を出さない", () => {
  assert.doesNotMatch(render({ HAS_BASE_CONTRACT: false }), /\(\)/);
  assert.match(render({ HAS_BASE_CONTRACT: false, TERMS_VERSION_DATE: "2026-04-01" }), /\(2026-04-01\)/);
});

test("約款の改ページ・崩れ止めは約款の中だけに効かせる", () => {
  assert.match(terms, /\.terms-wrap \{[^}]*page-break-before: always/);
  assert.doesNotMatch(terms, /^\s*ol, li \{/m, "発注書の本文のリストまで改ページ禁止にしない");
});
