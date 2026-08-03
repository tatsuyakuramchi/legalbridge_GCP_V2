import type { DashboardSummary } from "../../types.js";
import type { MatterSummary } from "./repository.js";

// Map the fine-grained lifecycle_stage values onto the five-step funnel the
// home cockpit shows. Read-only projection over matter_overview_v — no schema
// or template change.
const STAGE_BUCKETS: Array<{ label: string; stages: string[] }> = [
  { label: "受付", stages: ["intake", "triage"] },
  { label: "審査", stages: ["internal_review", "counterparty_review"] },
  { label: "ドラフト", stages: ["drafting"] },
  { label: "締結・履行", stages: ["signing", "performance", "inspection", "invoicing_payment", "completion_check"] },
  { label: "完了", stages: ["completed", "cancelled"] }
];
const OPEN_STATUSES = new Set(["open", "in_progress"]);

function todayKey(now: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now); // YYYY-MM-DD
}
function isOverdue(dueDate: string | null | undefined, today: string) {
  return Boolean(dueDate && dueDate.slice(0, 10) < today);
}
function dueSortKey(due: string | null | undefined) {
  return due ? due.slice(0, 10) : "9999-99-99";
}

// Pure so it is trivially testable; `now` is injected to stay deterministic.
export function buildMatterDashboard(matters: MatterSummary[], now: Date): DashboardSummary {
  const today = todayKey(now);
  const open = matters.filter((m) => OPEN_STATUSES.has(m.status));
  const dueToday = open.filter((m) => Boolean(m.targetDueDate) && m.targetDueDate!.slice(0, 10) <= today);
  const blocked = open.filter((m) => Boolean(m.blockedReason));
  const closed = matters.filter((m) => m.status === "closed" || m.status === "archived");

  const kpis: DashboardSummary["kpis"] = [
    { label: "対応中", value: open.length, tone: "warning" },
    { label: "期限到来", value: dueToday.length, tone: dueToday.length ? "danger" : "default" },
    { label: "停滞", value: blocked.length, tone: blocked.length ? "warning" : "default" },
    { label: "完了", value: closed.length }
  ];

  const stages = STAGE_BUCKETS.map((bucket) => ({
    label: bucket.label,
    count: matters.filter((m) => m.lifecycleStage && bucket.stages.includes(m.lifecycleStage)).length
  }));

  const priorities = [...open]
    .sort((a, b) => {
      if (Boolean(a.blockedReason) !== Boolean(b.blockedReason)) return a.blockedReason ? -1 : 1;
      const byDue = dueSortKey(a.targetDueDate).localeCompare(dueSortKey(b.targetDueDate));
      if (byDue !== 0) return byDue;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    })
    .slice(0, 6)
    .map((m) => ({
      id: m.matterCode ?? `#${m.id}`,
      matterId: m.id,
      title: m.title,
      counterparty: m.counterparty || "相手方未設定",
      owner: m.ownerName ?? "",
      stage: m.lifecycleStage
        ? (STAGE_BUCKETS.find((s) => s.stages.includes(m.lifecycleStage!))?.label ?? "工程未設定")
        : "工程未設定",
      dueDate: m.targetDueDate ?? "",
      status: m.status,
      overdue: isOverdue(m.targetDueDate, today)
    }));

  const nextActions = matters
    .filter((m) => m.nextTaskTitle)
    .sort((a, b) => dueSortKey(a.nextTaskDueAt).localeCompare(dueSortKey(b.nextTaskDueAt)))
    .slice(0, 6)
    .map((m) => ({
      matterId: m.id,
      matterCode: m.matterCode ?? `#${m.id}`,
      title: m.title,
      taskTitle: m.nextTaskTitle!,
      dueAt: m.nextTaskDueAt,
      overdue: isOverdue(m.nextTaskDueAt, today)
    }));

  return { kpis, stages, priorities, nextActions, source: "live" };
}
