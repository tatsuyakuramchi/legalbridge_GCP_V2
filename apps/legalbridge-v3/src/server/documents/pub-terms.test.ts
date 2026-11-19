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
    no: 2, termsNo: "", jointLabel: "なし", jointNames: "なし", title: "ねこの図書館", edition: "ねこの図書館 ①", copyright: "", thirdParty: "なし", note: "",
    printRate: "10%", printExclusivity: "独占", digitalRate: "—", digitalExclusivity: "—", digitalBasis: "",
    hasPrint: true, hasDigital: false, hasOwnDigital: false,
    // 翻訳版の再許諾（A-033）。この作品は翻訳版の条件を持たないので空。
    translation: "—", hasTranslation: false, translationConsent: "",
    translationConsentRequired: false,
    translationLabel: "再許諾", translationDerivative: false,
    // 許諾期間（A-039）。条件が期間を持つので、下に続く行が出る。
    term: "2026.10.1〜2032.3.31（更新なし）", hasTerm: true, hasNoteRow: true,
    coAuthors: "", payeeShare: "", hasShares: false, shareNote: "", shareMissing: false
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


test("A-111：第５条の枠の分岐：載っている媒体だけ true", () => {
  const printOnly = { ...context, conditions: context.conditions.filter((c: any) => c.usageType !== "pub_digital")
    .map((c: any) => ({ ...c, usageType: "pub_print" })) };
  const p1 = pubTermsPatch(printOnly, {});
  assert.equal(p1.hasPrintMedia, true); assert.equal(p1.hasDigitalMedia, false);
  const both = pubTermsPatch(context, {});
  assert.equal(both.hasDigitalMedia, true);
});

test("アーカム条件書の読み合わせ：増刷時の非加算は備考に、第３条の終期は更新後の最も遅い日、電子の受領額基準の印", () => {
  const ctx = { ...context, conditions: [
    { ...context.conditions[0], termStart: "2018-04-01", termEnd: "2021-03-31", autoRenew: true, renewMonths: 36, royaltyExemptLaterPct: 1 },
    { ...context.conditions[1], termStart: "2018-04-01", termEnd: "2021-03-31", autoRenew: true, renewMonths: 36, priceBasis: "receipts" },
    { ...context.conditions[2], termStart: "2016-10-01", termEnd: "2019-09-30", autoRenew: true, renewMonths: 36 }
  ] };
  const patch = pubTermsPatch(ctx, { "締結日": "2026-11-02" });
  const titles = patch.titles as Array<{ note: string; term: string }>;
  // 紙の 2 版目以降の非加算 1% → 備考「増刷時の印税対象部数は刷部数の99%（非加算 1%）」。電子の入金額基準も備考に。
  assert.match(titles[0]!.note, /増刷時の印税対象部数は刷部数の99%（非加算 1%）/);
  assert.match(titles[0]!.note, /電子の料率は乙の入金額に対する率/);
  // 終期は更新前の終了日の最大（2021-03-31）ではなく、更新を数えたいまの期間の終わりの最大
  //（3 本目：2019-09-30 → 2022 → 2025 → 2028-09-30）。
  assert.equal(patch.termEnd, "2028-09-30");
  assert.equal(pubTermsSuggestions(ctx)["許諾終了日"] >= "2028-09-30", true);
  // 電子の条件が全部「入金額」基準なら第４条は受領額 × 料率。
  assert.equal(patch.digitalReceiptBasis, true);
  assert.equal(patch.digitalBasisMixed, false);
  // 行を直していても非加算の 1 文は台帳から引き直す（人の備考は残る）。
  const edited = pubTermsPatch(ctx, { "締結日": "2026-11-02",
    pub_titles: [{ title: "星降る夜のはなし", print_condition_id: 1, digital_condition_id: 2, condition_ids: [1, 2],
                   note: "増刷時の印税対象部数は刷部数の90%（非加算 10%）／人が書いた備考" }] });
  assert.equal((edited.titles as Array<{ note: string }>)[0]!.note,
    "増刷時の印税対象部数は刷部数の99%（非加算 1%）／電子の料率は乙の入金額に対する率／人が書いた備考");
});

test("乙（当社）の通知先：案件の担当者が無ければ自社の設定から（空のまま出さない）", () => {
  const ctx = { ...context, owner: null, company: { ...context.company, department: "出版事業部", contactName: "編集 花子", email: "pub@example.test", tel: "03-2222-2222" } };
  const patch = pubTermsPatch(ctx, {});
  assert.equal(patch.licenseeContact, "出版事業部 ／ 編集 花子 ／ pub@example.test ／ 03-2222-2222");
});

test("行に控えた条件 id が無くなっていても（改訂・重複の付け替え）、同じ作品の今の条件から料率と独占区分を引き直す", () => {
  // 行は古い条件（id 99、非独占 7.1%）から作った。いまの文書の条件は id 3（ねこの図書館、独占 10%）。
  const patch = pubTermsPatch(context, {
    pub_titles: [{ title: "ねこの図書館", print_condition_id: 99, print_rate: "7.1%", print_exclusivity: "非独占", digital_rate: "—", digital_exclusivity: "—" }]
  });
  const row = (patch.titles as Array<Record<string, unknown>>)[0];
  assert.equal(row.printExclusivity, "独占");
  assert.equal(row.printRate, "10%");
});

test("作品ごとに番号を持つ条件書：頭書きの番号は「最小〜最大」でまとめ、飛んでいる番号は別に分かる", async () => {
  const { termsNoRange, termsNoGaps } = await import("./pub-terms.js");
  assert.equal(termsNoRange(["ARC-PUBT-2026-0014", "ARC-PUBT-2026-0012", "ARC-PUBT-2026-0013"]), "ARC-PUBT-2026-0012〜0014");
  assert.equal(termsNoRange(["ARC-PUBT-2026-0030", "ARC-PUBT-2026-0031"]), "ARC-PUBT-2026-0030〜0031");
  // 途中が飛んでいても 1 つの範囲にする（頭書きが 2 行にならないように）。
  assert.equal(termsNoRange(["ARC-PUBT-2026-0012", "ARC-PUBT-2026-0026"]), "ARC-PUBT-2026-0012〜0026");
  assert.equal(termsNoRange(["ARC-PUBT-2026-0029", "ARC-PUBT-2026-0012", "ARC-PUBT-2026-0014", "ARC-PUBT-2026-0013", "ARC-PUBT-2026-0017"]),
    "ARC-PUBT-2026-0012〜0029");
  // 頭が違う番号が混ざるときは並べる。
  assert.equal(termsNoRange(["ARC-PUBT-2026-0012", "ARC-PUBT-2027-0001"]), "ARC-PUBT-2026-0012・ARC-PUBT-2027-0001");
  // この紙に載っていない番号。
  assert.deepEqual(termsNoGaps(["ARC-PUBT-2026-0012", "ARC-PUBT-2026-0013", "ARC-PUBT-2026-0014", "ARC-PUBT-2026-0017"]),
    ["ARC-PUBT-2026-0015", "ARC-PUBT-2026-0016"]);
  assert.deepEqual(termsNoGaps(["ARC-PUBT-2026-0012", "ARC-PUBT-2026-0013"]), []);
  assert.deepEqual(termsNoGaps(["ARC-PUBT-2026-0012", "ARC-PUBT-2027-0001"]), []);
  assert.equal(termsNoRange(["ARC-PUBT-2026-0012"]), "ARC-PUBT-2026-0012");
  assert.equal(termsNoRange([]), "");
});

test("条件書の受取人：載せた条件すべての相手先（代表）その人なら、受取人宛てにしない", async () => {
  const { isCounterpartyOfAll } = await import("./context-repository.js");
  const conds = [{ counterpartyId: 800 }, { counterpartyId: 800 }];
  assert.equal(isCounterpartyOfAll(conds, 800), true);
  // 共著者（取り分に入っている別の人）は受取人宛てのまま。
  assert.equal(isCounterpartyOfAll(conds, 801), false);
  // 受取人が一部の条件の相手先（その人単独の作品が混ざる紙）は、受取人宛てのまま。
  assert.equal(isCounterpartyOfAll([{ counterpartyId: 800 }, { counterpartyId: 801 }], 801), false);
  assert.equal(isCounterpartyOfAll(conds, null), false);
  assert.equal(isCounterpartyOfAll([], 800), false);
});

test("作品ごとに番号を持つ条件書：「共著者等」欄は、分配を受ける人の名前だけ（許諾者その人は除く・割合は書かない）", async () => {
  const { coAuthorNames, namesOfSharesText } = await import("./pub-terms.js");
  const shares = [
    { partyId: 800, name: "合同会社 DucQrews", sharePpm: 187500 },
    { partyId: 802, name: "八木清太", sharePpm: 375000 },
    { partyId: 803, name: "國場良", sharePpm: 375000 },
    { partyId: 804, name: "合同会社ハーベストバレー", sharePpm: 62500 }
  ];
  const print = { counterpartyId: 800, shares };
  const digital = { counterpartyId: 800, shares };
  // 紙・電子で同じ人は 1 回だけ。許諾者（条件の相手先）は並べない。
  assert.deepEqual(coAuthorNames(print, digital), ["八木清太", "國場良", "合同会社ハーベストバレー"]);
  // 取り分の無い条件・条件が無いとき。
  assert.deepEqual(coAuthorNames({ counterpartyId: 800, shares: [] }, undefined), []);
  // 行に手で書いた文からは、割合を落として名前だけ。
  assert.deepEqual(namesOfSharesText("代表が分配：合同会社 DucQrews 93.75%・合同会社ハーベストバレー 6.25%", "合同会社 DucQrews"),
    ["合同会社ハーベストバレー"]);
  assert.deepEqual(namesOfSharesText(""), []);
});

test("作品ごとに番号を持つ条件書：「共著者等」欄は、契約当事者のほかの人を 1 人 1 回ずつ", async () => {
  const { jointNamesOf } = await import("./pub-terms.js");
  const duc = "合同会社 DucQrews";
  // 按分の相手先と、行の第三者権利の両方にハーベストバレー → 1 回だけ。
  assert.equal(jointNamesOf(["合同会社ハーベストバレー"], "合同会社ハーベストバレー", "著：力造", duc), "合同会社ハーベストバレー");
  // 著作権表示のペンネーム（番棚葵）は、按分の相手先（高沢良太）と同じ人なので足さない。
  assert.equal(jointNamesOf(["高沢良太", "合同会社ハーベストバレー"], "番棚葵／合同会社ハーベストバレー", "著：力造／番棚葵", duc),
    "高沢良太、合同会社ハーベストバレー");
  assert.equal(jointNamesOf(["八木清太", "國場良", "合同会社ハーベストバレー"], "佐々宮智志／綺月鏡水／合同会社ハーベストバレー",
    "著：力造／佐々宮智志／綺月鏡水", duc), "八木清太、國場良、合同会社ハーベストバレー");
  // 著作権表示に無い名前（ほんとうの第三者権利）は残す。空白の違いは同じ名前とみなす。
  assert.equal(jointNamesOf(["合同会社ハーベストバレー"], "合同会社　ハーベストバレー／株式会社別の権利者", "著：力造", duc),
    "合同会社ハーベストバレー、株式会社別の権利者");
  // 按分の無い行は、書いてある名前をそのまま（契約当事者その人は除く）。
  assert.equal(jointNamesOf([], "番棚葵／合同会社 DucQrews", "著：力造／番棚葵", duc), "番棚葵");
  assert.equal(jointNamesOf([], "なし", "著：力造", duc), "なし");
  assert.equal(jointNamesOf([], "", "", duc), "なし");
});

test("作品ごとに番号を持つ条件書：翻訳版の条件明細を載せていなくても、翻訳版の行を出す（料率は欄の値）", async () => {
  const { pubTermsPatch, MULTI_DEFAULTS } = await import("./pub-terms.js");
  const context = {
    counterparty: { id: 1, name: "合同会社テスト", kind: "corporate" }, company: { name: "株式会社アークライト" },
    conditions: [
      { id: 1, name: "作品A｜紙出版", usageType: "pub_print", ratePct: 11, counterpartyId: 1, work: { title: "作品A" }, shares: [] },
      { id: 2, name: "作品A｜電子出版", usageType: "pub_digital", ratePct: 16, counterpartyId: 1, work: { title: "作品A" }, shares: [] }
    ]
  };
  // 欄の初期値が入った状態（フォームは初期値を入れて渡す）。
  const base = { "許諾内容_翻訳": MULTI_DEFAULTS.grantTranslation, "翻訳版の料率": MULTI_DEFAULTS.translationRate,
                 "翻訳版の算定の基礎": MULTI_DEFAULTS.translationBasis };
  const p = pubTermsPatch(context, base);
  assert.equal(p.multiHasTranslation, true);
  assert.equal(p.translationRateAll, "50%");
  assert.equal(p.grantTranslation, MULTI_DEFAULTS.grantTranslation);
  // 前の版のひな形が見る値は変わらない（翻訳版の条件が無ければ出さない）。
  assert.equal(p.hasTranslation, false);
  // 料率の欄を直せば、その率。
  assert.equal(pubTermsPatch(context, { ...base, "翻訳版の料率": "40%" }).translationRateAll, "40%");
  // 翻訳版を書かない紙。
  assert.equal(pubTermsPatch(context, { ...base, "翻訳版の行": "出さない" }).multiHasTranslation, false);
});

test("作品ごとに番号を持つ条件書：再許諾（翻訳版）だけを載せた紙に、紙媒体出版・電子書籍配信の行を出さない", async () => {
  const { pubTermsPatch, pubTermsMultiWarnings, translationRateText, MULTI_DEFAULTS } = await import("./pub-terms.js");
  const sub = (id: number, usageType: string, ratePct: number, title = "海外だけの本") =>
    ({ id, name: `${title}｜再許諾`, usageType, pricingModel: "revenue_rate", ratePct, counterpartyId: 1, work: { title }, shares: [] });
  const context = {
    counterparty: { id: 1, name: "合同会社テスト", kind: "corporate" }, company: { name: "株式会社アークライト" },
    conditions: [sub(1, "pub_sub_print", 50), sub(2, "pub_sub_digital", 50)]
  };
  // フォームは欄の初期値を入れて渡す。
  const base = { "支払時期・方法": MULTI_DEFAULTS.payTiming, "翻訳版の算定の基礎": MULTI_DEFAULTS.translationBasis };
  const p = pubTermsPatch(context, base);
  // 自社の出版・配信の条件は無いので、その行は出さない。翻訳版の行は条件の料率で出す。
  assert.equal(p.hasPrintMedia, false);
  assert.equal(p.hasDigitalMedia, false);
  assert.equal(p.multiHasTranslation, true);
  assert.equal(p.translationRateAll, "50%");
  // 支払時期・方法は、初期値のままなら行のある利用形態の文だけ。
  assert.equal(p.payTiming, MULTI_DEFAULTS.payTimingParts.translation + MULTI_DEFAULTS.payTimingParts.report);
  // 欄を直していれば、書いたとおり。
  assert.equal(pubTermsPatch(context, { ...base, "支払時期・方法": "受領の翌月末日払い。" }).payTiming, "受領の翌月末日払い。");
  // 紙・電子の出版もある紙は、これまでどおり全部の文。
  const both = { ...context, conditions: [...context.conditions,
    { ...sub(3, "pub_print", 11), name: "海外だけの本｜紙出版" }, { ...sub(4, "pub_digital", 16), name: "海外だけの本｜電子出版" }] };
  const pb = pubTermsPatch(both, base);
  assert.equal(pb.hasPrintMedia, true); assert.equal(pb.hasDigitalMedia, true);
  assert.equal(pb.payTiming, MULTI_DEFAULTS.payTiming);
  // 料率が紙と電子で違えば書き分ける。同じ媒体で作品によって違えば 1 枚に書けないので空にして、注意を出す。
  assert.equal(translationRateText([sub(1, "pub_sub_print", 50), sub(2, "pub_sub_digital", 40)]), "紙 50%／電子 40%");
  const mixed = { ...context, conditions: [sub(1, "pub_sub_print", 50), sub(5, "pub_sub_print", 30, "別の本")] };
  assert.equal(pubTermsPatch(mixed, base).translationRateAll, "");
  assert.ok(pubTermsMultiWarnings(mixed).some((w) => w.message.includes("翻訳版（再許諾）の料率が作品で違います")));
  assert.ok(!pubTermsMultiWarnings(context).some((w) => w.message.includes("料率が作品で違います")));
});

test("作品ごとに番号を持つ条件書：前文の基本契約の日付は、欄に入れたらその日付（記録の締結日は変えない）", async () => {
  const { pubTermsPatch } = await import("./pub-terms.js");
  const context = {
    counterparty: { id: 1, name: "合同会社テスト", kind: "corporate" }, company: { name: "株式会社アークライト" },
    masterAgreement: { no: "ATT-2026-00069", title: "出版及び著作物利用許諾に関する基本契約書",
                       datedTitle: "2026年10月2日付出版及び著作物利用許諾に関する基本契約書" },
    conditions: [{ id: 1, name: "作品A｜紙出版", usageType: "pub_print", ratePct: 11, counterpartyId: 1, work: { title: "作品A" }, shares: [] }]
  };
  // 欄が空なら、記録の締結日。
  assert.equal(pubTermsPatch(context, {}).agreementTitle, "2026年10月2日付出版及び著作物利用許諾に関する基本契約書");
  // 欄に入れたら、その日付で書く。
  assert.equal(pubTermsPatch(context, { "基本契約の日付": "2026-09-24" }).agreementTitle,
    "2026年9月24日付出版及び著作物利用許諾に関する基本契約書");
});

test("V5：作品ごとの許諾地域・言語を備考に出し、再許諾だけの作品は料率の欄と備考で示す", async () => {
  const { pubTermsPatch, pubTermsSuggestions, SCOPE_PER_WORK } = await import("./pub-terms.js");
  const cond = (id: number, workId: number, title: string, usageType: string, ratePct: number, over: Record<string, unknown> = {}) =>
    ({ id, conditionNo: `CL-${id}`, name: `${title}｜${usageType}`, workId, work: { title }, usageType, pricingModel: "revenue_rate",
       ratePct, counterpartyId: 1, shares: [], scopes: { region: [], language: [] }, ...over });
  const overseas = { scopes: { region: ["日本を除く全世界"], language: ["英語"] }, exclusivity: "exclusive", sublicenseConsent: "covered" };
  const context = {
    counterparty: { id: 1, name: "合同会社テスト", kind: "corporate" }, company: { name: "株式会社アークライト" },
    conditions: [
      // 国内の出版（地域・言語の指定なし）
      cond(1, 10, "国内の本", "pub_print", 10, { exclusivity: "exclusive" }), cond(2, 10, "国内の本", "pub_digital", 15, { exclusivity: "exclusive" }),
      // 海外だけの翻訳の再許諾
      cond(3, 20, "海外だけの本", "pub_sub_print", 50, overseas), cond(4, 20, "海外だけの本", "pub_sub_digital", 50, overseas),
      // 国内の出版と、海外の再許諾の両方がある作品（紙と電子で率が違う。別途合意が要る）
      cond(5, 30, "両方の本", "pub_print", 10, { exclusivity: "non_exclusive" }),
      cond(6, 30, "両方の本", "pub_sub_print", 50, { ...overseas, sublicenseConsent: "required" }),
      cond(7, 30, "両方の本", "pub_sub_digital", 40, { ...overseas, sublicenseConsent: "required" })
    ]
  };
  const v5 = pubTermsPatch(context, {}, { v5: true });
  const row = (title: string) => (v5.titles as any[]).find((t) => t.title === title);

  // 指定の無い作品は既定（全世界・日本語）。
  assert.equal(row("国内の本").note, "許諾地域：全世界／許諾言語：日本語");
  assert.equal(row("国内の本").printRate, "10%");

  // 再許諾だけの作品：料率の欄に「再許諾 50%」と独占区分、備考に地域・言語と算定のしかた。
  const only = row("海外だけの本");
  assert.equal(only.printRate, "再許諾 50%"); assert.equal(only.digitalRate, "再許諾 50%");
  assert.equal(only.hasPrint, true); assert.equal(only.printExclusivity, "独占");
  assert.equal(only.hasOwnDigital, false);
  assert.equal(only.note, "許諾地域：日本を除く全世界／許諾言語：英語"
    + "／再許諾のみ（料率は乙が再許諾先から受領する対価（税抜）に対する率。対価を受領した日の翌々月末日までに支払う）");
  assert.equal(only.hasNoteRow, true);

  // 自社で出す分もある作品：紙の欄は自社の料率。電子は再許諾だけなので欄に出す。再許諾の料率は備考にも書く。
  const both = row("両方の本");
  assert.equal(both.printRate, "10%"); assert.equal(both.printExclusivity, "非独占");
  assert.equal(both.digitalRate, "再許諾 40%");
  assert.equal(both.note, "許諾地域：全世界（再許諾：日本を除く全世界）／許諾言語：日本語（再許諾：英語）"
    + "／再許諾：紙 50%・電子 40%（乙が再許諾先から受領する対価（税抜）に対する率。対価を受領した日の翌々月末日までに支払う）"
    + "／再許諾先ごとに甲乙の別途合意を要する");

  // 第３条：作品によって違うので、並べて書かず一覧の備考を指す（欄の文案）。欄に書けばそれが勝つ。
  const suggested = pubTermsSuggestions(context, {}, { v5: true });
  assert.equal(suggested["許諾地域"], SCOPE_PER_WORK); assert.equal(suggested["許諾言語"], SCOPE_PER_WORK);
  assert.equal(pubTermsPatch(context, suggested, { v5: true }).region, SCOPE_PER_WORK);
  // 自社の媒体だけを数える（再許諾だけの紙に、紙・電子の支払の行を出さない）。
  assert.equal(v5.hasPrintMedia, true); assert.equal(v5.hasAnyDigital, true);

  // V5 でないひな形は、これまでどおり（備考に足さない・料率の欄は「—」・文案は並べ書き）。
  const v3 = pubTermsPatch(context, {});
  const only3 = (v3.titles as any[]).find((t) => t.title === "海外だけの本");
  assert.equal(only3.printRate, "—"); assert.equal(only3.note, "");
  assert.equal(pubTermsSuggestions(context)["許諾地域"], "日本を除く全世界");

  // どの条件にも地域・言語が無い紙は、V5 でも備考に足さない（第３条の「全世界・日本語」だけ）。
  const plain = { ...context, conditions: context.conditions.slice(0, 2) };
  assert.equal((pubTermsPatch(plain, {}, { v5: true }).titles as any[])[0].note, "");
  assert.equal(pubTermsSuggestions(plain, {}, { v5: true })["許諾地域"], undefined);
});
