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
 * 試作：個別利用許諾条件書V3 を出版等利用許諾条件書V3 の書式に寄せた本文
 * （infra/v3/templates/individual_license_terms_v3_pubstyle.html）。
 *
 * 見張るのは「計算ブロック（licenseTermsPatch）を1行も変えずに載せ替えられるか」。
 * 本文が差す名前がすべて計算ブロックから出ていれば、ひな形の差し替えだけで済む。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(
  path.resolve(here, "../../../../../infra/v3/templates/individual_license_terms_v3_pubstyle.html"), "utf8");

function renderSample(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...manual, ...licenseTermsPatch(context, manual), ...over };
  return { out: renderDocumentHtml(html, values), values };
}

test("試作の本文が差す名前は、いまの計算ブロックからすべて出る", () => {
  const { values } = renderSample();
  const declared = LICENSE_TERMS_VARIABLES.map((v) => v.name);
  // each の中の名前（lcName・condLabel …）は行の文脈なので外側には無くてよい。
  const rowNames = new Set(["condLabel", "condName", "condType", "calcModel", "basePrice", "appliedRate",
    "condRegion", "condLang", "ag", "mg", "currency", "condDesc", "condFormula", "hasGuarantee", "dealRates", "lcNote", "lcId", "lcName", "lcRole", "lcHolder",
    "lcRegion", "lcLanguage", "lcSourceDoc", "addonRates", "edition", "trigger", "note",
    "slPartner", "slCond", "slRegion", "slLang", "slRate", "slDate", "slNote", "seId", "seText"]);
  const blanks = blankPlaceholders(html, values, declared).filter((n) => !rowNames.has(n));
  assert.deepEqual(blanks, []);
});

test("試作：構成要素1行に取引形態ぶんの料率が並び、最下行が適用料率。条件明細番号は紙に出さない", () => {
  const { out, values } = renderSample();
  const conds = values.conds as any[];
  const lcs = values.lcs as any[];
  assert.deepEqual(conds.map((c) => c.appliedRate), ["5%", "50%", "5%"]);
  assert.equal(lcs[0].lcName, "ito_オリジナルゲームデザイン一式");
  assert.equal(lcs[1].lcName, "ito_イラスト・グラフィック等");
  assert.deepEqual(lcs[0].dealRates, ["3%", "50%", "3%"], "非加算型の料率も列に出す");
  assert.deepEqual(lcs[1].dealRates, ["2%", "—", "2%"]);
  // 条件明細の番号は社内の管理番号。相手方には意味が無いので紙に出さない。
  assert.doesNotMatch(out, /CL-2026-/);
  assert.match(out, /適用料率<\/td>\s*<td class="c">5%<\/td><td class="c">50%<\/td><td class="c">5%<\/td>/);
  assert.ok(out.indexOf("ito_オリジナルゲームデザイン一式") < out.indexOf("ito_イラスト・グラフィック等"));
  assert.match(out, /オリジナルゲームデザインとは、本著作物を構成するゲームデザイン、イラスト、グラフィック、コンポーネント等の総称をいう。/);
  // 構成要素ごとの地域・言語は紙に出さない（第３条の地域・言語と取り違えやすい）。
  assert.doesNotMatch(out, /<span class="lbl">地域<\/span>/);
  assert.match(out, /根拠文書<\/span>本条件書（新規）/);
  // AG・MG が 0 なら書かない。算定式に「料率」を二重に書かない。
  assert.doesNotMatch(out, /最低保証|前払保証金/);
  assert.doesNotMatch(out, /料率 × 料率/);
});

test("試作：許諾内容・期間・地域・言語・許諾料は第２条「許諾条件」1つにまとめる", () => {
  const { out } = renderSample();
  const art = (n: string) => out.indexOf(`第${n}条</span>`);
  const art2 = out.slice(art("２"), art("３"));
  assert.match(art2, /許諾条件<\/h2>/);
  for (const row of ["対象製品", "利用の範囲", "独占性", "地域・言語", "許諾期間", "再許諾", "監修", "許諾料", "算定基準日", "報告・支払"]) {
    assert.match(art2, new RegExp(`<th>${row}</th>`), `${row} の欄がある`);
  }
  // 自社製造・自社販売だけ日本／日本語。取引モデルで違うので内訳を出す。
  assert.match(art2, /<th>地域・言語<\/th><td>全世界／全言語を上限とし、取引モデルごとの地域・言語は次のとおりとする。/);
  assert.match(art2, /<b>自社製造・自社販売<\/b>　日本／日本語<\/div>/);
  assert.match(art2, /<b>権利許諾（サブライセンス）<\/b>　全世界／全言語<\/div>/);
  // 終了日・自動更新・支払は条件明細から。まとめた文（許諾範囲）に頼らない。
  assert.match(art2, /許諾期間は2026年10月1日から2031年9月30日までとする。期間満了の3か月前までに/);
  // 許諾者は法人（Licensor 種別）なので翌月末日。
  assert.match(art2, /締め日の翌月末日までに許諾料計算書を許諾者に送付する。被許諾者は、同日までに許諾料を/);
  assert.match(art2, /事前の書面による承諾を得て、第三者に再許諾することができる。再許諾先は第３条による。/);
  // 取引モデルは許諾料の欄の中で「場面：算定式」として書く。利用の範囲には並べない。
  assert.match(art2, /<b>自社製造・自社販売<\/b>　被許諾者が対象製品を製造し、自ら販売する場合：上代（MSRP）× 数量 × 料率。/);
  assert.match(art2, /<b>権利許諾（サブライセンス）<\/b>　被許諾者が第三者に再許諾し、許諾収入を得る場合：/);
  // 自動で組んだ許諾範囲の文は各欄と同じことなので載せない。
  assert.doesNotMatch(art2, /<th>補足<\/th>/);
  assert.doesNotMatch(out, /本許諾の範囲は、/);
});

test("試作：地域・言語が取引モデルで同じなら内訳を出さず1行にする", () => {
  const same = { ...context, conditions: context.conditions.map((c: any) => ({ ...c,
    scopes: { region: ["全世界"], language: ["日本語", "英語"] } })) };
  same.conditions[0].scopes = { region: ["全世界"], language: ["英語", "日本語"] }; // 並び順だけ違う
  const values: Record<string, unknown> = { ...manual, ...licenseTermsPatch(same, manual) };
  assert.equal(values.scopeVaries, false);
  const out = renderDocumentHtml(html, values);
  assert.match(out, /<th>地域・言語<\/th><td>全世界／全言語<\/td>/);
});

test("試作：許諾者が個人なら報告・支払は翌月20日", () => {
  const person = { ...manual, 許諾者種別: "個人" };
  const values: Record<string, unknown> = { ...person, ...licenseTermsPatch(context, person) };
  const out = renderDocumentHtml(html, values);
  assert.match(out, /<th>報告・支払<\/th><td>被許諾者は、各計算期間の末日で締め、締め日の翌月20日までに/);
});

test("試作：許諾範囲の文を人が直したときだけ「補足」として載せる", () => {
  const edited = { ...manual, v3_scope: "本許諾には、対象製品の拡張セットを含む。" };
  const values: Record<string, unknown> = { ...edited, ...licenseTermsPatch(context, edited) };
  const out = renderDocumentHtml(html, values);
  assert.equal(values.scopeEdited, true);
  assert.match(out, /<th>補足<\/th><td>本許諾には、対象製品の拡張セットを含む。<\/td>/);
});

test("試作：締結時点で再許諾先が無ければ別紙を付けず、条番号は変えない", () => {
  const { out } = renderSample({ sublicensees: [] });
  assert.doesNotMatch(out, /class="annex"/);
  assert.match(out, /第３条<\/span>再許諾/);
  assert.match(out, /締結時点で再許諾先はない/);
  assert.match(out, /第４条<\/span>通知先/);
  assert.match(out, /第５条<\/span>特記事項/);
});

test("試作：再許諾先は署名欄の後ろの別紙（改ページ）に並び、条番号は変えない", () => {
  const { out } = renderSample();
  assert.match(out, /別紙のとおりとする/);
  assert.match(out, /第４条<\/span>通知先/);
  assert.ok(out.indexOf('class="sign"') < out.indexOf('class="annex"'), "別紙は署名欄の後");
  assert.match(out, /別紙　再許諾先一覧/);
  assert.match(out, /個別利用許諾条件書 第３条に基づく/);
  assert.match(out, /<td class="c">1<\/td><td>サブA社<\/td>/);
});

test("試作：署名欄=表示しない で末尾の記名欄を消す", () => {
  assert.match(renderSample().out, /class="sign"/);
  assert.doesNotMatch(renderSample({ 署名欄: "表示しない" }).out, /class="sign"/);
});
