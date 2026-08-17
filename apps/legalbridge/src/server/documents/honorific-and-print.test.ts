import assert from "node:assert/strict";
import test from "node:test";
import { buildCommonDocumentContext } from "./context-adapter.js";
import {
  masterEntityTypeOverrides, wrapPrintableHtml, PRINT_STYLESHEET
} from "./document-html-renderer.js";
import type { RegisteredDocument } from "./registry-repository.js";

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

// ── 区分と敬称が食い違うとき（実データで発生：法人取引先を引いた後に個人名へ変更）─
test("区分=個人・敬称=御中 なら区分を優先して「様」にする", () => {
  const context = buildCommonDocumentContext({
    VENDOR_NAME: "大神貴寛", VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "御中"
  });
  assert.equal(context.VENDOR_SUFFIX, "様");
});

test("区分=法人・敬称=様 なら「御中」にする", () => {
  const context = buildCommonDocumentContext({
    VENDOR_IS_CORPORATION: "法人", VENDOR_SUFFIX: "様"
  });
  assert.equal(context.VENDOR_SUFFIX, "御中");
});

test("「殿」は区分と矛盾とみなさず尊重する", () => {
  // 殿は法人・個人どちらにも使う。手入力を潰すと運用を壊す。
  assert.equal(buildCommonDocumentContext({
    VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "殿"
  }).VENDOR_SUFFIX, "殿");
  assert.equal(buildCommonDocumentContext({
    VENDOR_IS_CORPORATION: "法人", VENDOR_SUFFIX: "殿"
  }).VENDOR_SUFFIX, "殿");
});

test("区分が未入力なら手入力の敬称に従う", () => {
  assert.equal(buildCommonDocumentContext({ VENDOR_SUFFIX: "御中" }).VENDOR_SUFFIX, "御中");
  assert.equal(buildCommonDocumentContext({ VENDOR_SUFFIX: "様" }).VENDOR_SUFFIX, "様");
});

test("許諾者側も同じ規則で矛盾を解消する", () => {
  assert.equal(buildCommonDocumentContext({
    許諾者種別: "個人", LICENSOR_SUFFIX: "御中"
  }).LICENSOR_SUFFIX, "様");
  assert.equal(buildCommonDocumentContext({
    LICENSOR_IS_CORPORATION: false, LICENSOR_SUFFIX: "御中"
  }).LICENSOR_SUFFIX, "様");
});

test("boolean の区分でも矛盾を解消する（マスタ自動入力の形）", () => {
  assert.equal(buildCommonDocumentContext({
    VENDOR_IS_CORPORATION: false, VENDOR_SUFFIX: "御中"
  }).VENDOR_SUFFIX, "様");
  assert.equal(buildCommonDocumentContext({
    VENDOR_IS_CORPORATION: true, VENDOR_SUFFIX: "様"
  }).VENDOR_SUFFIX, "御中");
});

// ── 取引先マスタの区分を正とする（フォームの区分が古くても直る）─────────
const PURCHASE_ORDER: RegisteredDocument = {
  id: 1, documentNumber: "ARC-PO-2026-0115", issueKey: "LEGAL-1",
  templateType: "purchase_order", templateVersionId: 22,
  title: "発注書", counterparty: "大神貴寛", driveLink: "", createdAt: "", createdBy: null,
  // 法人を引いたあと宛名だけ書き換えた状態。区分と敬称に前の法人の値が残っている。
  formData: { VENDOR_NAME: "大神貴寛", VENDOR_IS_CORPORATION: "法人", VENDOR_SUFFIX: "御中" },
  vendorMaster: { entityType: "個人", names: ["大神貴寛"] }
};

test("宛名がマスタと一致すれば、マスタの区分で描画する", () => {
  const overrides = masterEntityTypeOverrides(PURCHASE_ORDER);
  assert.equal(overrides.VENDOR_MASTER_ENTITY_TYPE, "個人");
  // これが form_data より前に効いて、区分＝個人・敬称＝様になる。
  const context = buildCommonDocumentContext({ ...PURCHASE_ORDER.formData, ...overrides });
  assert.equal(context.VENDOR_SUFFIX, "様");
  assert.equal(context.VENDOR_IS_CORPORATION, "");
});

test("マスタが無い文書は従来どおりフォームの区分で描画する", () => {
  assert.deepEqual(masterEntityTypeOverrides({ ...PURCHASE_ORDER, vendorMaster: null }), {});
  assert.deepEqual(masterEntityTypeOverrides({ ...PURCHASE_ORDER, vendorMaster: undefined }), {});
});

test("宛名を別の相手に書き換えた文書ではマスタで上書きしない", () => {
  // vendor_id は確定時の宛名から引いているので、別人へ変えた文書のマスタは他人。
  const overrides = masterEntityTypeOverrides({
    ...PURCHASE_ORDER,
    formData: { ...PURCHASE_ORDER.formData, VENDOR_NAME: "株式会社ビー" }
  });
  assert.deepEqual(overrides, {});
});

test("許諾側の文書でも許諾者の区分をマスタから当てる", () => {
  const overrides = masterEntityTypeOverrides({
    ...PURCHASE_ORDER,
    templateType: "individual_license",
    formData: { Licensor_氏名会社名: "大神貴寛", LICENSOR_SUFFIX: "御中" }
  });
  assert.equal(overrides.LICENSOR_MASTER_ENTITY_TYPE, "個人");
  assert.equal(overrides.VENDOR_MASTER_ENTITY_TYPE, undefined);
  const context = buildCommonDocumentContext({
    Licensor_氏名会社名: "大神貴寛", LICENSOR_SUFFIX: "御中", ...overrides
  });
  assert.equal(context.LICENSOR_SUFFIX, "様");
});

test("マスタが法人なら、フォームに個人が残っていても御中で出す", () => {
  const context = buildCommonDocumentContext({
    VENDOR_NAME: "株式会社エー", VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "様",
    ...masterEntityTypeOverrides({
      ...PURCHASE_ORDER,
      formData: { VENDOR_NAME: "株式会社エー" },
      vendorMaster: { entityType: "法人", names: ["株式会社エー"] }
    })
  });
  assert.equal(context.VENDOR_SUFFIX, "御中");
  assert.equal(context.VENDOR_IS_CORPORATION, "法人");
});
