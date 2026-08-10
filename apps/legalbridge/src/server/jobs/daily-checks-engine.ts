// V1 runDailyChecks の判定ロジックを純関数として移植（Phase 9-1/9-2/9-3）。
// SQL・Slack 送信・DB 更新は含めない（呼び出し側=repository/route が担う）。
//   1. 納期アラート：残 7/3/1 日は各1回、超過は平日のみ毎日（同日重複は last_alert_at で抑止）
//   2. 契約更新通告アラート：通告期限の alert_lead_months 前〜満了日の窓、同日重複抑止
//   3. 満了ステータス自動遷移：満了日超過かつ status が draft/awaiting_signature/executed

export type DeliveryAlertKind = "warning_7d" | "warning_3d" | "warning_1d" | "overdue";

// ── 日付ユーティリティ（YYYY-MM-DD 基準・UTC 換算で日数比較） ──
function ymd(value: string): string { return String(value).slice(0, 10); }
function toUtcDays(dateYmd: string): number {
  const [y, m, d] = ymd(dateYmd).split("-").map(Number);
  return Math.floor(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

// target - today（日数）。正=未来、負=超過。
export function daysBetween(todayYmd: string, targetYmd: string): number {
  return toUtcDays(targetYmd) - toUtcDays(todayYmd);
}

// JST での平日判定（月〜金）。nowMs はテスト容易性のため引数化。
export function isWeekdayJst(nowMs: number): boolean {
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const dow = jst.getUTCDay(); // 0=Sun..6=Sat
  return dow >= 1 && dow <= 5;
}

// 同日内の重複抑止：last_alert_at の「日付」が today 未満なら本日まだ通知していない。
export function shouldAlertToday(lastAlertAt: string | null | undefined, todayYmd: string): boolean {
  if (!lastAlertAt) return true;
  return ymd(lastAlertAt) < ymd(todayYmd);
}

// 残日数から通知種別を導く（超過は平日のみ）。対象外は null。
export function classifyDeliveryAlert(daysUntil: number, isWeekday: boolean): DeliveryAlertKind | null {
  if (daysUntil === 7) return "warning_7d";
  if (daysUntil === 3) return "warning_3d";
  if (daysUntil === 1) return "warning_1d";
  if (daysUntil < 0) return isWeekday ? "overdue" : null;
  return null;
}

export interface DeliveryCandidate {
  lineItemId: number;
  itemName: string;
  deliveryDate: string | null;      // YYYY-MM-DD
  backlogIssueKey: string | null;
  lastAlertAt: string | null;       // ISO or null
  fulfilled: boolean;               // 全量検収済みは対象外
}
export interface DeliveryAlert {
  lineItemId: number;
  itemName: string;
  backlogIssueKey: string;
  kind: DeliveryAlertKind;
  daysUntil: number;
}

export function deriveDeliveryAlerts(candidates: DeliveryCandidate[], todayYmd: string, isWeekday: boolean): DeliveryAlert[] {
  const out: DeliveryAlert[] = [];
  for (const c of candidates) {
    if (c.fulfilled) continue;
    if (!c.deliveryDate) continue;
    if (!c.backlogIssueKey) continue;
    if (!shouldAlertToday(c.lastAlertAt, todayYmd)) continue;
    const daysUntil = daysBetween(todayYmd, c.deliveryDate);
    const kind = classifyDeliveryAlert(daysUntil, isWeekday);
    if (!kind) continue;
    out.push({ lineItemId: c.lineItemId, itemName: c.itemName, backlogIssueKey: c.backlogIssueKey, kind, daysUntil });
  }
  return out;
}

// ── 契約更新通告アラート ──
export interface ContractCandidate {
  id: number;
  documentNumber: string | null;
  contractTitle: string | null;
  expirationDate: string;                // YYYY-MM-DD
  autoRenewal: boolean;
  renewalNoticeMonths: number | null;
  alertLeadMonths: number | null;
  lastRenewalAlertAt: string | null;
}

// YYYY-MM-DD から months か月前を返す（月末日クランプ）。
export function subtractMonths(dateYmd: string, months: number): string {
  const [y, m, d] = ymd(dateYmd).split("-").map(Number);
  const base = new Date(Date.UTC(y, (m - 1) - months, 1));
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// 通告アラート窓：today ∈ [expiration -(notice+lead)月, expiration] かつ本日未通知。
export function inRenewalAlertWindow(c: ContractCandidate, todayYmd: string): boolean {
  if (!c.autoRenewal) return false;
  if (c.renewalNoticeMonths == null || c.alertLeadMonths == null) return false;
  if (!shouldAlertToday(c.lastRenewalAlertAt, todayYmd)) return false;
  const windowStart = subtractMonths(c.expirationDate, c.renewalNoticeMonths + c.alertLeadMonths);
  const t = ymd(todayYmd);
  return t >= windowStart && t <= ymd(c.expirationDate);
}

export function deriveContractAlerts(candidates: ContractCandidate[], todayYmd: string): ContractCandidate[] {
  return candidates.filter((c) => inRenewalAlertWindow(c, todayYmd));
}

// ── 満了ステータス自動遷移 ──
const TRANSITIONABLE = new Set(["draft", "awaiting_signature", "executed"]);
export interface ExpiryCandidate {
  id: number;
  documentNumber: string | null;
  expirationDate: string;   // YYYY-MM-DD
  contractStatus: string;
}
export function isExpiredNeedingTransition(c: ExpiryCandidate, todayYmd: string): boolean {
  return ymd(c.expirationDate) < ymd(todayYmd) && TRANSITIONABLE.has(c.contractStatus);
}
export function deriveExpiryTransitions(candidates: ExpiryCandidate[], todayYmd: string): ExpiryCandidate[] {
  return candidates.filter((c) => isExpiredNeedingTransition(c, todayYmd));
}
