import assert from "node:assert/strict";
import test from "node:test";
import { buildCommonDocumentContext } from "./context-adapter.js";
import { wrapPrintableHtml, PRINT_STYLESHEET } from "./document-html-renderer.js";

// ── 敬称（個人に「御中」を付けない）─────────────────────────────────────
test("発注先区分が個人なら敬称は「様」", () => {
  const context = buildCommonDocumentContext({ VENDOR_IS_CORPORATION: "個人" });
  assert.equal(context.VENDOR_SUFFIX, "様");
});

test("発注先区分が法人なら敬称は「御中」", () => {
  assert.equal(buildCommonDocumentContext({ VENDOR_IS_CORPORATION: "法人" }).VENDOR_SUFFIX, "御中");
});

test("区分が未入力なら法人として扱う（テンプレートの既定と揃える）", () => {
  assert.equal(buildCommonDocumentContext({}).VENDOR_SUFFIX, "御中");
});

test("敬称を手入力していればそれを優先する（殿など）", () => {
  const context = buildCommonDocumentContext({
    VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "殿"
  });
  assert.equal(context.VENDOR_SUFFIX, "殿");
});

test("区分は boolean でも文字列でも個人を判定できる", () => {
  // 取引先マスタからの自動入力は boolean、フォームの選択は文字列。
  assert.equal(buildCommonDocumentContext({ VENDOR_IS_CORPORATION: false }).VENDOR_SUFFIX, "様");
  assert.equal(buildCommonDocumentContext({ 取引先種別: "個人" }).VENDOR_SUFFIX, "様");
  assert.equal(buildCommonDocumentContext({ vendorEntityType: "個人" }).VENDOR_SUFFIX, "様");
  assert.equal(buildCommonDocumentContext({ VENDOR_IS_CORPORATION: true }).VENDOR_SUFFIX, "御中");
});

test("VENDOR_IS_CORPORATION は法人=「法人」・個人=空文字で返す", () => {
  // 発注書は eq VENDOR_IS_CORPORATION \"法人\"、契約マスタは or VENDOR_IS_CORPORATION …
  // で使う。boolean だと前者が常に偽になり、法人でも会社名欄が出なかった。
  assert.equal(buildCommonDocumentContext({ VENDOR_IS_CORPORATION: "法人" }).VENDOR_IS_CORPORATION, "法人");
  assert.equal(buildCommonDocumentContext({ VENDOR_IS_CORPORATION: "個人" }).VENDOR_IS_CORPORATION, "");
  // 個人が空文字＝falsy なので、真偽判定側も従来どおり「出さない」で動く。
  assert.equal(Boolean(buildCommonDocumentContext({ VENDOR_IS_CORPORATION: "個人" }).VENDOR_IS_CORPORATION), false);
});

test("許諾者側の敬称も同じ規則で導出する", () => {
  assert.equal(buildCommonDocumentContext({ LICENSOR_IS_CORPORATION: false }).LICENSOR_SUFFIX, "様");
  assert.equal(buildCommonDocumentContext({ 許諾者種別: "個人" }).LICENSOR_SUFFIX, "様");
  assert.equal(buildCommonDocumentContext({ 許諾者種別: "法人" }).LICENSOR_SUFFIX, "御中");
});

// ── 印刷レイアウト（用紙と改ページ）─────────────────────────────────────
const FULL_DOCUMENT = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><style>body { padding:16px; }</style></head>
<body><h1>発注書</h1></body>
</html>`;

test("完全なHTMLのテンプレートにも用紙設定と改ページ制御を注入する", () => {
  const wrapped = wrapPrintableHtml(FULL_DOCUMENT);
  assert.match(wrapped, /@page \{ size: A4/);
  assert.match(wrapped, /break-inside: avoid/);
  assert.match(wrapped, /display: table-header-group/);
  // テンプレート本来の内容は保つ（body を作り直さない）。
  assert.match(wrapped, /<h1>発注書<\/h1>/);
  assert.match(wrapped, /body \{ padding:16px; \}/);
});

test("注入位置は head の末尾（テンプレート側の指定より後勝ちにする）", () => {
  const wrapped = wrapPrintableHtml(FULL_DOCUMENT);
  assert.ok(wrapped.indexOf("padding:16px") < wrapped.indexOf("@page"),
    "テンプレートの style より後に置く");
  assert.ok(wrapped.indexOf("@page") < wrapped.indexOf("</head>"), "head の中に置く");
});

test("head の無いHTMLでも用紙設定を当てる", () => {
  const wrapped = wrapPrintableHtml('<html lang="ja"><body><p>本文</p></body></html>');
  assert.match(wrapped, /@page \{ size: A4/);
  assert.match(wrapped, /<p>本文<\/p>/);
});

test("body だけの断片は従来どおり包む", () => {
  const wrapped = wrapPrintableHtml("<h1>検収書</h1>");
  assert.match(wrapped, /^<!doctype html>/);
  assert.match(wrapped, /@page \{ size: A4/);
  assert.match(wrapped, /<body><h1>検収書<\/h1><\/body>/);
});

test("印刷CSSを二重に入れない", () => {
  const wrapped = wrapPrintableHtml(FULL_DOCUMENT);
  assert.equal(wrapped.split(PRINT_STYLESHEET).length - 1, 1);
});

test("長い明細表そのものは分割を許す（丸ごと次ページへ送らない）", () => {
  // table 全体に break-inside: avoid を付けると、1ページに収まらない表が
  // 次ページへ飛んで大きな空白ができる。行と枠だけを対象にする。
  assert.doesNotMatch(PRINT_STYLESHEET, /(^|[\s,{])table\s*[,{]/m);
  assert.match(PRINT_STYLESHEET, /tr,/);
});
