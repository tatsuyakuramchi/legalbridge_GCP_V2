import { inTransaction, dateStr, str, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import {
  DELIVERY_ALERT_KEY, fillTemplate, readDeliveryAlertSettings, type DeliveryAlertSettings
} from "../ops/delivery-alert-settings.js";

/**
 * 納期アラート。V1 の daily-checks（発注書の明細ごとに納期 7・3・1 日前と超過）の置き換え。
 *
 * 対象は「こちらが頼んだもの」（向きが in の役務・製品の条件）で、まだ納品も検収も
 * 付いていないもの。納期は条件の delivery_due、分納なら予定明細の due_on。
 *
 * 知らせる内容（何日前か・超過・文面）と送り先（依頼者・担当・チャンネル・部署ごとの
 * チャンネル）は設定画面で変える（settings の delivery_alert）。
 *
 * 同じ日に二度流しても二度は送らない（冪等キー delivery-alert:<条件>:<回>:<日付>）。
 * V1 は二重送信の防止が効いていなかった（last_alert_at が常に NULL）。
 */

export type AlertKind = "before" | "overdue";

export interface DeliveryItem {
  conditionId: number;
  scheduleId: number | null;
  due: string;
  daysUntil: number;
  item: string;
  party: string;
  matterId: number | null;
  matterNo: string | null;
  matterTitle: string | null;
  requesterSlackId: string | null;
  requesterDepartment: string | null;
  ownerSlackId: string | null;
  purchaseOrderNo: string | null;
}

export interface PlannedAlert {
  key: string;
  kind: AlertKind;
  item: DeliveryItem;
  recipients: Array<{ to: string; why: "requester" | "owner" | "channel" | "department" }>;
  body: string;
}

export interface DeliveryAlertReport {
  ran: boolean;
  reason?: string;
  date: string;
  preview: boolean;
  /** 納期が近い・過ぎている未納品の件数（知らせる日でないものも含む）。 */
  pending: number;
  alerts: Array<{ key: string; kind: AlertKind; conditionId: number; matterNo: string | null;
                  due: string; daysUntil: number; recipients: string[]; sent: number; body?: string }>;
  /** 今日すでに知らせた分。 */
  alreadySent: number;
  /** 送り先が1つも無かった分（依頼者も担当もチャンネルも無い）。 */
  noRecipient: Array<{ conditionId: number; matterNo: string | null; due: string }>;
  failures: Array<{ key: string; error: string }>;
}

export interface DeliveryAlertDeps {
  database: Transactable;
  /** Slack へ送る（dispatch のゲートを通す）。送れたら true。 */
  send: (conditionId: number, recipient: string, body: string) => Promise<boolean>;
  /** 今日（東京）。テストで差し替える。 */
  today?: () => string;
}

export const ACTOR = "system:delivery-alert";

/** 東京の今日（YYYY-MM-DD）。 */
export function tokyoToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
}

const isWeekday = (ymd: string) => {
  const day = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

const japaneseDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${y}年${m}月${d}日`;
};

/** 今日この項目を知らせるか。知らせるならその種類。 */
export function alertKindFor(item: DeliveryItem, s: DeliveryAlertSettings, today: string): AlertKind | null {
  if (item.daysUntil > 0) return s.daysBefore.includes(item.daysUntil) ? "before" : null;
  if (item.daysUntil < 0) {
    if (!s.overdue) return null;
    if (s.overdueUntilDays > 0 && -item.daysUntil > s.overdueUntilDays) return null;
    if (s.overdueWeekdaysOnly && !isWeekday(today)) return null;
    return "overdue";
  }
  return null;   // 当日は知らせない（前日に「あと 1 日」を出している）
}

/** 送り先。重複は1つにまとめる。 */
export function recipientsFor(item: DeliveryItem, s: DeliveryAlertSettings): PlannedAlert["recipients"] {
  const out: PlannedAlert["recipients"] = [];
  const add = (to: string | null | undefined, why: PlannedAlert["recipients"][number]["why"]) => {
    if (to && !out.some((r) => r.to === to)) out.push({ to, why });
  };
  if (s.notifyRequester) add(item.requesterSlackId, "requester");
  if (s.notifyOwner) add(item.ownerSlackId, "owner");
  for (const c of s.channels) add(c.id, "channel");
  const dept = item.requesterDepartment?.trim();
  if (dept) for (const c of s.departmentChannels) if (c.department === dept) add(c.id, "department");
  return out;
}

export function alertBody(kind: AlertKind, item: DeliveryItem, s: DeliveryAlertSettings): string {
  return fillTemplate(kind === "before" ? s.templates.before : s.templates.overdue, {
    残り日数: String(Math.max(item.daysUntil, 0)),
    超過日数: String(Math.max(-item.daysUntil, 0)),
    納期: japaneseDate(item.due),
    案件番号: item.matterNo ?? "（案件なし）",
    件名: item.matterTitle ?? "",
    相手先: item.party,
    品目: item.item,
    発注書番号: item.purchaseOrderNo ?? "—",
    依頼者: item.requesterSlackId ? `<@${item.requesterSlackId}>` : ""
  }).trim();
}

export class DeliveryAlertJob {
  constructor(private readonly deps: DeliveryAlertDeps) {}

  /** preview=true なら送らず、何を誰に送るかだけ返す（設定画面の確認用）。 */
  async run(options: { preview?: boolean } = {}): Promise<DeliveryAlertReport> {
    const { database } = this.deps;
    const preview = Boolean(options.preview);
    const today = this.deps.today?.() ?? tokyoToday();
    const report: DeliveryAlertReport = {
      ran: true, date: today, preview, pending: 0, alerts: [], alreadySent: 0, noRecipient: [], failures: []
    };
    try {
      const stored = await database.query("SELECT value FROM settings WHERE key = $1", [DELIVERY_ALERT_KEY]);
      const settings = readDeliveryAlertSettings((stored.rows[0] as any)?.value);
      if (!settings.enabled && !preview) {
        return { ...report, ran: false, reason: "納期アラートは止めてあります（設定の「納期アラート」）" };
      }

      const items = await this.items(today, settings);
      report.pending = items.length;

      const done = await database.query(
        `SELECT idempotency_key FROM audit_events
          WHERE action = 'delivery.alert' AND idempotency_key LIKE $1`, [`delivery-alert:%:${today}`]);
      const sentToday = new Set((done.rows as any[]).map((r) => String(r.idempotency_key)));

      for (const item of items) {
        const kind = alertKindFor(item, settings, today);
        if (!kind) continue;
        const key = `delivery-alert:${item.conditionId}:${item.scheduleId ?? "-"}:${today}`;
        if (sentToday.has(key)) { report.alreadySent += 1; continue; }

        const recipients = recipientsFor(item, settings);
        if (!recipients.length) {
          report.noRecipient.push({ conditionId: item.conditionId, matterNo: item.matterNo, due: item.due });
          continue;
        }
        const body = alertBody(kind, item, settings);
        const line = { key, kind, conditionId: item.conditionId, matterNo: item.matterNo, due: item.due,
                       daysUntil: item.daysUntil, recipients: recipients.map((r) => r.to), sent: 0 };
        if (preview) { report.alerts.push({ ...line, body }); continue; }

        try {
          for (const r of recipients) {
            if (await this.deps.send(item.conditionId, r.to, body)) line.sent += 1;
          }
          // ゲートで止まっても記録する（同じ日に二度流しても重ねて送らない）。
          await inTransaction(database, (client) => recordAudit(client, {
            actor: ACTOR, action: "delivery.alert", targetType: "condition", targetId: item.conditionId,
            idempotencyKey: key,
            detail: { kind, due: item.due, daysUntil: item.daysUntil, scheduleId: item.scheduleId,
                      matterNo: item.matterNo, recipients: line.recipients, sent: line.sent }
          }));
          report.alerts.push(line);
        } catch (error) {
          report.failures.push({ key, error: (error as Error)?.message ?? String(error) });
        }
      }

      if (!preview) {
        await inTransaction(database, (client) => recordAudit(client, {
          actor: ACTOR, action: "job.delivery_alert", targetType: "job",
          detail: { date: today, pending: report.pending, alerts: report.alerts.length,
                    alreadySent: report.alreadySent, noRecipient: report.noRecipient.length,
                    failures: report.failures.slice(0, 20) }
        }));
      }
      return report;
    } catch (error) { throw translate(error); }
  }

  /** 納期が窓の中にある未納品。窓は「最も早い何日前」から「超過を知らせる日数」まで。 */
  private async items(today: string, s: DeliveryAlertSettings): Promise<DeliveryItem[]> {
    const ahead = Math.max(0, ...s.daysBefore);
    const behind = s.overdue ? (s.overdueUntilDays > 0 ? s.overdueUntilDays : 3650) : 0;
    const r = await this.deps.database.query(
      `WITH base AS (
         -- 分納：回ごとの納期
         SELECT s.condition_id, s.id AS schedule_id, s.due_on AS due,
                c.name || COALESCE('（' || s.label || '）', '') AS item
           FROM condition_schedules s JOIN conditions c ON c.id = s.condition_id
          WHERE s.trigger_kind IN ('on_delivery', 'on_inspection') AND s.due_on IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM condition_events e
                             WHERE e.schedule_id = s.id AND e.status = 'active'
                               AND e.event_type IN ('delivery', 'inspection'))
         UNION ALL
         -- 条件1本の納期（回ごとの納期が無いもの）
         SELECT c.id, NULL, c.delivery_due, c.name
           FROM conditions c
          WHERE c.delivery_due IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM condition_schedules s
                             WHERE s.condition_id = c.id AND s.due_on IS NOT NULL
                               AND s.trigger_kind IN ('on_delivery', 'on_inspection'))
            AND NOT EXISTS (SELECT 1 FROM condition_events e
                             WHERE e.condition_id = c.id AND e.status = 'active'
                               AND e.event_type IN ('delivery', 'inspection'))
       )
       SELECT b.condition_id, b.schedule_id, b.due, b.item,
              (b.due - $1::date) AS days_until,
              p.name AS party,
              m.id AS matter_id, m.matter_no, m.title AS matter_title, m.requester_slack_id,
              os.slack_user_id AS owner_slack_id, rs.department AS requester_department,
              po.document_no AS po_no
         FROM base b
         JOIN conditions c ON c.id = b.condition_id
         JOIN parties p ON p.id = c.counterparty_id
         LEFT JOIN LATERAL (
           SELECT mm.* FROM matter_links l JOIN matters mm ON mm.id = l.matter_id
            WHERE l.target_type = 'condition' AND l.target_ref = c.id::text
              AND mm.merged_into_id IS NULL AND mm.status <> 'canceled'
            ORDER BY mm.id DESC LIMIT 1) m ON true
         LEFT JOIN staff os ON os.id = m.owner_staff_id
         LEFT JOIN LATERAL (
           SELECT st.department FROM staff st
            WHERE st.slack_user_id = m.requester_slack_id AND st.department IS NOT NULL
            LIMIT 1) rs ON true
         LEFT JOIN LATERAL (
           SELECT d.document_no
             FROM document_conditions dc
             JOIN documents d ON d.id = dc.document_id
             JOIN document_template_versions v ON v.id = d.template_version_id
             JOIN document_templates t ON t.id = v.template_id
            WHERE dc.condition_id = c.id AND d.status = 'issued'
              AND t.template_key IN ('purchase_order', 'intl_purchase_order')
            ORDER BY d.issued_at DESC NULLS LAST, d.id DESC LIMIT 1) po ON true
        WHERE c.direction = 'in' AND c.status = 'active' AND c.kind IN ('service', 'product')
          AND b.due BETWEEN $1::date - $3::int AND $1::date + $2::int
        ORDER BY b.due, b.condition_id, b.schedule_id`,
      [today, ahead, behind]);
    return (r.rows as any[]).map((x) => ({
      conditionId: Number(x.condition_id),
      scheduleId: x.schedule_id === null || x.schedule_id === undefined ? null : Number(x.schedule_id),
      due: dateStr(x.due)!, daysUntil: Number(x.days_until), item: String(x.item), party: String(x.party),
      matterId: x.matter_id ? Number(x.matter_id) : null, matterNo: str(x.matter_no),
      matterTitle: str(x.matter_title), requesterSlackId: str(x.requester_slack_id),
      requesterDepartment: str(x.requester_department), ownerSlackId: str(x.owner_slack_id),
      purchaseOrderNo: str(x.po_no)
    }));
  }
}
