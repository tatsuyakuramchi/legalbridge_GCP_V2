import test from "node:test";
import assert from "node:assert/strict";
import { companyMatches, matchLanguage, parseReportPaste, pickOut, readYen } from "./report-paste.js";

const SAMPLE = `202610_平沢茂之_海外版デザイナーロイヤリティ支払

タイトル：トーネードスプラッシュ
デザイナー：平沢茂之
希望納期：10月1日
デザイナーロイヤリティ：10％
デザイナーに振込期日：2026年10月20日
1
版・言語：英語版
入金企業：Asmodee
前金：¥3,739,365
後金：¥3,564,512
2
版・言語：中国語簡体字版
入金企業：Asmodee
前金：¥127,406
後金：¥101,843
3
版・言語：中国語繫体字版
入金企業：Asmodee
前金：¥70,901
後金：¥50,922
8
版・言語：フランス語版
入金企業：Don’t Panic
前金：¥1,329,901
後金：¥1,132,920`;

test("依頼文から 版・言語 × 入金企業 × 前金・後金 の行を読む", () => {
  const r = parseReportPaste(SAMPLE);
  assert.equal(r.ratePct, 10);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows[0], { no: 1, language: "英語", company: "Asmodee", advance: 3739365, balance: 3564512, total: null });
  assert.equal(r.rows[2].language, "中国語繫体字");
  assert.equal(r.rows[3].no, 8);
  assert.equal(r.rows[3].company, "Don’t Panic");
});

test("金額は ¥・カンマ・円・全角を読む", () => {
  assert.equal(readYen("¥1,086,620"), 1086620);
  assert.equal(readYen("１２３，４５６円"), 123456);
  assert.equal(readYen("—"), null);
});

test("言語は許諾言語の表記に当てる（簡体字・繫体字・版）", () => {
  const langs = ["英語", "簡体中国語", "繁体中国語", "韓国語"];
  assert.equal(matchLanguage("英語", langs), "英語");
  assert.equal(matchLanguage("中国語簡体字", langs), "簡体中国語");
  assert.equal(matchLanguage("中国語繫体字", langs), "繁体中国語");
  assert.equal(matchLanguage("ドイツ語", langs), null);
});

test("会社名は記号・法人格・大文字小文字をそろえて当てる", () => {
  assert.ok(companyMatches("Asmodee", "Asmodee Asia Limited", "x"));
  assert.ok(companyMatches("Don’t Panic", "Don't Panic Games", "x"));
  assert.ok(companyMatches("MM-Spiele", null, "トーネードスプラッシュ｜ドイツ語｜ドイツ・オーストリア・スイス｜MM-Spiele"));
  assert.ok(!companyMatches("Asmodee", "MS Edizioni", "x"));
});

test("許諾先は 会社 × 言語 で選ぶ。会社だけ当たれば言語は空で返す", () => {
  const outs = [
    { id: 1, name: "A", partyName: "Asmodee Asia Limited", languages: ["英語", "簡体中国語"] },
    { id: 2, name: "B", partyName: "Asmodee Europe", languages: ["フランス語"] }
  ];
  assert.deepEqual(pickOut({ company: "Asmodee", language: "中国語簡体字" }, outs), { out: outs[0], language: "簡体中国語" });
  assert.deepEqual(pickOut({ company: "Asmodee", language: "フランス語" }, outs), { out: outs[1], language: "フランス語" });
  assert.deepEqual(pickOut({ company: "Asmodee", language: "ロシア語" }, outs), { out: outs[0], language: null });
  assert.equal(pickOut({ company: "CrowD Games", language: "ロシア語" }, outs), null);
});
