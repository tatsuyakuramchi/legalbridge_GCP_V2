import type { DatabasePool } from "../db/pool.js";
import type { DeliveryCandidate, ContractCandidate } from "./daily-checks-engine.js";

// daily-checks の候補読取と送信済み台帳（lb_v2_job_alert_ledger）への記録（Phase 9-1b/9-2）。
// 本番の業務テーブルは更新しない。重複抑止は台帳の最新 alert_date を候補の lastAlertAt/
// lastRenewalAlertAt として渡し、純関数エンジン（shouldAlertToday）で判定する。
// 権限/テーブル未整備（42501/42P01/42703）は空配列に縮退し、ジョブ全体は失敗させない。

export interface AlertLedgerEntry {
  kind: string;
  refType: "condition_line" | "document";
  refId: number;
  alertDate: string;                 // YYYY-MM-DD
  detail?: Record<string, unknown>;
}

export interface DailyChecksRepository {
  loadDeliveryCandidates(todayYmd: string): Promise<DeliveryCandidate[]>;
  loadContractCandidates(todayYmd: string): Promise<ContractCandidate[]>;
  recordAlerts(entries: AlertLedgerEntry[]): Promise<number>;
}

function degradable(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "42501" || code === "42P01" || code === "42703";
}

export class PgDailyChecksRepository implements DailyChecksRepository {
  constructor(private readonly database: DatabasePool) {}

  async loadDeliveryCandidates(todayYmd: string): Promise<DeliveryCandidate[]> {
    try {
      const r = await this.database.query(
        `SELECT cl.id AS line_item_id,
                cl.condition_name AS item_name,
                to_char(cl.delivery_date, 'YYYY-MM-DD') AS delivery_date,
                doc.backlog_issue_key AS backlog_issue_key,
                EXISTS (
                  SELECT 1 FROM condition_line_status_v s
                   WHERE s.id = cl.id AND s.status = 'fulfilled'
                ) AS fulfilled,
                (SELECT to_char(max(l.alert_date), 'YYYY-MM-DD')
                   FROM lb_v2_job_alert_ledger l
                  WHERE l.ref_type = 'condition_line' AND l.ref_id = cl.id) AS last_alert_at
           FROM condition_lines cl
           JOIN documents doc
             ON doc.id = cl.capability_id AND doc.record_type = 'purchase_order'
          WHERE cl.legacy_role = 'cli'
            AND cl.delivery_date IS NOT NULL
            AND cl.delivery_date <= ($1::date + 7)`,
        [todayYmd]
      );
      return r.rows.map((row) => ({
        lineItemId: Number(row.line_item_id),
        itemName: String(row.item_name ?? ""),
        deliveryDate: row.delivery_date == null ? null : String(row.delivery_date),
        backlogIssueKey: row.backlog_issue_key == null ? null : String(row.backlog_issue_key),
        lastAlertAt: row.last_alert_at == null ? null : String(row.last_alert_at),
        fulfilled: Boolean(row.fulfilled)
      }));
    } catch (error) {
      if (degradable(error)) return [];
      throw error;
    }
  }

  async loadContractCandidates(_todayYmd: string): Promise<ContractCandidate[]> {
    try {
      const r = await this.database.query(
        `SELECT d.id,
                d.document_number,
                d.contract_title,
                to_char(d.expiration_date, 'YYYY-MM-DD') AS expiration_date,
                d.auto_renewal,
                d.renewal_notice_months,
                d.alert_lead_months,
                (SELECT to_char(max(l.alert_date), 'YYYY-MM-DD')
                   FROM lb_v2_job_alert_ledger l
                  WHERE l.ref_type = 'document' AND l.ref_id = d.id AND l.kind = 'contract_renewal'
                ) AS last_renewal_alert_at
           FROM documents d
          WHERE d.expiration_date IS NOT NULL
            AND d.auto_renewal = TRUE
            AND d.renewal_notice_months IS NOT NULL
            AND d.alert_lead_months IS NOT NULL
            AND CURRENT_DATE <= d.expiration_date`
      );
      return r.rows.map((row) => ({
        id: Number(row.id),
        documentNumber: row.document_number == null ? null : String(row.document_number),
        contractTitle: row.contract_title == null ? null : String(row.contract_title),
        expirationDate: String(row.expiration_date),
        autoRenewal: Boolean(row.auto_renewal),
        renewalNoticeMonths: row.renewal_notice_months == null ? null : Number(row.renewal_notice_months),
        alertLeadMonths: row.alert_lead_months == null ? null : Number(row.alert_lead_months),
        lastRenewalAlertAt: row.last_renewal_alert_at == null ? null : String(row.last_renewal_alert_at)
      }));
    } catch (error) {
      if (degradable(error)) return [];
      throw error;
    }
  }

  async recordAlerts(entries: AlertLedgerEntry[]): Promise<number> {
    if (!entries.length) return 0;
    let recorded = 0;
    for (const e of entries) {
      const r = await this.database.query(
        `INSERT INTO lb_v2_job_alert_ledger (kind, ref_type, ref_id, alert_date, detail)
         VALUES ($1, $2, $3, $4::date, $5::jsonb)
         ON CONFLICT (kind, ref_type, ref_id, alert_date) DO NOTHING`,
        [e.kind, e.refType, e.refId, e.alertDate, JSON.stringify(e.detail ?? {})]
      );
      recorded += r.rowCount ?? 0;
    }
    return recorded;
  }
}

export class MemoryDailyChecksRepository implements DailyChecksRepository {
  readonly ledger: AlertLedgerEntry[] = [];
  constructor(
    private readonly delivery: DeliveryCandidate[] = [],
    private readonly contracts: ContractCandidate[] = []
  ) {}

  async loadDeliveryCandidates() { return this.delivery; }
  async loadContractCandidates() { return this.contracts; }
  async recordAlerts(entries: AlertLedgerEntry[]) {
    let recorded = 0;
    for (const e of entries) {
      const dup = this.ledger.some((x) => x.kind === e.kind && x.refType === e.refType && x.refId === e.refId && x.alertDate === e.alertDate);
      if (!dup) { this.ledger.push(e); recorded++; }
    }
    return recorded;
  }
}
