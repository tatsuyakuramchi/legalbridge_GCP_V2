import type { DatabasePool } from "../db/pool.js";

export type SlackApprovalDecision = "approved" | "revoked";

export interface SlackApprovalRecord {
  matterId: number;
  issueKey: string;
  fingerprint: string;
  decision: SlackApprovalDecision;
  recordedAt: string;
  recordedBy: string;
}

export interface SlackApprovalAppend {
  matterId: number;
  issueKey: string;
  fingerprint: string;
  decision: SlackApprovalDecision;
  recordedBy: string;
}

export interface SlackNotificationApprovalRepository {
  listLatest(issueKeys: string[]): Promise<SlackApprovalRecord[]>;
  append(entry: SlackApprovalAppend): Promise<void>;
}

export class PgSlackNotificationApprovalRepository
implements SlackNotificationApprovalRepository {
  constructor(private readonly database: DatabasePool) {}

  async listLatest(issueKeys: string[]) {
    if (!issueKeys.length) return [];
    const result = await this.database.query(
      `SELECT DISTINCT ON (issue_key)
              matter_id, issue_key, fingerprint, decision, recorded_at, recorded_by
         FROM lb_v2_slack_notification_approvals
        WHERE issue_key = ANY($1::text[])
        ORDER BY issue_key, recorded_at DESC, id DESC`,
      [issueKeys]
    );
    return result.rows.map((row) => ({
      matterId: Number(row.matter_id),
      issueKey: row.issue_key,
      fingerprint: row.fingerprint,
      decision: row.decision,
      recordedAt: new Date(row.recorded_at).toISOString(),
      recordedBy: row.recorded_by
    }));
  }

  async append(entry: SlackApprovalAppend) {
    await this.database.query(
      `INSERT INTO lb_v2_slack_notification_approvals (
         matter_id, issue_key, fingerprint, decision, recorded_by
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        entry.matterId,
        entry.issueKey,
        entry.fingerprint,
        entry.decision,
        entry.recordedBy
      ]
    );
  }
}

export class MemorySlackNotificationApprovalRepository
implements SlackNotificationApprovalRepository {
  private sequence = 0;
  private readonly records: Array<SlackApprovalRecord & { sequence: number }>;

  constructor(records: SlackApprovalRecord[] = []) {
    this.records = records.map((record) => ({
      ...record,
      sequence: ++this.sequence
    }));
  }

  async listLatest(issueKeys: string[]) {
    const keys = new Set(issueKeys);
    const latest = new Map<string, SlackApprovalRecord & { sequence: number }>();
    for (const record of this.records) {
      if (!keys.has(record.issueKey)) continue;
      const current = latest.get(record.issueKey);
      if (!current ||
          record.recordedAt > current.recordedAt ||
          (record.recordedAt === current.recordedAt && record.sequence > current.sequence)) {
        latest.set(record.issueKey, record);
      }
    }
    return [...latest.values()].map(({ sequence: _sequence, ...record }) => record);
  }

  async append(entry: SlackApprovalAppend) {
    this.records.push({
      ...entry,
      recordedAt: new Date().toISOString(),
      sequence: ++this.sequence
    });
  }
}
