import test from "node:test";
import assert from "node:assert/strict";
import {
  PUB_TERMS_VARIABLES, PUB_TITLES_FIELD, isPubTermsTemplate, mediaOfCondition, mediaSharesText, payeeRateText, payeeShareText, percentText, sharesMismatch,
  pubTermsPatch, pubTermsSuggestions, pubTermsWarnings, pubTitleSeeds, renewUnitOf, rowBlockerOf, sharesText
} from "./pub-terms.js";
import { pubMediaOf, pubMediaOfScopes } from "../core/pub-media.js";

/**
 * 出版の条件は 作品1点＝条件2本（媒体＝紙／電子）。同じ作品の2本が
 * 1行に畳まれ、電子の無い作品は「—」で出る。
 */
const cond = (over: Record<string, any>) => ({
  direction: "in", kind: "license", pricingModel: "revenue_rate", currency: "JPY",
  exclusivity: "non_exclusive", exclusivityLabel: "非独占", notes: null, counterpartyId: 5,
  termStart: "2026-10-01", termEnd: "2031-09-30",
  scopes: { region: [] as string[], language: [] as string[], media: [] as string[] }, ...over
});

const context = {
  document: { number: "ARC-PUBT-2026-0041", issuedOn: "2026-10-01" },
  company: { name: "株式会社サンプル出版", address: "東京都文京区本郷", rep: "代表取締役 乙山 乙子",
             invoiceNo: "T9876543210987" },
  agreement: { no: "ARC-PUBM-2025-0003", title: "出版等利用許諾基本契約書", autoRenewal: true,
               renewalNoticeMonths: 3 },
  contacts: [{ role: "primary", name: "甲野 甲太", email: "kono@example.test", phone: "03-0000-0000",
               department: null }],
  owner: { name: "編集 花子", email: "hanako@example.test", phone: "03-1111-1111", department: "編集部" },
  bank: { bankName: "〇〇銀行", branchName: "本店", accountType: "ordinary", accountNumber: "0000000",
          holderKana: "コウノ コウタ" },
  conditions: [
    cond({ id: 1, conditionNo: "CL-2026-00451", name: "星降る夜のはなし（単行本）", workId: 10,
      work: { title: "星降る夜のはなし" }, ratePct: 11, notes: "初版100部（見本・献本除く）",
      scopes: { region: ["全世界"], language: ["日本語"], media: ["紙"] } }),
    cond({ id: 2, conditionNo: "CL-2026-00452", name: "星降る夜のはなし（単行本）", workId: 10,
      work: { title: "星降る夜のはなし" }, ratePct: 15, notes: "初版100部（見本・献本除く）",
      scopes: { region: ["全世界"], language: ["日本語"], media: ["電子書籍"] } }),
    cond({ id: 3, conditionNo: "CL-2026-00453", name: "ねこの図書館 ①", workId: 11,
      work: { title: "ねこの図書館" }, ratePct: 10, exclusivity: "exclusive", exclusivityLabel: "独占",
      termEnd: "2032-03-31", scopes: { region: ["日本"], language: [], media: ["print"] } })
  ],
  condition: null as any
};
context.condition = {
  ...context.conditions[0],
  counterparty: { name: "甲野 甲太", kind: "individual", address: "東京都千代田区", invoiceNo: null,
                  withholding: true, phone: "03-9999-9999" }
};

test("ひな形の見分けと媒体の判定", () => {
  assert.equal(isPubTermsTemplate("pub_license_terms_v3"), true);
  assert.equal(isPubTermsTemplate("pub_license_terms"), false);
  assert.equal(pubMediaOf("紙媒体"), "print");
  assert.equal(pubMediaOf("ebook"), "digital");
  assert.equal(pubMediaOf("映像"), null);
  assert.equal(pubMediaOfScopes(["紙", "電子"]), null, "両方入っていれば決められない");
  assert.equal(pubMediaOfScopes([{ code: "digital", label: "なにか" }]), "digital");
  assert.equal(mediaOfCondition(context.conditions[1]), "digital");
  assert.equal(percentText(8.5), "8.5%");
  assert.equal(percentText(null), "—");
});

test("作品1点＝1行。紙と電子が畳まれ、電子の無い作品は「—」", () => {
  const rows = pubTitleSeeds(context);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.title, r.edition, r.print_rate, r.print_exclusivity, r.digital_rate, r.digital_exclusivity]),
    [["星降る夜のはなし", "星降る夜のはなし（単行本）", "11%", "非独占", "15%", "非独占"],
     ["ねこの図書館", "ねこの図書館 ①", "10%", "独占", "—", "—"]]);
  assert.equal(rows[0].note, "初版100部（見本・献本除く）", "同じ備考は1回だけ");
  assert.deepEqual(rows[0].condition_ids, [1, 2]);
  assert.equal(rows[1].digital_condition_id, null);
});

test("載せられない条件は名指しで警告し、行からは落とす", () => {
  const broken = {
    ...context,
    conditions: [
      ...context.conditions,
      cond({ id: 4, conditionNo: "CL-2026-00460", name: "定額の条件", workId: 12, pricingModel: "fixed",
             ratePct: null, flatAmount: 1000, scopes: { region: [], language: [], media: ["紙"] } }),
      cond({ id: 5, conditionNo: "CL-2026-00461", name: "媒体なし", workId: 13, ratePct: 9 }),
      cond({ id: 6, conditionNo: "CL-2026-00462", name: "ねこの図書館 ①", workId: 11, ratePct: 12,
             work: { title: "ねこの図書館" }, scopes: { region: [], language: [], media: ["紙"] } }),
      cond({ id: 7, conditionNo: "CL-2026-00463", name: "他社", workId: 14, ratePct: 9, counterpartyId: 6,
             scopes: { region: [], language: [], media: ["紙"] } })
    ]
  };
  assert.match(rowBlockerOf(broken.conditions[3])!, /料率ではありません/);
  assert.match(rowBlockerOf(broken.conditions[4])!, /利用形態/);
  assert.equal(rowBlockerOf(broken.conditions[0]), null);
  const messages = pubTermsWarnings(broken).map((w) => w.message);
  assert.equal(messages.length, 4, messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("CL-2026-00460") && m.includes("料率")));
  assert.ok(messages.some((m) => m.includes("CL-2026-00461") && m.includes("利用形態")));
  assert.ok(messages.some((m) => m.includes("ねこの図書館") && m.includes("紙の条件が2本")));
  assert.ok(messages.some((m) => m.includes("相手先の違う")));
  // 壊れていない条件だけが行になる（作品14は媒体はあるので行になる）。
  assert.equal(pubTitleSeeds(broken).length, 3);
  assert.deepEqual(pubTermsWarnings(context), []);
});

test("期間・地域・言語・更新の文案は条件と合意から", () => {
  const out = pubTermsSuggestions(context);
  assert.equal(out["許諾開始日"], "2026-10-01");
  assert.equal(out["許諾終了日"], "2032-03-31", "いちばん遅い終了日");
  assert.equal(out["許諾地域"], "全世界、日本");
  assert.equal(out["許諾言語"], "日本語");
  assert.equal(out["自動更新"], "する");
  assert.equal(out["終了通知期限"], "3か月");
});

test("3 年・3 年ごとに更新を入れた条件なら、第３条の更新の単位も 3 年。作品の行に更新の回数", () => {
  const renewing = { ...context, conditions: context.conditions.map((c) => ({
    ...c, termStart: "2018-04-01", termEnd: "2021-03-31", autoRenew: true, renewMonths: 36 })) };
  assert.equal(renewUnitOf(renewing.conditions), "3年");
  assert.equal(pubTermsSuggestions(renewing)["更新期間"], "3年");
  const patch = pubTermsPatch(renewing, { "締結日": "2026-10-19" });
  assert.equal(patch.renewPeriod, "3年");
  assert.equal(patch.autoRenew, true);
  assert.equal((patch.titles as Array<{ term: string }>)[0]!.term, "2018.4.1〜2027.3.31（更新 2回）");
  // 単位が揃わない・自動更新しないなら決めない（欄の値か既定の 1 年）。
  assert.equal(renewUnitOf([{ autoRenew: true, termEnd: "2021-03-31", renewMonths: 36 },
                            { autoRenew: true, termEnd: "2021-03-31", renewMonths: 12 }]), "");
  assert.equal(renewUnitOf(context.conditions), "");
});

test("本文の文脈：甲＝取引先、乙＝当社、通知先・源泉・翻訳版・一覧", () => {
  const patch = pubTermsPatch(context, {
    "締結日": "2026-10-01", "許諾開始日": "2026-10-01", "許諾終了日": "2031-09-30",
    "翻訳版取り分": "50", "自動更新": "する", "許諾地域": "全世界"
  });
  assert.equal(patch.docNo, "ARC-PUBT-2026-0041");
  assert.equal(patch.licensorName, "甲野 甲太");
  assert.equal(patch.licensorIsCorp, false);
  assert.equal(patch.withholding, true);
  // A-032 で取引先が主担当を持つようになったので、甲の通知先は主担当から自動で入る。
  assert.equal(patch.licensorContact, "甲野 甲太 ／ kono@example.test ／ 03-0000-0000", "甲の通知先は主担当");
  assert.equal(pubTermsPatch(context, { "許諾者連絡先": "甲野 甲太 ／ kono@example.test" }).licensorContact,
    "甲野 甲太 ／ kono@example.test");
  assert.equal(patch.licenseeName, "株式会社サンプル出版");
  assert.equal(patch.licenseeContact, "編集部 ／ 編集 花子 ／ hanako@example.test ／ 03-1111-1111");
  assert.equal(patch.hasTranslation, true);
  assert.equal(patch.translationShare, "50%");
  assert.equal(patch.autoRenew, true);
  assert.equal(patch.payPrint, "翌月末日");
  assert.equal(patch.hasBank, true);
  assert.equal(patch.titleCount, 2);
  assert.equal(patch.hasAnyDigital, true);
  assert.deepEqual(patch.titles[1], {
    no: 2, title: "ねこの図書館", edition: "ねこの図書館 ①", copyright: "", thirdParty: "なし", note: "",
    printRate: "10%", printExclusivity: "独占", digitalRate: "—", digitalExclusivity: "—",
    hasPrint: true, hasDigital: false,
    // 翻訳版の再許諾（A-033）。この作品は翻訳版の条件を持たないので空。
    translation: "—", hasTranslation: false, translationConsent: "",
    translationConsentRequired: false,
    translationLabel: "翻訳版再許諾", translationDerivative: false,
    // 許諾期間（A-039）。条件が期間を持つので、下に続く行が出る。
    term: "2026.10.1〜2032.3.31（更新なし）", hasTerm: true, hasNoteRow: true,
    coAuthors: "", payeeShare: "", hasShares: false
  });
});

test("行を直しても料率と独占区分は条件から引き直す。手で足した行は手の値", () => {
  const rows = pubTitleSeeds(context);
  rows[0] = { ...rows[0], copyright: "© 2026 甲野 甲太", print_rate: "99%", note: "直した備考" };
  rows.push({ item_name: "手で足した作品", print_rate: "7", print_exclusivity: "非独占" });
  const patch = pubTermsPatch(context, { [PUB_TITLES_FIELD]: rows });
  assert.equal(patch.titles[0].copyright, "© 2026 甲野 甲太");
  assert.equal(patch.titles[0].note, "直した備考");
  assert.equal(patch.titles[0].printRate, "11%", "台帳が勝つ");
  assert.equal(patch.titles[2].title, "手で足した作品");
  assert.equal(patch.titles[2].printRate, "7");
  assert.equal(patch.titles[2].digitalRate, "—");
  assert.equal(patch.titles[2].hasDigital, false);
});

test("翻訳版の欄が空なら翻訳版の行を出さない。署名欄は既定で出す", () => {
  const patch = pubTermsPatch(context, {});
  assert.equal(patch.hasTranslation, false);
  assert.equal(patch.showSignature, true);
  assert.equal(pubTermsPatch(context, { "署名欄": "表示しない" }).showSignature, false);
});

test("項目の宣言：一覧は array で手入力に回らない。既定値のある欄が揃っている", () => {
  const titles = PUB_TERMS_VARIABLES.find((v) => v.name === PUB_TITLES_FIELD);
  assert.equal(titles?.type, "array");
  for (const name of ["紙の支払時期", "電子の集計期間", "電子の支払時期", "翻訳版の支払時期"]) {
    assert.ok(PUB_TERMS_VARIABLES.find((v) => v.name === name)?.default, name);
  }
  // 更新の単位・通知期限は欄に既定を持たない（条件・契約の文案が既定に負けないように）。本文が 1年・1か月で補う。
  for (const name of ["更新期間", "終了通知期限"]) {
    assert.equal(PUB_TERMS_VARIABLES.find((v) => v.name === name)?.default, undefined, name);
  }
  const bare = pubTermsPatch({ ...context, agreement: {} }, {});
  assert.equal(bare.renewPeriod, "1年");
  assert.equal(bare.noticeBefore, "1か月");
  assert.equal(pubTermsPatch(context, {}).noticeBefore, "3か月", "契約の通知月数");
  assert.equal(new Set(PUB_TERMS_VARIABLES.map((v) => v.name)).size, PUB_TERMS_VARIABLES.length, "名前の重複なし");
});

test("利用形態（A-027）が入っていれば媒体の範囲より先に見る。作品の著作権表示が行の種になる", () => {
  const rows = pubTitleSeeds({
    conditions: [
      cond({ id: 11, conditionNo: "CL-1", name: "本A", workId: 21, usageType: "pub_print", ratePct: 10,
        work: { title: "本A", copyrightNotice: "© 2026 甲野 甲太", thirdPartyRights: "挿絵：乙川 乙子" } }),
      cond({ id: 12, conditionNo: "CL-2", name: "本A", workId: 21, usageType: "pub_digital", ratePct: 12,
        work: { title: "本A", copyrightNotice: "© 2026 甲野 甲太" }, scopes: { region: [], language: [], media: ["紙"] } })
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].print_rate, "10%");
  assert.equal(rows[0].digital_rate, "12%", "範囲に紙とあっても列の pub_digital が勝つ");
  assert.equal(rows[0].copyright, "© 2026 甲野 甲太");
  assert.equal(rows[0].third_party, "挿絵：乙川 乙子");
});

test("ひな形は2本立て。作品の点数に合わないほうを選んでいたら知らせる", async () => {
  const { isPubTermsAnnex, pubTermsWarnings, PUB_TERMS_ANNEX_KEY } = await import("./pub-terms.js");
  assert.equal(isPubTermsTemplate(PUB_TERMS_ANNEX_KEY), true, "別紙形式も出版の条件書として扱う");
  assert.equal(isPubTermsAnnex(PUB_TERMS_ANNEX_KEY), true);
  assert.equal(isPubTermsAnnex("pub_license_terms_v3"), false);

  // 作品が多いのに一覧形式 → 別紙形式を勧める
  const many = { conditions: Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, conditionNo: `CL-${i}`, name: `作品${i}｜紙出版`, workId: i + 1, work: { title: `作品${i}` },
    pricingModel: "revenue_rate", ratePct: 10, usageType: "pub_print", counterpartyId: 5, scopes: { media: ["紙"] }
  })) };
  const w1 = pubTermsWarnings(many, "pub_license_terms_v3");
  assert.match(w1.map((x) => x.message).join("｜"), /別紙形式/);
  assert.equal(pubTermsWarnings(many, PUB_TERMS_ANNEX_KEY).some((x) => /別紙形式|一覧形式/.test(x.message)), false);

  // 作品が数点なのに別紙形式 → 一覧形式を勧める
  const few = { conditions: many.conditions.slice(0, 2) };
  assert.match(pubTermsWarnings(few, PUB_TERMS_ANNEX_KEY).map((x) => x.message).join("｜"), /一覧形式/);
});

test("翻訳版再許諾（A-033）：紙・電子の率を1つの欄にまとめ、別途合意の要否を添える", async () => {
  const { pubTitleSeeds, pubTermsPatch, pubTermsWarnings } = await import("./pub-terms.js");
  const base = {
    pricingModel: "revenue_rate", counterpartyId: 5, workId: 10,
    work: { title: "星降る夜のはなし", copyrightNotice: "© 2026 著者名" }
  };
  const context = { conditions: [
    { ...base, id: 1, conditionNo: "CL-1", name: "星降る夜のはなし｜紙出版", usageType: "pub_print", ratePct: 10, exclusivity: "non_exclusive" },
    { ...base, id: 2, conditionNo: "CL-2", name: "星降る夜のはなし｜電子出版", usageType: "pub_digital", ratePct: 15, exclusivity: "non_exclusive" },
    { ...base, id: 3, conditionNo: "CL-3", name: "星降る夜のはなし｜翻訳版再許諾（紙）", usageType: "pub_sub_print", ratePct: 50, sublicenseConsent: "required" },
    { ...base, id: 4, conditionNo: "CL-4", name: "星降る夜のはなし｜翻訳版再許諾（電子）", usageType: "pub_sub_digital", ratePct: 40, sublicenseConsent: "covered" }
  ] };

  // 種：自社出版と翻訳版は別の欄に畳む（1作品1行のまま）。
  const seeds = pubTitleSeeds(context);
  assert.equal(seeds.length, 1, "4本でも1行");
  assert.equal(seeds[0].trans_print_rate, "50%");
  assert.equal(seeds[0].trans_digital_rate, "40%");
  assert.equal(seeds[0].trans_consent, "要", "紙と電子で違えば厳しいほう（要）に寄せる");

  const patch = pubTermsPatch(context, { pub_titles: seeds });
  const row = patch.titles[0];
  assert.equal(row.printRate, "10%");
  assert.equal(row.translation, "紙 50%／電子 40%");
  assert.equal(row.translationConsent, "要");
  assert.equal(row.hasTranslation, true);
  assert.equal(patch.hasTranslationConditions, true);
  assert.equal(patch.translationConsentRequired, true);
  assert.equal(patch.hasTranslation, true, "手入力の取り分が無くても翻訳版の条を出す");

  // 紙出版と翻訳版（紙）が1本ずつあるのは重複ではない。
  assert.deepEqual(pubTermsWarnings(context).filter((w) => /2本あります/.test(w.message)), []);
  // 同じ枠に2本あれば、これまでどおり重複として出す。
  const dup = { conditions: [...context.conditions, { ...base, id: 5, conditionNo: "CL-5", name: "もう1本", usageType: "pub_sub_print", ratePct: 30 }] };
  assert.match(pubTermsWarnings(dup).map((w) => w.message).join("｜"), /翻訳版の紙の条件が2本/);
});

// ---- 共同著作の取り分（A-068） ----------------------------------------

const SHARES = [{ partyId: 21, name: "作家B", partyCode: "V-21", sharePpm: 666667 },
                { partyId: 22, name: "作家C", partyCode: "V-22", sharePpm: 333333 }];
const sharedContext = () => ({
  ...context,
  conditions: context.conditions.map((c: Record<string, any>) => (c.workId === 10 ? { ...c, shares: SHARES, distribution: "direct" } : c))
});

test("取り分のある作品：一覧の行に「共同著作 作家B 66.6667%・作家C 33.3333%」。料率の欄は全体のまま", () => {
  assert.equal(sharesText({ shares: SHARES, distribution: "direct" }), "作家B 66.6667%・作家C 33.3333%");
  assert.equal(sharesText({ shares: SHARES, distribution: "representative" }), "代表が分配：作家B 66.6667%・作家C 33.3333%");
  assert.equal(sharesText({ shares: [] }), "");
  const ctx = sharedContext();
  const rows = pubTitleSeeds(ctx);
  assert.equal(rows[0].co_authors, "作家B 66.6667%・作家C 33.3333%");
  assert.equal(rows[1].co_authors, "", "取り分の無い作品は空");
  const patch = pubTermsPatch(ctx, { [PUB_TITLES_FIELD]: rows });
  const titles = patch.titles as Array<Record<string, any>>;
  assert.equal(titles[0].coAuthors, "作家B 66.6667%・作家C 33.3333%");
  assert.equal(titles[0].payeeShare, "", "相手先（代表）宛てなら取り分の併記は無い");
  assert.equal(titles[0].hasShares, true);
  assert.equal(titles[0].hasNoteRow, true);
  assert.deepEqual([titles[0].printRate, titles[0].digitalRate], ["11%", "15%"], "全体の料率");
  assert.equal(titles[1].hasShares, false);
  assert.equal(patch.payeeTerms, false);
});

test("受取人（共著者の一人）宛て：甲がその人になり、料率の欄は甲の率を主に括弧で全体率。本文に取り分の一文が入る", () => {
  const ctx = { ...sharedContext(), payee: { partyId: 21, name: "作家B" } };
  ctx.condition = { ...ctx.condition, counterparty: { ...ctx.condition.counterparty, name: "作家B" } };
  const patch = pubTermsPatch(ctx, { [PUB_TITLES_FIELD]: pubTitleSeeds(ctx) });
  const titles = patch.titles as Array<Record<string, any>>;
  assert.equal(titles[0].payeeShare, "甲の取り分 66.6667%");
  assert.deepEqual([titles[0].printRate, titles[0].digitalRate], ["7.3333%（全体 11%）", "10%（全体 15%）"],
    "甲に帰属する率が主。全体率は括弧（合計許諾料と読み違えない）");
  assert.equal(titles[1].payeeShare, "", "取り分に入っていない作品には出ない");
  assert.deepEqual([titles[1].printRate, titles[1].digitalRate], ["10%", "—"], "取り分に入っていない作品は全体の率そのもの");
  assert.equal(patch.payeeTerms, true);
  assert.equal(patch.payeeName, "作家B");
  assert.equal(patch.licensorName, "作家B");
  // 紙だけの作品でも落ちない。受取人でなければ全体の率。
  assert.equal(payeeShareText({ partyId: 21 }, { ratePct: 10, shares: SHARES }, undefined), "甲の取り分 66.6667%");
  assert.equal(payeeShareText({ partyId: 99 }, { ratePct: 10, shares: SHARES }, undefined), "");
  assert.equal(payeeRateText({ partyId: 21 }, { ratePct: 10, shares: SHARES }), "6.6667%（全体 10%）");
  assert.equal(payeeRateText(null, { ratePct: 10, shares: SHARES }), "10%");
  assert.equal(payeeRateText({ partyId: 21 }, undefined), "—");
});

test("紙と電子で按分が違う作品：共同著作の行に両方、受取人の取り分も媒体ごと", () => {
  const print = { ratePct: 10, shares: [{ partyId: 21, name: "作家B", sharePpm: 600000 }, { partyId: 22, name: "作家C", sharePpm: 400000 }], distribution: "direct" };
  const digital = { ratePct: 15, shares: SHARES, distribution: "direct" };
  assert.equal(mediaSharesText(print, digital), "紙：作家B 60%・作家C 40%／電子：作家B 66.6667%・作家C 33.3333%");
  assert.equal(mediaSharesText(digital, digital), "作家B 66.6667%・作家C 33.3333%", "同じなら 1 つ");
  assert.equal(payeeShareText({ partyId: 21 }, print, digital), "甲の取り分 紙 60%・電子 66.6667%");
  assert.equal(payeeRateText({ partyId: 21 }, print), "6%（全体 10%）");
  assert.equal(payeeRateText({ partyId: 21 }, digital), "10%（全体 15%）");
});

// ---- 支払の表は条件明細の支払条件から ------------------------------------

test("条件明細の支払条件から 電子の集計期間・支払時期、紙・翻訳版の支払時期を読む", async () => {
  const { readPubPaymentTerms } = await import("./pub-terms.js");
  assert.deepEqual(readPubPaymentTerms("毎年7月1日〜翌年6月30日を集計期間とし、10月末日までに支払う。", "digital"),
    { period: "7月1日〜翌年6月30日", pay: "10月末日" });
  assert.deepEqual(readPubPaymentTerms("毎年1月1日～12月31日を集計期間とし、翌年3月末日までに支払う", "digital"),
    { period: "1月1日〜12月31日", pay: "翌年3月末日" });
  assert.deepEqual(readPubPaymentTerms("都度払い（刊行日を含む月の翌月末日払い）", "print"), { pay: "翌月末日" });
  assert.deepEqual(readPubPaymentTerms("刷部数確定の都度、翌々月20日までに支払う。", "print"), { pay: "翌々月20日" });
  assert.deepEqual(readPubPaymentTerms("乙が再許諾先から対価を受領した日の翌々月末日までに支払う", "translation"), { pay: "翌々月末日" });
  assert.deepEqual(readPubPaymentTerms("毎年1月1日〜6月30日及び7月1日〜12月31日を集計期間とし、各集計期間の末日の翌々月末日までに支払う。", "digital"),
    { period: "1月1日〜6月30日及び7月1日〜12月31日", pay: "各集計期間の末日の翌々月末日" });
  assert.equal(readPubPaymentTerms("年2回", "digital"), null);
});

test("紙面の支払の表は条件明細の支払条件に連動し、欄の手入力より勝つ", () => {
  const conds = [
    { ...context.conditions[0], usageType: "pub_print", paymentTerms: "都度払い（刊行日を含む月の翌月末日払い）" },
    { ...context.conditions[1], usageType: "pub_digital", paymentTerms: "毎年1月1日〜12月31日を集計期間とし、翌年3月末日までに支払う。" }
  ];
  const ctx = { ...context, conditions: conds };
  const patch = pubTermsPatch(ctx, { "電子の集計期間": "7月1日〜翌年6月30日", "電子の支払時期": "10月末日" });
  assert.equal(patch.digitalPeriod, "1月1日〜12月31日");
  assert.equal(patch.payDigital, "翌年3月末日");
  assert.equal(patch.payPrint, "翌月末日");
  assert.equal(patch["電子の集計期間"], "1月1日〜12月31日", "欄も条件明細の値（計算）になる");
  assert.deepEqual(pubTermsWarnings(ctx).filter((w) => /支払/.test(w.message)), []);
});

test("支払条件が読めない・食い違うときは警告し、読めなければ欄（空なら既定）で出る", () => {
  const conds = [
    { ...context.conditions[1], usageType: "pub_digital", paymentTerms: "年2回払い" },
    { ...context.conditions[0], id: 5, conditionNo: "CL-X1", usageType: "pub_print", paymentTerms: "都度、翌月末日までに支払う" },
    { ...context.conditions[2], id: 6, conditionNo: "CL-X2", usageType: "pub_print", paymentTerms: "都度、翌々月末日までに支払う" }
  ];
  const ctx = { ...context, conditions: conds };
  const patch = pubTermsPatch(ctx, { "電子の支払時期": "11月末日" });
  assert.equal(patch.payDigital, "11月末日", "読めなければ欄の手入力");
  assert.equal(patch.digitalPeriod, "7月1日〜翌年6月30日", "欄も空なら既定");
  const messages = pubTermsWarnings(ctx).map((w) => w.message).join("\n");
  assert.match(messages, /支払の表の語を読めません：CL-2026-00452（年2回払い）/);
  assert.match(messages, /紙の支払時期が条件明細ごとに違います/);
});

test("紙と電子で取り分が片方にしか無い作品は名指しで知らせる（受取人宛ての料率が揃わない原因）", () => {
  const ctx = sharedContext();
  const conds = ctx.conditions.map((c: Record<string, any>) =>
    c.workId === 10 && mediaOfCondition(c) === "print" ? { ...c, shares: [] } : c);
  const w = sharesMismatch(conds);
  assert.equal(w.length, 1);
  assert.match(w[0]!, /電子.*取り分があるのに紙.*ありません/);
  assert.equal(sharesMismatch(sharedContext().conditions).length, 0, "両方に同じ取り分なら何も言わない");
  assert.ok(pubTermsWarnings({ ...ctx, conditions: conds }).some((x) => /取り分があるのに/.test(x.message)));
});


test("A-107：電子の条件が無ければ、電子の集計期間と支払時期は「—」。欄に書いてあればそれ", () => {
  const conds = context.conditions.filter((c: any) => c.usageType !== "pub_digital")
    .map((c: any) => ({ ...c, usageType: "pub_print", paymentTerms: "都度、翌月末日までに支払う" }));
  const ctx = { ...context, conditions: conds };
  const patch = pubTermsPatch(ctx, {});
  assert.equal(patch.digitalPeriod, "—");
  assert.equal(patch.payDigital, "—");
  assert.equal(patch.payPrint, "翌月末日");
  const typed = pubTermsPatch(ctx, { "電子の支払時期": "10月末日" });
  assert.equal(typed.payDigital, "10月末日", "欄に書いてあればそれ");
});


test("A-109：一覧の行を直していても、備考の「初版分は支払済み（算定：…）」は条件の今の値で引き直す。人が書いた備考は残る", () => {
  const conds = [
    { ...context.conditions[0], id: 5, conditionNo: "CL-X1", usageType: "pub_print", licenseFeeBasis: "in_lieu",
      firstEditionPrice: 4500, firstEditionCopies: 2500, firstEditionRatePct: 8, royaltyExemptFirstCopies: 100 }
  ];
  const ctx = { ...context, conditions: conds };
  const seeds = pubTitleSeeds(ctx) as Array<Record<string, unknown>>;
  assert.equal(seeds.length, 1);
  // 人が行を直した（古い自動文＋手書きの備考）。
  const edited = [{ ...seeds[0]!, note: "初版の出版に係る利用許諾料は、発注書の制作報酬（初版利用許諾料）として支払済み（算定：本体価格 4,000円（税抜）× （初版 3,000部 − 献本等 1,000部） × 7.1%）。本条件書の料率は第2版以降の出版および電子版に適用する。／手書きの備考" }];
  const patch = pubTermsPatch(ctx, { [PUB_TITLES_FIELD]: edited });
  const row = (patch.titles as Array<Record<string, unknown>>)[0]!;
  assert.match(String(row.note), /^初版の出版に係る利用許諾料は、発注書の制作報酬（初版利用許諾料）として支払済み（算定：本体価格 4,500円（税抜）× （初版 2,500部 − 献本等 100部） × 8%）/);
  assert.match(String(row.note), /／手書きの備考$/);
});
