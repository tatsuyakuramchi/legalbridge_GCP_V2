import test from "node:test";
import assert from "node:assert/strict";
import {
  PUB_TERMS_VARIABLES, PUB_TITLES_FIELD, isPubTermsTemplate, mediaOfCondition, percentText,
  pubTermsPatch, pubTermsSuggestions, pubTermsWarnings, pubTitleSeeds, rowBlockerOf
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
  assert.match(rowBlockerOf(broken.conditions[4])!, /媒体/);
  assert.equal(rowBlockerOf(broken.conditions[0]), null);
  const messages = pubTermsWarnings(broken).map((w) => w.message);
  assert.equal(messages.length, 4, messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("CL-2026-00460") && m.includes("料率")));
  assert.ok(messages.some((m) => m.includes("CL-2026-00461") && m.includes("媒体")));
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

test("本文の文脈：甲＝取引先、乙＝当社、通知先・源泉・翻訳版・一覧", () => {
  const patch = pubTermsPatch(context, {
    "締結日": "2026-10-01", "許諾開始日": "2026-10-01", "許諾終了日": "2031-09-30",
    "翻訳版取り分": "50", "自動更新": "する", "許諾地域": "全世界"
  });
  assert.equal(patch.docNo, "ARC-PUBT-2026-0041");
  assert.equal(patch.licensorName, "甲野 甲太");
  assert.equal(patch.licensorIsCorp, false);
  assert.equal(patch.withholding, true);
  assert.equal(patch.licensorContact, "甲野 甲太 ／ kono@example.test ／ 03-0000-0000");
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
    hasPrint: true, hasDigital: false
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
  for (const name of ["紙の支払時期", "電子の集計期間", "電子の支払時期", "翻訳版の支払時期", "更新期間", "終了通知期限"]) {
    assert.ok(PUB_TERMS_VARIABLES.find((v) => v.name === name)?.default, name);
  }
  assert.equal(new Set(PUB_TERMS_VARIABLES.map((v) => v.name)).size, PUB_TERMS_VARIABLES.length, "名前の重複なし");
});
