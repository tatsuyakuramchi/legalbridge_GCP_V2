import assert from "node:assert/strict";
import test from "node:test";
import {
  runDailyChecks, DryRunDailyChecksNotifier, jstTodayYmd, composeDeliveryText, composeContractText,
  type DailyChecksNotifier, type DailyChecksNotification
} from "./daily-checks-runner.js";
import { MemoryDailyChecksRepository } from "./daily-checks-repository.js";
import type { DeliveryCandidate, ContractCandidate } from "./daily-checks-engine.js";

const MON = Date.UTC(2026, 7, 10, 3, 0, 0); // 2026-08-10 月曜 JST 昼
const TODAY = "2026-08-10";

class CaptureNotifier implements DailyChecksNotifier {
  readonly mode = "live" as const;
  readonly sent: DailyChecksNotification[] = [];
  async send(notifications: DailyChecksNotification[]) {
    this.sent.push(...notifications);
    return { delivered: notifications, failed: 0 };
  }
}

function delivery(over: Partial<DeliveryCandidate> & { lineItemId: number }): DeliveryCandidate {
  return { itemName: "納品物", deliveryDate: "2026-08-17", backlogIssueKey: "LB-1", lastAlertAt: null, fulfilled: false, ...over };
}
function contract(over: Partial<ContractCandidate> & { id: number }): ContractCandidate {
  return {
    documentNumber: "DOC-1", contractTitle: "契約", expirationDate: "2026-12-31",
    autoRenewal: true, renewalNoticeMonths: 3, alertLeadMonths: 1, lastRenewalAlertAt: null, ...over
  };
}

test("jstTodayYmd: JST換算の当日", () => {
  assert.equal(jstTodayYmd(MON), "2026-08-10");
  assert.equal(jstTodayYmd(Date.UTC(2026, 7, 9, 16, 0, 0)), "2026-08-10"); // 日曜16:00Z=月曜1:00JST
});

test("live: 発火分を送信し台帳へ記録", async () => {
  const repo = new MemoryDailyChecksRepository(
    [delivery({ lineItemId: 1, deliveryDate: "2026-08-17" })],            // 7日前
    [contract({ id: 9, expirationDate: "2026-12-31" })]                   // 窓内（開始8/31? no）
  );
  const notifier = new CaptureNotifier();
  const summary = await runDailyChecks({ repo, notifier, todayYmd: TODAY, nowMs: MON });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.deliveryAlerts, 1);
  // 契約：窓開始=12/31の4か月前=8/31 → 8/10 は窓前なので発火しない
  assert.equal(summary.contractAlerts, 0);
  assert.equal(summary.sent, 1);
  assert.equal(summary.recorded, 1);
  assert.equal(repo.ledger.length, 1);
  assert.equal(repo.ledger[0].kind, "delivery_7d");
  assert.equal(repo.ledger[0].refId, 1);
});

test("live: 契約更新は窓内で発火し contract_renewal を記録", async () => {
  const repo = new MemoryDailyChecksRepository([], [contract({ id: 9, expirationDate: "2026-09-30" })]);
  // 窓開始 = 9/30 の4か月前 = 5/30 → 8/10 は窓内
  const notifier = new CaptureNotifier();
  const summary = await runDailyChecks({ repo, notifier, todayYmd: TODAY, nowMs: MON });
  assert.equal(summary.contractAlerts, 1);
  assert.equal(summary.recorded, 1);
  assert.equal(repo.ledger[0].kind, "contract_renewal");
  assert.equal(repo.ledger[0].refType, "document");
});

test("dry-run: 件数は返すが送信も記録もしない", async () => {
  const repo = new MemoryDailyChecksRepository([delivery({ lineItemId: 1, deliveryDate: "2026-08-17" })], []);
  const notifier = new DryRunDailyChecksNotifier();
  const summary = await runDailyChecks({ repo, notifier, todayYmd: TODAY, nowMs: MON });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.deliveryAlerts, 1);
  assert.equal(summary.sent, 0);
  assert.equal(summary.recorded, 0);
  assert.equal(repo.ledger.length, 0);
  assert.equal(notifier.captured.length, 1); // 何が送られる予定かは観測できる
});

test("台帳で当日送信済みは再送しない", async () => {
  const repo = new MemoryDailyChecksRepository([delivery({ lineItemId: 1, deliveryDate: "2026-08-17", lastAlertAt: "2026-08-10T02:00:00Z" })], []);
  const notifier = new CaptureNotifier();
  const summary = await runDailyChecks({ repo, notifier, todayYmd: TODAY, nowMs: MON });
  assert.equal(summary.deliveryAlerts, 0);
  assert.equal(summary.sent, 0);
});

test("発火なしはゼロ件サマリ", async () => {
  const repo = new MemoryDailyChecksRepository([], []);
  const summary = await runDailyChecks({ repo, notifier: new CaptureNotifier(), todayYmd: TODAY, nowMs: MON });
  assert.equal(summary.deliveryAlerts, 0);
  assert.equal(summary.contractAlerts, 0);
  assert.equal(summary.sent, 0);
});

test("compose: 文言に日数・課題・満了日を含む", () => {
  assert.match(composeDeliveryText({ lineItemId: 1, itemName: "X", backlogIssueKey: "LB-9", kind: "overdue", daysUntil: -2 }), /超過（2日）.*LB-9/);
  assert.match(composeContractText(contract({ id: 1 })), /満了 2026-12-31/);
});
