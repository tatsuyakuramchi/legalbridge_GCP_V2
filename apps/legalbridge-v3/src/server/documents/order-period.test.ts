import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deliveryKindFor, formatPeriod, orderPeriodSummary } from "./order-period.js";
import { buildTemplateContext, orderLinesFrom } from "./template-context.js";
import { renderDocumentHtml } from "./render.js";

const body = (file: string) =>
  readFileSync(new URL(`../../../../../infra/v3/templates/${file}`, import.meta.url), "utf8");
const terms = readFileSync(new URL("../../../../../infra/v3/templates/terms_spot_intl_2026.html", import.meta.url), "utf8");

test("期間は同じ年月なら短く書く（仕様欄と同じ October 20 – 25, 2026）", () => {
  assert.equal(formatPeriod("2026-10-20", "2026-10-25", "en"), "October 20 – 25, 2026");
  assert.equal(formatPeriod("2026-10-20", "2026-11-03", "en"), "October 20 – November 3, 2026");
  assert.equal(formatPeriod("2026-12-20", "2027-01-05", "en"), "December 20, 2026 – January 5, 2027");
  assert.equal(formatPeriod("2026-10-20", "2026-10-25", "ja"), "2026年10月20日〜25日");
  assert.equal(formatPeriod("2026-10-20", "2026-11-03", "ja"), "2026年10月20日〜11月3日");
  assert.equal(formatPeriod("2026-10-20", "2026-10-20", "ja"), "2026年10月20日");
  assert.equal(formatPeriod("2026-10-20", null, "en"), "From October 20, 2026");
  assert.equal(formatPeriod(null, "2026-10-25", "ja"), "〜2026年10月25日");
});

test("1 ページ目のまとめ：全部が役務なら見出しは役務提供期間、成果物と混ざれば最古〜最新（明細参照）", () => {
  const service = { delivery_kind: "SERVICE", term_start: "2026-10-20", term_end: "2026-10-25", delivery_date: "2026-10-25" };
  assert.deepEqual(orderPeriodSummary([service], "en"), { heading: "Service period", summary: "October 20 – 25, 2026" });
  assert.deepEqual(orderPeriodSummary([service, { delivery_kind: "DELIVERABLE", delivery_date: "2026-11-10" }], "ja"),
    { heading: "", summary: "2026年10月20日〜11月10日（明細参照）" });
  // 役務の行が無ければ従来どおり（全部を成果物と決めてあれば見出しだけ「納期」）
  assert.equal(orderPeriodSummary([{ delivery_date: "2026-10-25" }], "ja"), null);
  assert.deepEqual(orderPeriodSummary([{ delivery_kind: "DELIVERABLE", delivery_date: "2026-10-25" }], "en"),
    { heading: "Delivery", summary: null });
  // 定期支払の行は数えない
  assert.equal(orderPeriodSummary([{ ...service, calc_method: "SUBSCRIPTION" }], "ja"), null);
});

test("契約形式から既定の納品の形：委任・準委任は役務提供、請負は成果物", () => {
  assert.equal(deliveryKindFor("準委任"), "SERVICE");
  assert.equal(deliveryKindFor("Quasi-mandate"), "SERVICE");
  assert.equal(deliveryKindFor("請負"), "DELIVERABLE");
  assert.equal(deliveryKindFor("利用許諾"), null);
  assert.equal(deliveryKindFor(""), null);
  const [line] = orderLinesFrom({ schedules: [], conditions: [
    { id: 1, name: "撮影立会い", contractForm: "準委任", flatAmount: 100000, termStart: "2026-10-20", termEnd: "2026-10-25" }
  ] });
  assert.equal(line.delivery_kind, "SERVICE");
  assert.equal(line.term_start, "2026-10-20");
});

const serviceItem = {
  item_name: "On-site supervision", spec: "October 20 – 25, 2026", quantity: 1, unit_price: 2000,
  amount_ex_tax: 2000, calc_method: "FIXED", delivery_kind: "SERVICE",
  term_start: "2026-10-20", term_end: "2026-10-25", delivery_date: "2026-10-25", payment_date: "2026-11-30"
};

test("海外発注書：役務提供の品目は 1 ページ目も明細も提供期間を出す", () => {
  const out = renderDocumentHtml(body("intl_purchase_order_v3_body.html"),
    buildTemplateContext("intl_purchase_order", {}, { items: [serviceItem] }), { terms_spot_intl_2026: terms });
  assert.match(out, /<th>Service period<\/th>\s*<td>October 20 – 25, 2026<\/td>/);
  assert.match(out, /Service period: October 20 – 25, 2026/);
  assert.doesNotMatch(out, /Delivery: October 25, 2026/);
});

test("国内発注書：役務提供の品目は 役務提供期間：2026年10月20日〜25日", () => {
  const out = renderDocumentHtml(body("purchase_order_v3_body.html"),
    buildTemplateContext("purchase_order", {}, { items: [serviceItem] }), { terms_spot_2026: "" });
  assert.match(out, /<th>役務提供期間<\/th>\s*<td>2026年10月20日〜25日<\/td>/);
  assert.match(out, /役務提供期間：2026年10月20日〜25日/);
});

test("成果物納品・未選択の品目は従来どおり納期の 1 日", () => {
  const item = { ...serviceItem, delivery_kind: "" };
  const out = renderDocumentHtml(body("intl_purchase_order_v3_body.html"),
    buildTemplateContext("intl_purchase_order", {}, { items: [item] }), { terms_spot_intl_2026: terms });
  assert.match(out, /Delivery <span[^>]*>\(or service period\)<\/span><\/th>\s*<td>October 25, 2026<\/td>/);
  assert.match(out, /Delivery: October 25, 2026/);
  const ja = renderDocumentHtml(body("purchase_order_v3_body.html"),
    buildTemplateContext("purchase_order", {}, { items: [{ ...serviceItem, delivery_kind: "DELIVERABLE" }] }), { terms_spot_2026: "" });
  assert.match(ja, /<th>納期<\/th>/);
  assert.match(ja, /納期：2026年10月25日/);
});
