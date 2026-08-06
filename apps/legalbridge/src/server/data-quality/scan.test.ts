import assert from "node:assert/strict";
import test from "node:test";
import { summarizeQuality, type QualityCategory } from "./scan.js";

const cat = (over: Partial<QualityCategory> & { key: string }): QualityCategory => ({
  label: over.key, description: "", severity: "medium", available: true, count: 0, samples: [], ...over
});

test("summarizeQuality は available のみ集計する", () => {
  const report = summarizeQuality([
    cat({ key: "a", severity: "high", count: 3 }),
    cat({ key: "b", severity: "medium", count: 2 }),
    cat({ key: "c", severity: "low", count: 0 }),
    cat({ key: "d", available: false, count: 0 })
  ]);
  assert.equal(report.summary.totalIssues, 5);
  assert.equal(report.summary.highIssues, 3);
  assert.equal(report.summary.categoriesWithIssues, 2);
  assert.equal(report.summary.scannedCategories, 3);
  assert.equal(report.summary.unavailableCategories, 1);
});

test("summarizeQuality は重大度→件数降順に並べ、未スキャンを末尾へ", () => {
  const report = summarizeQuality([
    cat({ key: "low1", severity: "low", count: 9 }),
    cat({ key: "unavail", available: false }),
    cat({ key: "high1", severity: "high", count: 1 }),
    cat({ key: "med-big", severity: "medium", count: 10 }),
    cat({ key: "med-small", severity: "medium", count: 2 })
  ]);
  assert.deepEqual(report.categories.map((c) => c.key), ["high1", "med-big", "med-small", "low1", "unavail"]);
});

test("空入力はゼロサマリ", () => {
  const report = summarizeQuality([]);
  assert.equal(report.summary.totalIssues, 0);
  assert.equal(report.categories.length, 0);
});
