import test from "node:test";
import assert from "node:assert/strict";
import { originalWorkTitle, statementProductName } from "./product-name.js";

/**
 * 計算書の製品名の決め方。件名は原作名、明細は利用形態で変わる。
 */
test("自社製造・自社販売：原作から作った当社作品が1つならその名前", () => {
  assert.equal(statementProductName({ usageType: "in_house", inWorkTitle: "ito 原作", inWorkKind: "source_ip",
    childTitles: ["ito"] }), "ito");
  // 複数あれば決められないので原作名のまま（行の見出しで人が選ぶ）。
  assert.equal(statementProductName({ usageType: "in_house", inWorkTitle: "ito 原作", inWorkKind: "source_ip",
    childTitles: ["ito", "ito クラシック"] }), "ito 原作");
  // 原作と作品が同じ1件（ito のように独立した原作であり作品）。
  assert.equal(statementProductName({ usageType: "in_house", inWorkTitle: "ito", inWorkKind: "own",
    childTitles: [] }), "ito");
  // 利用形態の無い旧データも同じ扱い。
  assert.equal(statementProductName({ usageType: null, inWorkTitle: "ito", inWorkKind: "source_ip",
    childTitles: ["ito 製品"] }), "ito 製品");
});

test("再許諾・他社販売：アウト条件の条件名（製品名＋相手先名を書く運用）", () => {
  assert.equal(statementProductName({ usageType: "sublicense", outConditionName: "ito 英語版（Sublicensee Ltd.）",
    outWorkTitle: "ito", inWorkTitle: "ito 原作" }), "ito 英語版（Sublicensee Ltd.）");
  assert.equal(statementProductName({ usageType: "oem", outConditionName: "ito 北米版（Distributor Inc.）",
    outWorkTitle: "ito", inWorkTitle: "ito 原作" }), "ito 北米版（Distributor Inc.）");
  // 条件名が空なら作品名、それも無ければ原作名。
  assert.equal(statementProductName({ usageType: "sublicense", outConditionName: "", outWorkTitle: "ito",
    inWorkTitle: "ito 原作" }), "ito");
  assert.equal(statementProductName({ usageType: "oem", inWorkTitle: "ito 原作" }), "ito 原作");
});

test("件名の原作名：原作ならそのまま、当社作品なら系譜の親、無ければ作品名", () => {
  assert.equal(originalWorkTitle({ inWorkTitle: "ito 原作", inWorkKind: "source_ip" }), "ito 原作");
  assert.equal(originalWorkTitle({ inWorkTitle: "ito", inWorkKind: "own", sourceTitles: ["ito 原作"] }), "ito 原作");
  assert.equal(originalWorkTitle({ inWorkTitle: "ito", inWorkKind: "own", sourceTitles: ["原作A", "原作B"] }), "原作A・原作B");
  assert.equal(originalWorkTitle({ inWorkTitle: "ito", inWorkKind: "own", sourceTitles: [] }), "ito");
});
