import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocumentHtml } from "./render.js";
import { blankPlaceholders } from "./preflight.js";
import { PUB_TERMS_VARIABLES, pubTermsPatch, pubTitleSeeds } from "./pub-terms.js";
import { bankInfoLine } from "./template-context.js";

/**
 * ひな形の本文は infra/v3 の SQL が運ぶ（本番に流すのはその SQL）。いまの版は
 * 129 が運ぶ2本（1本目＝一覧形式、2本目＝別紙形式）。
 * ここは同じ SQL から本文を取り出して描画し、本文が差す名前と計算ブロックが
 * 出す名前がずれていないかを見張る。片方だけ直すと空欄の紙が出る。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
/** SQL の n 本目（0 始まり）の $html$ … $html$ を取り出す。 */
const bodyOf = (file: string, index = 0) => {
  const sql = readFileSync(path.resolve(here, `../../../../../infra/v3/${file}`), "utf8");
  let from = 0;
  for (let i = 0; i < index; i += 1) {
    from = sql.indexOf("$html$", sql.indexOf("$html$", from) + 6) + 6;
  }
  const start = sql.indexOf("$html$", from) + "$html$".length;
  const end = sql.indexOf("$html$", start);
  assert.ok(start > 5 && end > start, `${file} に ${index + 1} 本目の $html$ … $html$ がある`);
  return sql.slice(start, end);
};
/** 一覧形式（作品が少ないとき。一覧は第１条）。 */
const listHtml = bodyOf("129_pub_license_terms_derivative.sql", 0);
/** 別紙形式（作品が多いとき。一覧は別紙1）。 */
const annexHtml = bodyOf("129_pub_license_terms_derivative.sql", 1);
// 既存の試験はこれまでどおり別紙形式の本文で通す（項目は2本立てで同じ）。
const html = annexHtml;

const cond = (over: Record<string, any>) => ({
  direction: "in", kind: "license", pricingModel: "revenue_rate", currency: "JPY",
  exclusivity: "non_exclusive", exclusivityLabel: "非独占", notes: null, counterpartyId: 5,
  termStart: "2026-10-01", termEnd: "2031-09-30",
  scopes: { region: ["全世界"], language: ["日本語"], media: [] as string[] }, ...over
});
const context: Record<string, any> = {
  document: { number: "ARC-PUBT-2026-0041", issuedOn: "2026-10-01" },
  company: { name: "株式会社サンプル出版", address: "東京都文京区本郷", rep: "代表取締役 乙山 乙子", invoiceNo: "T9876543210987" },
  agreement: { no: "ARC-PUBM-2025-0003", title: "出版等利用許諾基本契約書", autoRenewal: true, renewalNoticeMonths: 1 },
  contacts: [{ role: "primary", name: "甲野 甲太", email: "kono@example.test", phone: "03-0000-0000", department: null }],
  owner: { name: "編集 花子", email: "hanako@example.test", phone: "03-1111-1111", department: "編集部" },
  bank: { bankName: "〇〇銀行", branchName: "本店", accountType: "ordinary", accountNumber: "0000000", holderKana: "コウノ コウタ" },
  conditions: [
    cond({ id: 1, conditionNo: "CL-2026-00451", name: "星降る夜のはなし（単行本）", workId: 10,
      work: { title: "星降る夜のはなし" }, ratePct: 11, notes: "初版100部（見本・献本除く）", scopes: { region: ["全世界"], language: ["日本語"], media: ["紙"] } }),
    cond({ id: 2, conditionNo: "CL-2026-00452", name: "星降る夜のはなし（単行本）", workId: 10,
      work: { title: "星降る夜のはなし" }, ratePct: 15, scopes: { region: ["全世界"], language: ["日本語"], media: ["電子"] } }),
    cond({ id: 3, conditionNo: "CL-2026-00453", name: "ねこの図書館 ①", workId: 11,
      work: { title: "ねこの図書館" }, ratePct: 10, exclusivity: "exclusive", exclusivityLabel: "独占", scopes: { region: [], language: [], media: ["紙"] } })
  ]
};
context.condition = { ...context.conditions[0],
  counterparty: { name: "甲野 甲太", kind: "individual", address: "東京都千代田区", invoiceNo: null, withholding: true } };

function render(manual: Record<string, unknown>) {
  const patch = pubTermsPatch(context, manual);
  const values = { taxRate: 10, BANK_INFO: bankInfoLine(context.bank), ...patch };
  return { out: renderDocumentHtml(html, values), values };
}

test("本文が差す名前はすべて計算ブロックから出る（空欄で出る差し込みが無い）", () => {
  const rows = pubTitleSeeds(context);
  rows[0] = { ...rows[0], copyright: "© 2026 甲野 甲太", third_party: "なし" };
  const { out, values } = render({ pub_titles: rows, "翻訳版取り分": "50", "特記事項": "電子署名で締結する。",
    // 相手先の担当者は自動で入らないので、手入力（候補から入れる想定）。
    "許諾者連絡先": "甲野 甲太 ／ kono@example.test ／ 03-0000-0000" });
  const blanks = blankPlaceholders(html, values, PUB_TERMS_VARIABLES.map((v) => v.name));
  // 行の中の名前（no / title …）は each の文脈なので、外側の値には無くてよい。
  const rowNames = new Set(["no", "title", "edition", "copyright", "thirdParty", "printRate", "printExclusivity",
    "digitalRate", "digitalExclusivity", "note", "hasPrint", "hasDigital",
    "translation", "translationLines", "hasTranslation", "translationConsent", "showTranslation"]);
  const outside = blanks.filter((name) => !rowNames.has(name));
  assert.deepEqual(outside, [], `空欄で出る差し込み: ${outside.join(", ")}`);
  assert.ok(!out.includes("{{"), "差し込みが残っていない");
  assert.ok(out.includes("size: A4 portrait"), "A4 縦");
  assert.ok(out.includes("2026年10月1日"), "締結日は和暦風の表記");
  assert.ok(out.includes("11%／非独占"), "紙の料率と独占区分");
  assert.ok(out.includes("15%／非独占"), "電子の料率と独占区分");
  assert.ok(out.includes("<td class=\"c\">—</td>"), "電子の無い作品は「—」だけ");
  assert.ok(out.includes("10%／独占"));
  assert.ok(out.includes("© 2026 甲野 甲太"));
  assert.ok(out.includes("初版100部（見本・献本除く）"));
  assert.ok(out.includes("対価（税抜）の 50%"), "翻訳版の行");
  assert.ok(out.includes("〇〇銀行 / 本店 / 普通 0000000 / コウノ コウタ"), "振込先は取引先の口座");
  assert.ok(out.includes("源泉徴収し"), "個人の許諾者は源泉あり");
  assert.ok(out.includes("甲野 甲太 ／ kono@example.test ／ 03-0000-0000"), "手で入れた通知先が出る");
  assert.ok(out.includes("編集部 ／ 編集 花子"));
  assert.ok(out.includes("1か月前までに"), "合意の更新通知が入る");
  assert.ok(out.includes("第１０条"), "特記事項あり");
});

test("翻訳版なし・署名欄なし・法人の許諾者・期間の定めなし", () => {
  const corp = { ...context, condition: { ...context.condition,
    counterparty: { name: "株式会社甲", kind: "corporate", withholding: false } },
    conditions: context.conditions.map((c: any) => ({ ...c, termEnd: null })) };
  const patch = pubTermsPatch(corp, { "署名欄": "表示しない", "特記事項": "" });
  const out = renderDocumentHtml(html, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(!out.includes("翻訳版"), "翻訳版の行が無い");
  assert.ok(!out.includes("class=\"sign\""), "署名欄が無い");
  assert.ok(out.includes("甲が法人であるため源泉徴収は行わない"));
  assert.ok(out.includes("期間の定めなし"));
  assert.ok(!out.includes("第１０条"));
  assert.ok(!out.includes("{{"));
});

test("r5：一覧は別紙1に出て、本文の第１条は点数の要約になる", () => {
  const rows = pubTitleSeeds(context);
  const { out } = render({ pub_titles: rows, "許諾者連絡先": "甲 ／ k@example.test" });
  // 第１条は要約。一覧そのものは署名欄より後ろ（別紙）にある。
  assert.ok(out.includes("別紙1「対象著作物一覧」"), "第１条が別紙を指す");
  assert.ok(out.includes("（全 2 点）"), `作品数が入る: ${out.slice(out.indexOf("別紙1「対象著作物一覧」") - 40, out.indexOf("別紙1「対象著作物一覧」") + 60)}`);
  assert.ok(out.indexOf('class="sign"') < out.indexOf("別紙1　対象著作物一覧"), "別紙は署名欄より後ろ");
  assert.ok(out.indexOf("別紙1　対象著作物一覧") < out.indexOf('<table class="titles"'), "別紙の中に一覧がある");
  // 条文が消えた「第１条一覧」を指したままだと、別紙と食い違う。
  assert.ok(!out.includes("第１条一覧"), "参照先は別紙に直っている");
  assert.ok(out.includes("別紙1の「紙」欄"), "第２条・第４条が別紙を指す");
  assert.ok(out.includes("page-break-before: always"), "別紙は改ページして始まる");
});

test("2本立て：一覧形式は第１条に表、別紙形式は別紙1に表。項目は同じ", () => {
  // 一覧形式（作品が少ないとき）。表が署名欄より前にある。
  assert.ok(!listHtml.includes("別紙1　対象著作物一覧"), "一覧形式に別紙は無い");
  assert.ok(listHtml.indexOf('<table class="titles"') < listHtml.indexOf('class="sign"'), "表は署名欄より前");
  assert.ok(listHtml.includes("第１条一覧「紙」欄"), "条文は第１条の一覧を指す");
  // 別紙形式（作品が多いとき）。表は署名欄より後ろ。
  assert.ok(annexHtml.indexOf('class="sign"') < annexHtml.indexOf("別紙1　対象著作物一覧"), "別紙は署名欄より後ろ");
  assert.ok(annexHtml.includes("別紙1の「紙」欄"), "条文は別紙を指す");
  // どちらも同じ名前を差す（項目は1つの定義で足りる）。
  for (const name of ["docNo", "signDate", "licensorName", "licenseeName", "#each titles"]) {
    assert.ok(listHtml.includes(name) && annexHtml.includes(name), `${name} は両方にある`);
  }
});

/**
 * 翻訳版再許諾（A-033）。作品ごとに率が違うので、条文に率は書かず一覧の欄に出す。
 * 別途合意の要否も作品ごとなので、第２条は 要／不要／混在 で言い方が変わる。
 */
const withTranslation = (over: Array<Record<string, any>>): Record<string, any> =>
  ({ ...context, conditions: [...context.conditions, ...over] });
const trans = (id: number, workId: number, title: string, usageType: string,
               ratePct: number, consent: "covered" | "required") =>
  cond({ id, conditionNo: `CL-2026-004${id}`, name: `${title}｜翻訳版再許諾`, workId,
         work: { title }, ratePct, usageType, sublicenseConsent: consent,
         scopes: { region: ["全世界"], language: [], media: [] } });

test("翻訳版再許諾：一覧に「紙 50%／電子 40%」と別途合意の要否が出て、第４条が一覧を指す", () => {
  const ctx = withTranslation([
    trans(4, 10, "星降る夜のはなし", "pub_sub_print", 50, "required"),
    trans(5, 10, "星降る夜のはなし", "pub_sub_digital", 40, "required")
  ]);
  const patch = pubTermsPatch(ctx, { "許諾者連絡先": "甲 ／ k@example.test" });
  const out = renderDocumentHtml(annexHtml, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(!out.includes("{{"));
  assert.ok(out.includes("翻訳版再許諾<br>料率／別途合意"), "一覧に列が出る");
  assert.ok(out.includes('class="titles withtrans"'), "列があるぶん幅を詰める");
  assert.ok(out.includes("<span class=\"m\">紙 50%</span><span class=\"m\">電子 40%</span>"),
    "紙・電子の率を1つの欄に（行は分ける）");
  assert.ok(out.includes("別途合意 要"), "要否が同じ欄に添う");
  assert.ok(out.includes("別紙1「翻訳版再許諾」欄"), "第４条は一覧の欄を指す");
  assert.ok(!out.includes("対価（税抜）の 50%"), "条文に率は書かない（作品ごとに違う）");
  assert.ok(out.includes("甲乙が別途書面で合意する"), "第２条は「要」の書き方");
  // 翻訳版が無い作品の欄は「—」のまま。
  assert.ok(out.includes('<td class="trans">—</td>'));
});

test("翻訳版再許諾：別途合意が作品ごとに違うときは、第２条が一覧の欄で書き分ける", () => {
  const ctx = withTranslation([
    trans(4, 10, "星降る夜のはなし", "pub_sub_print", 50, "required"),
    trans(6, 11, "ねこの図書館", "pub_sub_print", 30, "covered")
  ]);
  const patch = pubTermsPatch(ctx, { "許諾者連絡先": "甲 ／ k@example.test" });
  assert.equal(patch.translationConsentMixed, true);
  const out = renderDocumentHtml(annexHtml, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(out.includes("「別途合意 要」とある作品は"), "要の作品の書き方");
  assert.ok(out.includes("「別途合意 不要」とある作品は"), "不要の作品の書き方");
  assert.ok(out.includes("紙 50%"), "作品ごとの率");
  assert.ok(out.includes("紙 30%"));
});

test("翻訳版再許諾：すべて不要なら、第２条は個別の承諾を要しないと書く", () => {
  const ctx = withTranslation([trans(4, 10, "星降る夜のはなし", "pub_sub_print", 50, "covered")]);
  const patch = pubTermsPatch(ctx, { "許諾者連絡先": "甲 ／ k@example.test" });
  assert.equal(patch.translationConsentAllCovered, true);
  assert.equal(patch.translationConsentRequired, false);
  const out = renderDocumentHtml(annexHtml, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(out.includes("甲の個別の事前承諾を要しない"));
  assert.ok(!out.includes("「別途合意 要」とある作品は"));
  assert.ok(out.includes("別途合意 不要"), "一覧の欄には要否が出る");
});

test("翻訳版の条件が無ければ、これまでどおり手入力の取り分で書く（列は出ない）", () => {
  const patch = pubTermsPatch(context, { "翻訳版取り分": "50", "許諾者連絡先": "甲 ／ k@example.test" });
  const out = renderDocumentHtml(annexHtml, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(out.includes("対価（税抜）の 50%"), "第４条は手入力の取り分");
  assert.ok(!out.includes("翻訳版再許諾<br>料率／別途合意"), "一覧に列は出ない");
  assert.ok(!out.includes('class="titles withtrans"'), "表の幅も元のまま");
});

/**
 * 翻訳の立て付け（A-034）。「翻訳は二次的著作物だ」という取引先のために、
 * 条文の書き方を条件書ごとに選べる。許諾料の計算は変わらない。
 */
const derivCtx = () => withTranslation([
  trans(4, 10, "星降る夜のはなし", "pub_sub_print", 50, "required"),
  trans(5, 10, "星降る夜のはなし", "pub_sub_digital", 40, "required")
]);

test("二次的著作物：翻訳権（27条・28条）で書き、翻訳物の著作権と終了後の扱いが増える", () => {
  const patch = pubTermsPatch(derivCtx(), { "翻訳の扱い": "二次的著作物", "許諾者連絡先": "甲" });
  const out = renderDocumentHtml(annexHtml, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(!out.includes("{{"));
  assert.ok(out.includes("著作権法第27条・第28条"), "翻訳権の根拠を書く");
  assert.ok(out.includes("翻訳に通常必要な範囲"), "改変の範囲");
  assert.ok(out.includes("<th>翻訳物の著作権</th>"), "翻訳部分の著作権は翻訳者に");
  assert.ok(out.includes("著作権法第28条に基づく権利を留保"));
  assert.ok(out.includes("<th>終了後の翻訳物</th>"), "終了後の在庫の扱い");
  assert.ok(out.includes("終了後6か月に限り販売"), "在庫の販売期間は既定の6か月");
  assert.ok(out.includes("原著作物の題号及び原著作者名"), "第７条に翻訳物の表示");
  // 立て付けが変わっても、許諾料の計算は受領対価 × 料率のまま。
  assert.ok(out.includes("受領する対価（税抜）× 料率"), "計算は変えない");
  assert.ok(out.includes("算定の細目に別段の定めをするときは"), "細目は備考・特記事項へ");
  // 一覧の見出しと本文の指し先が揃っている。
  assert.ok(out.includes('<th class="trans">翻訳版<br>料率／別途合意</th>'));
  assert.ok(out.includes("別紙1「翻訳版」欄"));
  assert.ok(!out.includes("再許諾先"), "二次的著作物では再許諾先と呼ばない");
});

test("既定（再許諾）のままなら、これまでの書き方で出る", () => {
  const patch = pubTermsPatch(derivCtx(), { "許諾者連絡先": "甲" });
  assert.equal(patch.translationDerivative, false);
  const out = renderDocumentHtml(annexHtml, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(out.includes("乙が第三者に再許諾して行わせる翻訳版の出版"));
  assert.ok(out.includes("乙が再許諾先から受領する対価（税抜）× 料率"));
  assert.ok(out.includes('<th class="trans">翻訳版再許諾<br>料率／別途合意</th>'));
  assert.ok(!out.includes("著作権法第27条"), "翻訳権の条文は出さない");
  assert.ok(!out.includes("翻訳物の著作権"));
  assert.ok(!out.includes("終了後の翻訳物"));
});

test("二次的著作物でも、翻訳版の条件が無ければ翻訳の条文は出ない", () => {
  const patch = pubTermsPatch(context, { "翻訳の扱い": "二次的著作物", "許諾者連絡先": "甲" });
  const out = renderDocumentHtml(annexHtml, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(!out.includes("著作権法第27条"));
  assert.ok(!out.includes("<th>翻訳物の著作権</th>"));
  assert.ok(!out.includes("<th>終了後の翻訳物</th>"));
});
