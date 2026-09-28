import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderDocumentHtml } from "./render.js";

/**
 * 海外発注書の標準約款（Cross-Border Spot Order 用・2026 改訂版 Rev. 2026-09-28）。基本契約なしのときだけ末尾に付く（infra/v3/151）。
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

test("基本契約なしなら Cross-Border 用の Standard Terms が付き、発注書の番号が入る", () => {
  const html = render({ HAS_BASE_CONTRACT: false, ORDER_NO: "ARC-IPO-2026-1001" });
  assert.match(html, /STANDARD TERMS AND CONDITIONS FOR SERVICE OUTSOURCING/);
  assert.match(html, /Article 21 — Language; Matters Not Stipulated/);
  assert.equal((html.match(/<h3/g) ?? []).length, 21, "全 21 条");
  assert.doesNotMatch(html, /\[●\]/, "原本の [●] は発注書番号で埋める");
  assert.match(html, /Rev\. 2026-09-28/);
  assert.match(html, /Exhibit to Purchase Order No\. ARC-IPO-2026-1001/);
  assert.match(html, /governed by the laws of Japan/);
});

test("基本契約ありなら約款は付けない", () => {
  const html = render({ HAS_BASE_CONTRACT: true, ORDER_NO: "ARC-IPO-2026-1001" });
  assert.doesNotMatch(html, /STANDARD TERMS/);
});

test("約款は改ページして始める", () => {
  assert.match(terms, /page-break-before:always/);
});

test("海外発注書：受注者のメール・住所は入力欄（CONTRACTOR_*）の値を通知先に出す（約款 18 条）", () => {
  const body = readFileSync(new URL("../../../../../infra/v3/templates/intl_purchase_order_v3_body.html", import.meta.url), "utf8");
  const out = renderDocumentHtml(body, {
    VENDOR_NAME: "Noa Vassalli", CONTRACTOR_EMAIL: "noa@example.com", CONTRACTOR_ADDRESS: "Via Quintino Sella 2, Milano, Italy",
    HAS_BASE_CONTRACT: true
  }, { terms_spot_intl_2026: terms });
  assert.match(out, /To the Contractor<\/th>\s*<td>Noa Vassalli[^<]*E-mail: noa@example\.com/);
  assert.match(out, /Via Quintino Sella 2, Milano, Italy/);
  // 入力欄が空なら取引先マスタの値
  const fallback = renderDocumentHtml(body, { VENDOR_NAME: "Noa", VENDOR_EMAIL: "master@example.com", HAS_BASE_CONTRACT: true },
    { terms_spot_intl_2026: terms });
  assert.match(fallback, /E-mail: master@example\.com/);
});
