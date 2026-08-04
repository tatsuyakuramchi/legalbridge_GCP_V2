import assert from "node:assert/strict";
import test from "node:test";
import { buildMatterDashboard } from "./dashboard.js";
import type { MatterSummary } from "./repository.js";

function matter(overrides: Partial<MatterSummary>): MatterSummary {
  return {
    id: 1, matterCode: "MTR-2026-00001", title: "案件", status: "open", counterparty: "",
    primaryIssueKey: null, lifecycleStage: null, ownerName: null, targetDueDate: null,
    blockedReason: null, issueCount: 0, documentCount: 0, openTaskCount: 0,
    nextTaskTitle: null, nextTaskDueAt: null, updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}
const NOW = new Date("2026-08-03T00:00:00.000Z"); // JST 2026-08-03

test("KPIは対応中・期限到来・停滞・完了を集計する", () => {
  const result = buildMatterDashboard([
    matter({ id: 1, status: "open" }),
    matter({ id: 2, status: "in_progress", targetDueDate: "2026-08-03" }),
    matter({ id: 3, status: "in_progress", blockedReason: "相手方待ち" }),
    matter({ id: 4, status: "closed" }),
    matter({ id: 5, status: "archived" })
  ], NOW);
  const kpi = new Map(result.kpis.map((k) => [k.label, k.value]));
  assert.equal(kpi.get("対応中"), 3);
  assert.equal(kpi.get("期限到来"), 1);
  assert.equal(kpi.get("停滞"), 1);
  assert.equal(kpi.get("完了"), 2);
  assert.equal(result.source, "live");
});

test("工程は5バケットにマップされる", () => {
  const result = buildMatterDashboard([
    matter({ id: 1, lifecycleStage: "intake" }),
    matter({ id: 2, lifecycleStage: "internal_review" }),
    matter({ id: 3, lifecycleStage: "drafting" }),
    matter({ id: 4, lifecycleStage: "signing" }),
    matter({ id: 5, lifecycleStage: "completed" })
  ], NOW);
  const stage = new Map(result.stages.map((s) => [s.label, s.count]));
  assert.equal(stage.get("受付"), 1);
  assert.equal(stage.get("審査"), 1);
  assert.equal(stage.get("ドラフト"), 1);
  assert.equal(stage.get("締結・履行"), 1);
  assert.equal(stage.get("完了"), 1);
});

test("優先案件は停滞→期限昇順で並び、期限超過を検出する", () => {
  const result = buildMatterDashboard([
    matter({ id: 1, status: "open", targetDueDate: "2026-08-10" }),
    matter({ id: 2, status: "open", targetDueDate: "2026-07-30" }),  // overdue
    matter({ id: 3, status: "in_progress", blockedReason: "停滞", targetDueDate: "2026-08-20" })
  ], NOW);
  assert.equal(result.priorities[0].matterId, 3);   // blocked first
  assert.equal(result.priorities[1].matterId, 2);   // then earliest due
  assert.equal(result.priorities[1].overdue, true);
  assert.equal(result.priorities[2].matterId, 1);
  // closed matters never appear in priorities
  assert.ok(result.priorities.every((p) => p.status !== "closed"));
});

test("決算バンドは省略時 null、渡すとそのまま反映される", () => {
  assert.equal(buildMatterDashboard([matter({ id: 1 })], NOW).settlement, null);

  const settlement = {
    plannedTotal: 1000, consumedTotal: 600, consumptionRate: 0.6,
    linesRequiringInspection: 4, linesInspected: 3, inspectionRate: 0.75
  };
  const result = buildMatterDashboard([matter({ id: 1 })], NOW, settlement);
  assert.deepEqual(result.settlement, settlement);
});

test("次アクションはprimaryタスクを期限昇順で返す", () => {
  const result = buildMatterDashboard([
    matter({ id: 1, nextTaskTitle: "ドラフト送付", nextTaskDueAt: "2026-08-05T00:00:00.000Z" }),
    matter({ id: 2, nextTaskTitle: "相手方確認", nextTaskDueAt: "2026-07-31T00:00:00.000Z" }),
    matter({ id: 3, nextTaskTitle: null })
  ], NOW);
  assert.equal(result.nextActions?.length, 2);
  assert.equal(result.nextActions?.[0].matterId, 2);
  assert.equal(result.nextActions?.[0].overdue, true);
  assert.equal(result.nextActions?.[1].matterId, 1);
});
