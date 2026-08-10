import assert from "node:assert/strict";
import test from "node:test";
import {
  daysBetween, isWeekdayJst, shouldAlertToday, classifyDeliveryAlert,
  deriveDeliveryAlerts, subtractMonths, inRenewalAlertWindow, deriveContractAlerts,
  isExpiredNeedingTransition, deriveExpiryTransitions,
  type DeliveryCandidate, type ContractCandidate, type ExpiryCandidate
} from "./daily-checks-engine.js";

test("daysBetween: 未来正・超過負・同日0", () => {
  assert.equal(daysBetween("2026-08-10", "2026-08-17"), 7);
  assert.equal(daysBetween("2026-08-10", "2026-08-09"), -1);
  assert.equal(daysBetween("2026-08-10", "2026-08-10"), 0);
});

test("isWeekdayJst: JST換算で平日判定", () => {
  // 2026-08-10 は月曜。00:00Z は JST 09:00 月曜 → 平日
  assert.equal(isWeekdayJst(Date.UTC(2026, 7, 10, 0, 0, 0)), true);
  // 2026-08-08 は土曜
  assert.equal(isWeekdayJst(Date.UTC(2026, 7, 8, 3, 0, 0)), false);
  // 2026-08-09 日曜 15:00Z = JST 月曜 00:00 → 平日（JST換算の境界）
  assert.equal(isWeekdayJst(Date.UTC(2026, 7, 9, 15, 0, 0)), true);
});

test("shouldAlertToday: 未通知/前日/本日", () => {
  assert.equal(shouldAlertToday(null, "2026-08-10"), true);
  assert.equal(shouldAlertToday("2026-08-09T23:00:00Z", "2026-08-10"), true);
  assert.equal(shouldAlertToday("2026-08-10T01:00:00Z", "2026-08-10"), false);
});

test("classifyDeliveryAlert: 7/3/1・超過は平日のみ", () => {
  assert.equal(classifyDeliveryAlert(7, true), "warning_7d");
  assert.equal(classifyDeliveryAlert(3, false), "warning_3d");
  assert.equal(classifyDeliveryAlert(1, true), "warning_1d");
  assert.equal(classifyDeliveryAlert(-2, true), "overdue");
  assert.equal(classifyDeliveryAlert(-2, false), null);   // 週末は超過通知しない
  assert.equal(classifyDeliveryAlert(5, true), null);      // 対象日以外
});

test("deriveDeliveryAlerts: 検収済/課題無/本日通知済を除外", () => {
  const base = { itemName: "納品物", lastAlertAt: null, fulfilled: false };
  const candidates: DeliveryCandidate[] = [
    { lineItemId: 1, deliveryDate: "2026-08-17", backlogIssueKey: "LB-1", ...base },      // 7日前 → 通知
    { lineItemId: 2, deliveryDate: "2026-08-17", backlogIssueKey: "LB-2", ...base, fulfilled: true }, // 検収済 → 除外
    { lineItemId: 3, deliveryDate: "2026-08-17", backlogIssueKey: null, ...base },        // 課題無 → 除外
    { lineItemId: 4, deliveryDate: "2026-08-11", backlogIssueKey: "LB-4", ...base, lastAlertAt: "2026-08-10T02:00:00Z" }, // 本日通知済 → 除外
    { lineItemId: 5, deliveryDate: "2026-08-05", backlogIssueKey: "LB-5", ...base }       // 超過 → 平日なら通知
  ];
  const alerts = deriveDeliveryAlerts(candidates, "2026-08-10", true);
  assert.deepEqual(alerts.map((a) => a.lineItemId).sort(), [1, 5]);
  assert.equal(alerts.find((a) => a.lineItemId === 1)?.kind, "warning_7d");
  assert.equal(alerts.find((a) => a.lineItemId === 5)?.kind, "overdue");
});

test("deriveDeliveryAlerts: 週末は超過を出さない", () => {
  const candidates: DeliveryCandidate[] = [
    { lineItemId: 5, deliveryDate: "2026-08-05", backlogIssueKey: "LB-5", itemName: "x", lastAlertAt: null, fulfilled: false }
  ];
  assert.equal(deriveDeliveryAlerts(candidates, "2026-08-10", false).length, 0);
});

test("subtractMonths: 月跨ぎ・月末クランプ", () => {
  assert.equal(subtractMonths("2026-08-31", 6), "2026-02-28"); // 2月末クランプ
  assert.equal(subtractMonths("2026-03-15", 3), "2025-12-15"); // 年跨ぎ
  assert.equal(subtractMonths("2026-08-10", 0), "2026-08-10");
});

test("inRenewalAlertWindow: 窓内/窓外/条件不備", () => {
  const c: ContractCandidate = {
    id: 1, documentNumber: "DOC-1", contractTitle: "契約", expirationDate: "2026-12-31",
    autoRenewal: true, renewalNoticeMonths: 3, alertLeadMonths: 1, lastRenewalAlertAt: null
  };
  // 窓開始 = 12/31 の 4か月前 = 2026-08-31
  assert.equal(inRenewalAlertWindow(c, "2026-09-01"), true);
  assert.equal(inRenewalAlertWindow(c, "2026-08-30"), false);          // 窓前
  assert.equal(inRenewalAlertWindow(c, "2027-01-01"), false);          // 満了後
  assert.equal(inRenewalAlertWindow({ ...c, autoRenewal: false }, "2026-09-01"), false);
  assert.equal(inRenewalAlertWindow({ ...c, alertLeadMonths: null }, "2026-09-01"), false);
  assert.equal(inRenewalAlertWindow({ ...c, lastRenewalAlertAt: "2026-09-01T00:00:00Z" }, "2026-09-01"), false); // 本日通知済
});

test("deriveContractAlerts: 窓内のみ", () => {
  const mk = (id: number, exp: string): ContractCandidate => ({
    id, documentNumber: `D${id}`, contractTitle: "c", expirationDate: exp,
    autoRenewal: true, renewalNoticeMonths: 3, alertLeadMonths: 1, lastRenewalAlertAt: null
  });
  const list = [mk(1, "2026-12-31"), mk(2, "2027-06-30")];
  const hits = deriveContractAlerts(list, "2026-09-01");
  assert.deepEqual(hits.map((c) => c.id), [1]);
});

test("isExpiredNeedingTransition: 満了超過かつ遷移可能ステータス", () => {
  const mk = (exp: string, st: string): ExpiryCandidate => ({ id: 1, documentNumber: "D", expirationDate: exp, contractStatus: st });
  assert.equal(isExpiredNeedingTransition(mk("2026-08-09", "executed"), "2026-08-10"), true);
  assert.equal(isExpiredNeedingTransition(mk("2026-08-09", "terminated"), "2026-08-10"), false); // 早期解約は触らない
  assert.equal(isExpiredNeedingTransition(mk("2026-08-10", "executed"), "2026-08-10"), false);   // 当日はまだ
  assert.equal(isExpiredNeedingTransition(mk("2026-08-09", "expired"), "2026-08-10"), false);     // 既に満了
});

test("deriveExpiryTransitions: 該当のみ抽出", () => {
  const list: ExpiryCandidate[] = [
    { id: 1, documentNumber: "D1", expirationDate: "2026-08-01", contractStatus: "executed" },
    { id: 2, documentNumber: "D2", expirationDate: "2026-08-01", contractStatus: "terminated" },
    { id: 3, documentNumber: "D3", expirationDate: "2026-09-01", contractStatus: "draft" }
  ];
  assert.deepEqual(deriveExpiryTransitions(list, "2026-08-10").map((c) => c.id), [1]);
});
