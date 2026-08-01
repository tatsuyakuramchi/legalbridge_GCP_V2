import type { DatabasePool } from "../db/pool.js";
import type {
  NotificationHistoryRecord,
  NotificationHistoryOutcome
} from "./slack-deduplication.js";
import type { RequesterStatus } from "./slack-ux.js";

export interface NotificationHistoryAppend {
  matterId: number;
  issueKey: string;
  fingerprint: string;
  requesterStatus: RequesterStatus;
  outcome: NotificationHistoryOutcome;
  headline: string;
  triggerDetail?: string | null;
  slackChannelId?: string | null;
  slackMessageTs?: string | null;
  recordedBy: string;
}

export interface SlackNotificationHistoryRepository {
  list(issueKeys: string[]): Promise<NotificationHistoryRecord[]>;
  append(entry: NotificationHistoryAppend): Promise<void>;
}

export class PgSlackNotificationHistoryRepository
implements SlackNotificationHistoryRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(issueKeys: string[]) {
    if (!issueKeys.length) return [];
    const result = await this.database.query(
      `SELECT issue_key, fingerprint, outcome, recorded_at
         FROM lb_v2_slack_notification_history
        WHERE issue_key = ANY($1::text[])
          AND outcome IN ('sent', 'acknowledged')
        ORDER BY recorded_at DESC`,
      [issueKeys]
    );
    return result.rows.map((row) => ({
      issueKey: row.issue_key,
      fingerprint: row.fingerprint,
      outcome: row.outcome,
      recordedAt: new Date(row.recorded_at).toISOString()
    }));
  }

  async append(entry: NotificationHistoryAppend) {
    await this.database.query(
      `INSERT INTO lb_v2_slack_notification_history (
         matter_id, issue_key, fingerprint, requester_status, outcome,
         headline, trigger_detail, slack_channel_id, slack_message_ts, recorded_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (issue_key, fingerprint)
         WHERE outcome IN ('sent', 'acknowledged')
       DO NOTHING`,
      [
        entry.matterId,
        entry.issueKey,
        entry.fingerprint,
        entry.requesterStatus,
        entry.outcome,
        entry.headline,
        entry.triggerDetail ?? null,
        entry.slackChannelId ?? null,
        entry.slackMessageTs ?? null,
        entry.recordedBy
      ]
    );
  }
}

export class MemorySlackNotificationHistoryRepository
implements SlackNotificationHistoryRepository {
  constructor(private readonly records: NotificationHistoryRecord[] = []) {}

  async list(issueKeys: string[]) {
    const keys = new Set(issueKeys);
    return this.records.filter((record) => keys.has(record.issueKey));
  }

  async append(entry: NotificationHistoryAppend) {
    const delivered = entry.outcome === "sent" || entry.outcome === "acknowledged";
    const duplicate = delivered && this.records.some((record) =>
      record.issueKey === entry.issueKey &&
      record.fingerprint === entry.fingerprint &&
      (record.outcome === "sent" || record.outcome === "acknowledged")
    );
    if (duplicate) return;
    this.records.push({
      issueKey: entry.issueKey,
      fingerprint: entry.fingerprint,
      outcome: entry.outcome,
      recordedAt: new Date().toISOString()
    });
  }
}
