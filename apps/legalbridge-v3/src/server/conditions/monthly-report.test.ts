import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matterLinesText, parseMonthlyReport, reportWarnings } from "./monthly-report.js";

/** 月次業務報告書兼フィー精算書（Excel）。fixtures/monthly_report.xlsx は本番の様式と同じセルに値を置いた見本。 */
const buf = readFileSync(new URL("./fixtures/monthly_report.xlsx", import.meta.url));

test("決まったセルから 対象月・提出日・実績時間・超過時間・設定値 を読む", () => {
  const r = parseMonthlyReport(buf);
  assert.deepEqual(r.sheetNames, ["月次報告書", "案件別発注管理", "設定"]);
  assert.equal(r.targetMonth, "2026-11");
  assert.equal(r.submittedOn, "2026-12-02");
  assert.equal(r.actualHours, 72);
  assert.equal(r.overtimeHours, 8);
  assert.equal(r.baseHours, 64);
  assert.equal(r.baseFee, 224000);
  assert.equal(r.unitRate, 3500);
});

test("案件別の実績と経費明細（合計の行は拾わない）", () => {
  const r = parseMonthlyReport(buf);
  assert.equal(r.matters.length, 4);
  assert.deepEqual(r.matters[1], { code: "LGL-004", name: "契約書レビュー（海外制作チーム）", category: "レビュー", hours: 31.5, outcome: "英文制作委託契約 3 件" });
  assert.equal(r.expenses.length, 2);
  assert.deepEqual(r.expenses[0], { date: "2026-11-12", category: "交通費", description: "打合せ来訪 往復", amount: 920 });
  assert.equal(matterLinesText(r).split("\n")[0], "LGL-003 契約スキーム相談 18 h");
});

test("条件明細と Excel の設定値の食い違いは警告（Excel の値は使わない）", () => {
  const r = parseMonthlyReport(buf);
  const w = reportWarnings(r, { timeSettlement: true, hoursIncluded: 64, flatAmount: 200000, overageUnitAmount: 3125 },
                           { serviceFrom: "2026-11-01", serviceTo: "2026-11-30" });
  assert.equal(w.length, 2, w.join(" / "));
  assert.match(w[0], /基本報酬 224,000 円は条件明細の月額 200,000 円と違います/);
  assert.match(w[1], /基準単価 3,500 円は条件明細の超過単価 3,125 円と違います/);
  const other = reportWarnings(r, { timeSettlement: true, hoursIncluded: 64, flatAmount: 224000, overageUnitAmount: 3500 },
                               { serviceFrom: "2026-12-01", serviceTo: "2026-12-31" });
  assert.deepEqual(other, ["Excel の対象月 2026-11 はこの回（2026-12）と違います"]);
});

test("xlsx でないものは読まない", () => {
  assert.throws(() => parseMonthlyReport(Buffer.from("not a workbook")), /xlsx ではありません/);
});
