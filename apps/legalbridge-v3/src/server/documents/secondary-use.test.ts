import { test } from "node:test";
import assert from "node:assert/strict";
import { SUT_USES_FIELD, isSecondaryUseTemplate, secondaryUsePatch, secondaryUseWarnings, secondaryUses, useCode } from "./secondary-use.js";
import { secondaryUseBlocker, secondaryUseConditionName } from "./secondary-use-conditions.js";
import { buildTemplateContext, lineFieldsFor, templateWarnings } from "./template-context.js";

const rows = [
  { category: "商品化", work_id: 1, work_title: "星降る夜のはなし", copyright: "© 見本 太郎", terms_no: "ARC-PUBT-2026-0041", actor: "own",
    content: "アクリルスタンドの製造・販売", exclusivity: "exclusive", regions: "日本", languages: "日本語",
    term_start: "2026-12-01", term_end: "2029-11-30", fee_type: "rate", rate: "5", fee_note: "見本は対象としない" },
  { category: "商品化", work_id: 1, work_title: "星降る夜のはなし", actor: "sublicense", sublicensee: "株式会社サンプルグッズ",
    content: "再許諾先による製造・販売", exclusivity: "non_exclusive", regions: "日本を除く全世界", rate: "50%" },
  { category: "映像化", work_id: 2, work_title: "設定資料集", actor: "sublicense", sublicensee: "製作委員会", content: "テレビアニメーション", rate: 60 },
  { category: "その他", work_id: 1, work_title: "星降る夜のはなし", actor: "own", content: "原画展", fee_type: "flat", flat_amount: 300000 },
  {} // 中身の無い行は数えない
];
const context = (isV5Master: boolean) => ({
  condition: { counterparty: { name: "合同会社サンプルワークス", address: "東京都", kind: "corporate" } },
  company: { name: "株式会社アークライト" },
  masterAgreement: { no: "ARC-PUB-2026-1010", title: "出版等許諾基本契約書", datedTitle: "2026年9月24日付出版等許諾基本契約書", isV5Master }
});

test("二次利用追加条件書：ひな形の見分け・行の符号・明細の欄", () => {
  assert.equal(isSecondaryUseTemplate("secondary_use_terms"), true);
  assert.equal(isSecondaryUseTemplate("pub_license_terms_v5"), false);
  assert.deepEqual(lineFieldsFor("secondary_use_terms"), [SUT_USES_FIELD]);
  assert.deepEqual([0, 1, 25, 26, 27].map(useCode), ["A", "B", "Z", "AA", "AB"]);
});

test("二次利用追加条件書：行を読む（中身の無い行は落とす。料率の % は外す。定額と料率を分ける）", () => {
  const uses = secondaryUses({ [SUT_USES_FIELD]: rows });
  assert.deepEqual(uses.map((u) => u.code), ["A", "B", "C", "D"]);
  assert.deepEqual(uses.map((u) => u.actor), ["own", "sublicense", "sublicense", "own"]);
  assert.deepEqual(uses.map((u) => u.ratePct), [5, 50, 60, null]);
  assert.equal(uses[3]!.feeType, "flat"); assert.equal(uses[3]!.flatAmount, 300000);
  // 条件名：作品名｜利用区分（再許諾／再許諾先）
  assert.deepEqual(uses.map(secondaryUseConditionName), [
    "星降る夜のはなし｜商品化", "星降る夜のはなし｜商品化（再許諾／株式会社サンプルグッズ）", "設定資料集｜映像化（再許諾／製作委員会）", "星降る夜のはなし｜その他"]);
  assert.deepEqual(uses.map(secondaryUseBlocker), [null, null, null, null]);
});

test("二次利用追加条件書：旧基本契約向けは 許諾者・被許諾者と第4条、V5 向けは 甲・乙と第5条（欄で選べば欄が勝つ）", () => {
  const v4 = secondaryUsePatch(context(false), { [SUT_USES_FIELD]: rows });
  assert.equal(v4.isV5, false); assert.equal(v4.partyA, "許諾者"); assert.equal(v4.partyB, "被許諾者");
  assert.equal(v4.agreementTitle, "2026年9月24日付出版等許諾基本契約書"); assert.equal(v4.agreementNo, "ARC-PUB-2026-1010");
  const v5 = secondaryUsePatch(context(true), { [SUT_USES_FIELD]: rows });
  assert.equal(v5.isV5, true); assert.equal(v5.partyA, "甲"); assert.equal(v5.partyB, "乙");
  assert.equal(secondaryUsePatch(context(false), { [SUT_USES_FIELD]: rows, "基本契約の版": "V5（著作物利用許諾基本契約書V5）" }).isV5, true);
  assert.equal(secondaryUsePatch(context(true), { [SUT_USES_FIELD]: rows, "基本契約の版": "旧（出版等許諾基本契約書）" }).isV5, false);

  // 01 対象著作物：行に出てくる作品を 1 回ずつ。作品が 2 点以上なら、行にどの作品かを書く。
  assert.deepEqual((v4.works as any[]).map((w) => [w.no, w.title, w.copyright, w.termsNo]),
    [[1, "星降る夜のはなし", "© 見本 太郎", "ARC-PUBT-2026-0041"], [2, "設定資料集", "", ""]]);
  assert.equal(v4.multiWorks, true);
  const use = (code: string) => (v4.uses as any[]).find((u) => u.code === code);
  assert.equal(use("A").workRef, "星降る夜のはなし");
  assert.equal(use("A").actor, "被許諾者（自社）"); assert.equal(use("B").actor, "再許諾先（03）");
  assert.equal(use("A").scope, "日本／日本語"); assert.equal(use("C").scope, "全世界／全言語");
  assert.equal(use("A").term, "2026.12.1〜2029.11.30"); assert.equal(use("C").term, "基本契約の有効期間中");
  // 04 対価：自社＝算定の基礎 × 料率、再許諾＝実受領額 × 料率、定額＝金額。
  assert.equal(use("A").feeText, "商品の税抜希望小売価格 × 製造数量 × 5%。見本は対象としない。");
  assert.equal(use("B").feeText, "被許諾者が再許諾先から現実に受領した金額 × 50%。");
  assert.equal(use("D").feeText, "金 300,000円（税別）（一括）。"); assert.equal(use("D").feeLabel, "その他（定額）");
  assert.equal((v5.uses as any[])[1].feeText, "乙が再許諾先から現実に受領した金額 × 50%。");
  // 03・05 の対象：再許諾＝B・C、自社（料率）＝A、定額＝D。再許諾しないのは自社の全部（A・D）。
  assert.equal(v4.subCodes, "B・C"); assert.equal(v4.ownCodes, "A"); assert.equal(v4.flatCodes, "D"); assert.equal(v4.ownAllCodes, "A・D");
  assert.equal(v4.sublicensees, "B：株式会社サンプルグッズ　／　C：製作委員会");
  assert.equal(v4.hasSublicense, true); assert.equal(v4.hasOwn, true); assert.equal(v4.hasFlat, true);
});

test("二次利用追加条件書：監修は既定がみなし承認（10 営業日・催告後 5 営業日）。「協議する」を選べる。終了後の在庫は 12 か月", () => {
  const base = secondaryUsePatch(context(false), { [SUT_USES_FIELD]: rows });
  assert.equal(base.approvalDeemed, true); assert.equal(base.approvalDays, "10"); assert.equal(base.approvalDeemedDays, "5");
  assert.equal(base.sellOffMonths, "12");
  assert.equal(base.paySub, "翌々月末日"); assert.equal(base.advanceText, "");
  const talk = secondaryUsePatch(context(false), { [SUT_USES_FIELD]: rows, "回答がないとき": "協議する", "回答の期限": "15" });
  assert.equal(talk.approvalDeemed, false); assert.equal(talk.approvalDays, "15");
});

test("二次利用追加条件書：決定の前の注意（行が無い・条件明細にできない行・作る本数）と、条件明細にできない行の理由", () => {
  const none = secondaryUseWarnings(context(false), {});
  assert.equal(none.length, 1); assert.match(none[0]!.message, /行がありません/);
  const bad = [{ category: "商品化", content: "", actor: "own" }, { category: "映像化", work_id: 2, work_title: "設定資料集", actor: "sublicense", content: "アニメ", rate: "120" }];
  const w = secondaryUseWarnings(context(false), { [SUT_USES_FIELD]: bad }).map((x) => x.message);
  assert.ok(w.some((m) => m.startsWith("A（商品化）：対象著作物・利用の内容・料率が入っていません")));
  assert.ok(w.some((m) => m.startsWith("B（映像化）：料率（0〜100%）が入っていません")));
  assert.ok(w.some((m) => m.includes("条件明細を 2 本作り")));
  const uses = secondaryUses({ [SUT_USES_FIELD]: bad });
  assert.equal(secondaryUseBlocker(uses[0]!), "A（商品化）：対象著作物・料率（0〜100%）を入れてください");
  assert.equal(secondaryUseBlocker(uses[1]!), "B（映像化）：料率（0〜100%）を入れてください");
  // 条件明細が付いた行は、作る本数に数えない（訂正版で二重に作らない）。
  const made = secondaryUseWarnings(context(false), { [SUT_USES_FIELD]: rows.slice(0, 4).map((r, i) => ({ ...r, condition_id: 100 + i })) });
  assert.equal(made.some((x) => x.message.includes("条件明細を")), false);
  // 基本契約が無いと作れない。
  assert.ok(secondaryUseWarnings({ condition: {} }, { [SUT_USES_FIELD]: rows }).some((x) => x.message.includes("基本契約が選ばれていません")));
});

test("二次利用追加条件書：本文に渡す値と注意が、ひな形の切り替え口から届く", () => {
  const values = buildTemplateContext("secondary_use_terms", context(true) as any, {}, { [SUT_USES_FIELD]: rows });
  assert.equal((values as any).partyA, "甲"); assert.equal(((values as any).uses as any[]).length, 4);
  assert.ok(templateWarnings("secondary_use_terms", context(true) as any, { [SUT_USES_FIELD]: rows }).some((w) => w.message.includes("条件明細を 4 本作り")));
});

test("二次利用の作品（原作つき）を選んだ行：01 に原作が並び、02 の行に作品名と原作の点数。原作名が無ければ注意", () => {
  const ledger = {
    10: { id: 10, title: "シノビガミ グッズ", kind: "derivative", sourceTitle: "シノビガミシリーズ", copyright: null, termsNo: null,
          sources: [{ id: 101, title: "シノビガミ 基本ルールブック", copyright: "© 河嶋陶一朗", termsNo: "ARC-PUBT-2026-0101" },
                    { id: 102, title: "シノビガミ 流派ブック", copyright: null, termsNo: null }] },
    11: { id: 11, title: "名前の無いグッズ", kind: "derivative", sourceTitle: null, copyright: null, termsNo: null,
          sources: [{ id: 103, title: "別の本", copyright: null, termsNo: null }] }
  };
  const ctx = { ...context(false), secondaryWorks: ledger };
  const row = { category: "商品化", work_id: 10, work_title: "シノビガミ グッズ", actor: "own", content: "グッズの製造・販売", rate: "5",
                copyright: "© 冒険企画局" };
  const p = secondaryUsePatch(ctx, { [SUT_USES_FIELD]: [row] });
  // 01：グッズの作品ではなく原作を並べる。原作に表示が無ければ行の表示で埋める。番号は台帳の個別契約。
  assert.deepEqual((p.works as any[]).map((w) => [w.no, w.title, w.copyright, w.termsNo]), [
    [1, "シノビガミ 基本ルールブック", "© 河嶋陶一朗", "ARC-PUBT-2026-0101"],
    [2, "シノビガミ 流派ブック", "© 冒険企画局", ""]]);
  assert.equal((p.uses as any[])[0].workRef, "シノビガミ グッズ（シノビガミシリーズ・原作 2 点。01 のとおり）");
  // 原作名の無い二次利用の作品は、決定の前に注意。
  const warn = secondaryUseWarnings({ ...ctx }, { [SUT_USES_FIELD]: [{ ...row, work_id: 11, work_title: "名前の無いグッズ" }] });
  assert.ok(warn.some((w) => w.message.includes("原作名（計算書の件名）がありません")));
  assert.ok(!secondaryUseWarnings(ctx, { [SUT_USES_FIELD]: [row] }).some((w) => w.message.includes("原作名")));
  // 台帳に無い（引いていない）作品は、これまでどおり行の作品をそのまま並べる。
  const plain = secondaryUsePatch(context(false), { [SUT_USES_FIELD]: [row] });
  assert.deepEqual((plain.works as any[]).map((w) => w.title), ["シノビガミ グッズ"]);
  assert.equal((plain.uses as any[])[0].workRef, "");
});
