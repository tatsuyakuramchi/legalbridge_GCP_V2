import {
  deriveDeliveryAlerts, deriveContractAlerts, isWeekdayJst,
  type DeliveryAlert, type ContractCandidate, type DeliveryAlertKind
} from "./daily-checks-engine.js";
import type { DailyChecksRepository, AlertLedgerEntry } from "./daily-checks-repository.js";

// daily-checks 実行本体（Phase 9-1b/9-2）。候補読取→純関数エンジンで発火判定→通知→
// 送信できたものだけ台帳へ記録（dry-run では記録しない＝次回再計算）。満了自動遷移（9-3）は
// 本番 UPDATE を伴うため別スライスで opt-in 追加する。

export interface DailyChecksNotification {
  kind: string;                                  // 台帳 kind（delivery_7d 等 / contract_renewal）
  refType: "condition_line" | "document";
  refId: number;
  text: string;
}
export interface DailyChecksNotifier {
  readonly mode: "live" | "dry-run";
  send(notifications: DailyChecksNotification[]): Promise<{ delivered: DailyChecksNotification[]; failed: number }>;
}

export interface DailyChecksSummary {
  dryRun: boolean;
  deliveryAlerts: number;
  contractAlerts: number;
  sent: number;
  failed: number;
  recorded: number;
}

const DELIVERY_LEDGER_KIND: Record<DeliveryAlertKind, string> = {
  warning_7d: "delivery_7d",
  warning_3d: "delivery_3d",
  warning_1d: "delivery_1d",
  overdue: "delivery_overdue"
};

export function composeDeliveryText(a: DeliveryAlert): string {
  const when = a.kind === "overdue"
    ? `納期超過（${Math.abs(a.daysUntil)}日）`
    : `納期まで${a.daysUntil}日`;
  return `:calendar: ${when}｜${a.itemName}（課題 ${a.backlogIssueKey}）`;
}
export function composeContractText(c: ContractCandidate): string {
  const label = c.documentNumber ? `${c.documentNumber}｜` : "";
  return `:memo: 契約更新の通告期限が近づいています｜${label}${c.contractTitle ?? "(無題)"}（満了 ${c.expirationDate}）`;
}

export interface RunDailyChecksDeps {
  repo: DailyChecksRepository;
  notifier: DailyChecksNotifier;
  todayYmd: string;
  nowMs: number;
}

export async function runDailyChecks(deps: RunDailyChecksDeps): Promise<DailyChecksSummary> {
  const { repo, notifier, todayYmd, nowMs } = deps;
  const isWeekday = isWeekdayJst(nowMs);

  const deliveryCandidates = await repo.loadDeliveryCandidates(todayYmd);
  const deliveryAlerts = deriveDeliveryAlerts(deliveryCandidates, todayYmd, isWeekday);
  const contractCandidates = await repo.loadContractCandidates(todayYmd);
  const contractAlerts = deriveContractAlerts(contractCandidates, todayYmd);

  const notifications: DailyChecksNotification[] = [
    ...deliveryAlerts.map((a) => ({
      kind: DELIVERY_LEDGER_KIND[a.kind], refType: "condition_line" as const, refId: a.lineItemId, text: composeDeliveryText(a)
    })),
    ...contractAlerts.map((c) => ({
      kind: "contract_renewal", refType: "document" as const, refId: c.id, text: composeContractText(c)
    }))
  ];

  const base: DailyChecksSummary = {
    dryRun: notifier.mode === "dry-run",
    deliveryAlerts: deliveryAlerts.length,
    contractAlerts: contractAlerts.length,
    sent: 0, failed: 0, recorded: 0
  };
  if (!notifications.length) return base;

  const { delivered, failed } = await notifier.send(notifications);
  base.sent = delivered.length;
  base.failed = failed;

  // 実送信できたものだけ台帳へ記録（dry-run は記録せず次回再計算）。
  if (notifier.mode === "live" && delivered.length) {
    const entries: AlertLedgerEntry[] = delivered.map((d) => ({
      kind: d.kind, refType: d.refType, refId: d.refId, alertDate: todayYmd
    }));
    base.recorded = await repo.recordAlerts(entries);
  }
  return base;
}

// 既定の安全ノーティファイア：送信せず件数のみ返す（有効化直後の観測用）。
export class DryRunDailyChecksNotifier implements DailyChecksNotifier {
  readonly mode = "dry-run" as const;
  readonly captured: DailyChecksNotification[] = [];
  async send(notifications: DailyChecksNotification[]) {
    this.captured.push(...notifications);
    return { delivered: [] as DailyChecksNotification[], failed: 0 };
  }
}

// JST の当日日付（YYYY-MM-DD）。
export function jstTodayYmd(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
