import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocumentHtml } from "./render.js";
import { blankPlaceholders } from "./preflight.js";
import { LICENSE_TERMS_VARIABLES, licenseScopeSentence, licenseTermsPatch } from "./license-terms.js";

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

const cond = (over: Record<string, any>) => ({
  direction: "in", kind: "license", pricingModel: "revenue_rate", currency: "JPY",
  mgAmount: 0, agAmount: 0, notes: null,
  scopes: { region: [] as string[], language: [] as string[] }, ...over
});

// license-terms.test.ts と同じ形（本番のデータの形）。素材2は形態を画面で選んだ想定。
const context: Record<string, any> = {
  owner: { name: "浅井 崇", phone: "03-5555-6666", email: "asai@example.test" },
  conditions: [
    cond({ id: 11, conditionNo: "CL-2026-00311", name: "ito_原作ゲームデザイン", workPartId: 5,
      work: { title: "ito", part: "ito_原作ゲームデザイン", partType: "game_design" }, ratePct: 3,
      notes: "取引形態: 自社製造・自社販売", scopes: { region: ["日本"], language: ["日本語"] },
      counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 12, conditionNo: "CL-2026-00312", name: "ito_原作ゲームデザイン", workPartId: 5,
      work: { title: "ito", part: "ito_原作ゲームデザイン", partType: "game_design" }, ratePct: 50,
      notes: "取引形態: 権利許諾（サブライセンス）", scopes: { region: ["全世界"], language: [] },
      counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 13, conditionNo: "CL-2026-00313", name: "ito_原作ゲームデザイン", workPartId: 5,
      work: { title: "ito", part: "ito_原作ゲームデザイン", partType: "game_design" }, ratePct: 3,
      notes: "取引形態: 自社製造・他社販売", counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 21, conditionNo: "CL-2026-00321", name: "ito_イラスト", workPartId: 7,
      work: { title: "ito", part: "ito_イラスト", partType: "illustration" }, ratePct: 2,
      notes: "取引形態: 自社製造・自社販売", counterparty: { name: "合同会社アトリエ蒼" } }),
    cond({ id: 23, conditionNo: "CL-2026-00323", name: "ito_イラスト", workPartId: 7,
      work: { title: "ito", part: "ito_イラスト", partType: "illustration" }, ratePct: 2,
      notes: "取引形態: 自社製造・他社販売", counterparty: { name: "合同会社アトリエ蒼" } })
  ],
  acquisitions: [
    { id: 11, conditionNo: "CL-2026-00311", partName: "ito_原作ゲームデザイン", agreementNo: "ARC-ILT-2026-0030" },
    { id: 21, conditionNo: "CL-2026-00321", partName: "ito_イラスト", agreementNo: null }
  ]
};
// 期間・更新・計算書・支払・再許諾は代表の条件明細から（licenseScopeSentence と同じ出どころ）。
context.condition = { ...context.conditions[0], termStart: "2026-10-01", termEnd: "2031-09-30",
  autoRenew: true, renewMonths: 12, statementTiming: "periodic", paymentTerms: "締め日の翌月末日払い",
  sublicensable: true, sublicenseConsent: "required" };

const manual = {
  契約書番号: "ARC-ILT-2026-0041", 発行日: "2026-10-01", 許諾開始日: "2026-10-01",
  基本契約名: "利用許諾基本契約書", work_id: "WRK-10013",
  Licensor_氏名会社名: "株式会社オリジナル", 許諾者種別: "法人",
  Licensor_住所: "東京都千代田区外神田1-1", Licensor_代表者名: "代表取締役 甲野 甲太",
  Licensor_担当者: "甲野 花子", Licensor_メール: "hanako@example.test",
  Licensee_氏名会社名: "株式会社アークライト", Licensee_住所: "東京都千代田区神田小川町1-2",
  Licensee_代表者名: "代表取締役 野澤 邦仁",
  対象製品予定名: "ito 新装版", 独占性: "非独占", v3_maxRegion: "全世界", v3_maxLanguage: "全言語",
  監修者: "甲野 花子",
  v3_sublicensees: [{ slPartner: "サブA社", slRegion: "北米", slLang: "英語",
    slCond: "権利許諾（サブライセンス）", slRate: "50", slDate: "2026-12-01", slNote: "" }],
  v3_special_extras: [{ seId: "1", seText: "初回製造分の見本10部を許諾者に無償で提供する。" }]
};
// 画面は許諾範囲の文を自動で組んで入れる（人が直さなければこの文のまま）。
(manual as Record<string, unknown>).v3_scope = licenseScopeSentence(context, manual);

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
  assert.match(art2, /<th>地域・言語<\/th><td>全世界／全言語<\/td>/);
  // 終了日・自動更新・支払は条件明細から。まとめた文（許諾範囲）に頼らない。
  assert.match(art2, /許諾期間は2026年10月1日から2031年9月30日までとする。期間満了の3か月前までに/);
  assert.match(art2, /許諾料の支払は、締め日の翌月末日払いとする。/);
  assert.match(art2, /事前の書面による承諾を得て、第三者に再許諾することができる。再許諾先は第３条による。/);
  // 取引モデルは許諾料の欄の中で「場面：算定式」として書く。利用の範囲には並べない。
  assert.match(art2, /<b>自社製造・自社販売<\/b>　被許諾者が対象製品を製造し、自ら販売する場合：上代（MSRP）× 数量 × 料率。/);
  assert.match(art2, /<b>権利許諾（サブライセンス）<\/b>　被許諾者が第三者に再許諾し、許諾収入を得る場合：/);
  // 自動で組んだ許諾範囲の文は各欄と同じことなので載せない。
  assert.doesNotMatch(art2, /<th>補足<\/th>/);
  assert.doesNotMatch(out, /本許諾の範囲は、/);
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
