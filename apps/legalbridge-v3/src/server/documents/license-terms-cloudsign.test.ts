import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocumentHtml } from "./render.js";
import { blankPlaceholders } from "./preflight.js";
import { LICENSE_TERMS_VARIABLES, licenseTermsPatch } from "./license-terms.js";
import { context, manual } from "./license-terms.fixture.js";

/**
 * 試作：個別利用許諾条件書V3 の CloudSign 版
 * （infra/v3/templates/individual_license_terms_v3_cloudsign.html。利用者の
 * CloudSign_LicenseTerms_v6_fixed.docx をひな形にしたもの）。
 *
 * 見張るのは、docx の文言・構成が条件明細と条件書の欄からそのまま組めること。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(
  path.resolve(here, "../../../../../infra/v3/templates/individual_license_terms_v3_cloudsign.html"), "utf8");

function renderSample(over: Record<string, unknown> = {}, base: Record<string, unknown> = manual) {
  const values: Record<string, unknown> = { ...base, ...licenseTermsPatch(context, base), ...over };
  return { out: renderDocumentHtml(html, values), values };
}
const between = (out: string, from: string, to: string) => out.slice(out.indexOf(from), out.indexOf(to));

test("CloudSign 版：本文が差す名前は、いまの計算ブロックからすべて出る", () => {
  const { values } = renderSample();
  const rowNames = new Set(["condName", "condNameEn", "condExclusivity", "condRegion", "condLang", "appliedRate",
    "condFormulaRated", "hasGuarantee", "ag", "mg", "currency", "lcName", "lcRole", "lcHolder", "lcNote",
    "lcSourceDoc", "dealRates", "edition", "trigger", "note", "seId", "seText",
    "slPartner", "slCond", "slRegion", "slLang", "slRate", "slDate", "slNote"]);
  const blanks = blankPlaceholders(html, values, LICENSE_TERMS_VARIABLES.map((v) => v.name))
    .filter((n) => !rowNames.has(n));
  assert.deepEqual(blanks, []);
});

test("CloudSign 版：見出し・当事者・本文 01〜04 が docx のとおりに出る", () => {
  const { out } = renderSample();
  assert.match(out, /<span class="k">ISSUED<\/span><b>2026\.10\.01<\/b>/);
  assert.match(out, /<span class="k">NO\.<\/span><b>ARC-ILT-2026-0041<\/b>/);
  assert.match(out, /<span class="k">WORK ID<\/span><b>WRK-10013<\/b>/);
  assert.match(out, /両者間の利用許諾基本契約書（以下「基本契約」という。）に基づき/);
  for (const h of ["01</span>対象著作物", "02</span>許諾条件", "03</span>再許諾", "04</span>通知先"]) {
    assert.ok(out.includes(h), h);
  }
  assert.match(out, /content: "ARC-ILT-2026-0041　個別利用許諾条件書"/, "フッターに条件書番号");
});

test("CloudSign 版：許諾条件。期間は開始日だけで終了・更新は基本契約に従う。再許諾は承諾要", () => {
  const art2 = between(renderSample().out, "02</span>許諾条件", "03</span>再許諾");
  assert.match(art2, /「ito 新装版」（以下「対象製品」という。）/);
  assert.match(art2, /本許諾の開始日は2026年10月1日とする。本許諾の終了、更新その他の有効期間に関する事項は、利用許諾基本契約書の定めに従う。/);
  assert.match(art2, /許諾者の事前の書面による承諾を得た場合に限り/);
  assert.match(art2, /許諾者が指定する監修者（甲野 花子）/);
  assert.match(art2, /別紙1「特記事項」に定める/);
});

test("CloudSign 版：取引モデル別の許諾範囲（独占性・地域・言語）を表で出す", () => {
  const art2 = between(renderSample().out, "02</span>許諾条件", "03</span>再許諾");
  assert.match(art2, /<td>自社製造・自社販売<\/td><td>非独占<\/td><td>日本<\/td><td>日本語<\/td>/);
  assert.match(art2, /<td>権利許諾（サブライセンス）<\/td><td>非独占<\/td><td>全世界<\/td><td>全言語<\/td>/);
  // 独占性は条件明細ごと。条件明細が独占なら、その取引モデルだけ独占と出る。
  const exclusive = { ...context, conditions: context.conditions.map((c: any) =>
    c.id === 12 ? { ...c, exclusivityLabel: "独占" } : c) };
  const values = { ...manual, ...licenseTermsPatch(exclusive, manual) };
  const out = renderDocumentHtml(html, values);
  assert.match(out, /<td>権利許諾（サブライセンス）<\/td><td>独占<\/td>/);
  assert.match(out, /<td>自社製造・自社販売<\/td><td>非独占<\/td>/, "条件明細に無ければ書類の独占性");
});

test("CloudSign 版：許諾料はカードで、算定式に適用料率を埋める。報告・支払は1文", () => {
  const art2 = between(renderSample().out, "02</span>許諾条件", "03</span>再許諾");
  assert.match(art2, /<span class="en">SELF-PUBLISHING<\/span>\s*<div class="name">自社製造・自社販売<\/div>\s*<div class="rate">適用料率<b>5%<\/b><\/div>\s*<div class="f">上代（MSRP）× 数量 × 5%<\/div>/);
  assert.match(art2, /<span class="en">SUBLICENSE<\/span>[\s\S]*?許諾収入 × 50%/);
  assert.match(art2, /<span class="en">WHOLESALE<\/span>[\s\S]*?供給価格 × 数量 × 5%/);
  assert.match(art2, /数量の基準日は、初版については発売日、2版以降については製造日とする。/);
  assert.match(art2, /締日の翌月末日までに許諾料計算書を許諾者に交付するとともに、同日までに算定された許諾料を許諾者の指定する銀行口座へ振り込む方法により支払うものとする。/);
  const person = renderSample({}, { ...manual, 許諾者種別: "個人" }).out;
  assert.match(person, /締日の翌月20日までに許諾料計算書を許諾者に交付するとともに、同日までに算定された許諾料を/);
  // 条件明細に支払条件が入っていても、報告日・支払日は種別のルールで出す。
  const withTerms = { ...context, condition: { ...context.condition, paymentTerms: "月末締め翌々月末払い" } };
  const out = renderDocumentHtml(html, { ...manual, ...licenseTermsPatch(withTerms, manual) });
  assert.match(out, /締日の翌月末日までに許諾料計算書を許諾者に交付するとともに、同日までに/);
  assert.doesNotMatch(out, /翌々月末払い/);
});

test("CloudSign 版：別紙は署名欄の後ろに改ページ。別紙1 特記事項・別紙2 対象著作物一覧・別紙3 再許諾先一覧", () => {
  const { out } = renderSample({ sublicensees: [
    { slPartner: "サブA社", slRegion: "北米", slLang: "英語", slCond: "権利許諾（サブライセンス）", slRate: "50", slDate: "2026-12-01" },
    { slPartner: "サブB社", slRegion: "ドイツ", slLang: "ドイツ語", slCond: "権利許諾（サブライセンス）", slRate: "50", slDate: "2027-03-15", slNote: "MG 500,000円を別途受領" }
  ] });
  assert.ok(out.indexOf('class="sign"') < out.indexOf('<div class="annex">'));
  assert.match(out, /別紙1<\/span>特記事項/);
  assert.match(out, /\(1\) 初回製造分の見本10部を許諾者に無償で提供する。/);
  // 別紙の見出しは3つとも同じ形。
  for (const h of ["別紙1</span>特記事項", "別紙2</span>対象著作物一覧", "別紙3</span>再許諾先一覧"]) {
    assert.ok(out.includes(`<h2><span class="no">${h}`), h);
  }
  // 料率の列の見出しは語の切れ目で2行にする。
  assert.match(out, /<th class="c" style="width:22mm">自社製造<span class="l2">自社販売<\/span><\/th>/);
  assert.match(out, /権利許諾<span class="l2">（サブライセンス）<\/span>/);
  assert.match(out, /<b>ito_オリジナルゲームデザイン一式<\/b><span class="role">コアロジック<\/span>/);
  assert.match(out, /根拠文書　ARC-ILT-2026-0030/);
  assert.match(out, /<td>サブB社<\/td>.*<td class="c">2027\.03\.15<\/td><\/tr>\s*<tr class="memo"><td><\/td><td>備考<\/td><td colspan="4">MG 500,000円を別途受領<\/td>/s);
});

test("CloudSign 版：締結時点で再許諾先が無ければ別紙3は空の行。特記事項が無ければ「なし」", () => {
  const { out } = renderSample({ sublicensees: [], specialExtras: [] });
  assert.match(out, /（本条件書の締結時点で再許諾先はない）/);
  assert.match(out, /<td class="k">特記事項<\/td><td>なし<\/td>/);
  assert.doesNotMatch(out, /別紙1「特記事項」に定める/);
  assert.match(out, /別紙1<\/span>特記事項<span class="en">SPECIAL TERMS<\/span><\/h2>\s*<p>なし<\/p>/);
  assert.match(out, /別紙2<\/span>対象著作物一覧/);
});

test("CloudSign 版：再許諾できない条件なら、そう書いて承諾の文を出さない", () => {
  const none = { ...context, condition: { ...context.condition, sublicensable: false } };
  const values = { ...manual, ...licenseTermsPatch(none, manual) };
  const out = renderDocumentHtml(html, values);
  assert.match(out, /第三者に対して対象著作物の利用を再許諾することができない。/);
  assert.doesNotMatch(out, /事前の書面による承諾を得た場合に限り/);
});

test("CloudSign 版：署名欄は署名版と押印版。署名日・署名の枠は空のまま（年月日を刷らない）", () => {
  const sign = between(renderSample({ 署名欄: "署名" }).out, '<table class="sign">', "<!-- 別紙。");
  assert.equal((sign.match(/<span class="lbl">署名日<\/span><span class="box"><\/span>/g) ?? []).length, 2, "両者に署名日の枠");
  assert.equal((sign.match(/<span class="lbl">署名<\/span><span class="box"><\/span>/g) ?? []).length, 2, "両者に署名の枠");
  assert.doesNotMatch(sign, /class="stamp"/);
  assert.doesNotMatch(sign, /年\s*月\s*日/, "署名日は自由記入なので年月日を刷らない");

  const seal = between(renderSample({ 署名欄: "押印" }).out, '<table class="sign">', "<!-- 別紙。");
  assert.equal((seal.match(/class="stamp">印</g) ?? []).length, 2, "両者に印の枠");
  assert.equal((seal.match(/署名日<\/span><span class="box">/g) ?? []).length, 2, "押印版も署名日の枠");
  assert.doesNotMatch(seal, /<span class="lbl">署名<\/span>/, "押印版に署名の枠は無い");

  // 空欄・以前の「表示する」は署名版。
  for (const value of ["", "表示する"]) {
    assert.match(renderSample({ 署名欄: value }).out, /<span class="lbl">署名<\/span><span class="box">/);
  }
  assert.doesNotMatch(renderSample({ 署名欄: "表示しない" }).out, /<table class="sign">/);
});

test("CloudSign 版：署名日・署名・通知先の枠は高さ 12pt 固定", () => {
  assert.match(html, /\.field \.box \{[^}]*height: 12pt;/);
  assert.match(html, /\.notice \.fix \{[^}]*height: 12pt;/);
  const out = renderSample().out;
  assert.match(out, /<td class="k"><div class="fix">許諾者<\/div><\/td><td><div class="fix">甲野 花子 ／ hanako@example.test<\/div><\/td>/);
});
