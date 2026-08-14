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

// 案件の canonical Slack スレッド（1案件=1スレッド）。既存の通知履歴に保存済みの
// slack_channel_id / slack_message_ts をアンカーとして再利用する（DBスキーマ変更なし）。
// 優先順位: ① intake の受付通知 → ② 有効な receipt を持つ最古の送信 → ③ 未接続。
export interface MatterSlackThreadAnchor {
  matterId: number;
  issueKey: string;
  channelId: string;
  rootMessageTs: string;
  recordedAt: string;
  // canonical 以外の root 数（修正前の実装で作られた独立メッセージ）。互換表示用。
  legacyRootCount: number;
}

// 案件に紐づく送信レコード（Slack API を叩かずに出せる履歴）。
export interface MatterSlackDeliveryRecord {
  issueKey: string;
  headline: string;
  outcome: NotificationHistoryOutcome;
  channelId: string | null;
  messageTs: string | null;
  recordedAt: string;
}

export interface SlackNotificationHistoryRepository {
  list(issueKeys: string[]): Promise<NotificationHistoryRecord[]>;
  append(entry: NotificationHistoryAppend): Promise<void>;
  // 案件履歴用の読取（重複判定用の list() とは用途を分離する）。
  findMatterThreadAnchor(matterId: number): Promise<MatterSlackThreadAnchor | null>;
  listMatterDeliveries(matterId: number): Promise<MatterSlackDeliveryRecord[]>;
}

// 有効な receipt（DMチャンネルID＋メッセージts）を持つ行だけをアンカー候補にする。
const VALID_RECEIPT_CONDITION = `
  outcome IN ('sent', 'acknowledged')
  AND slack_channel_id IS NOT NULL AND btrim(slack_channel_id) <> ''
  AND slack_message_ts IS NOT NULL AND slack_message_ts ~ '^[0-9]+\\.[0-9]+$'
`;

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

  async findMatterThreadAnchor(matterId: number): Promise<MatterSlackThreadAnchor | null> {
    // intake（受付通知）を最優先し、無ければ最古の有効送信を root とする。
    // legacy_root_count は canonical 以外の root 数（＝互換表示のための件数）。
    const result = await this.database.query(
      `WITH valid AS (
         SELECT issue_key, slack_channel_id, slack_message_ts, recorded_at, requester_status
           FROM lb_v2_slack_notification_history
          WHERE matter_id = $1 AND ${VALID_RECEIPT_CONDITION}
       ), ranked AS (
         SELECT *, (requester_status = 'intake') AS is_intake
           FROM valid
       )
       SELECT issue_key, slack_channel_id, slack_message_ts, recorded_at,
              (SELECT count(*) FROM valid) - 1 AS legacy_root_count
         FROM ranked
        ORDER BY is_intake DESC, recorded_at ASC
        LIMIT 1`,
      [matterId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      matterId,
      issueKey: row.issue_key,
      channelId: row.slack_channel_id,
      rootMessageTs: row.slack_message_ts,
      recordedAt: new Date(row.recorded_at).toISOString(),
      legacyRootCount: Math.max(0, Number(row.legacy_root_count ?? 0))
    };
  }

  async listMatterDeliveries(matterId: number): Promise<MatterSlackDeliveryRecord[]> {
    const result = await this.database.query(
      `SELECT issue_key, headline, outcome, slack_channel_id, slack_message_ts, recorded_at
         FROM lb_v2_slack_notification_history
        WHERE matter_id = $1
        ORDER BY recorded_at ASC`,
      [matterId]
    );
    return result.rows.map((row) => ({
      issueKey: row.issue_key,
      headline: row.headline ?? "",
      outcome: row.outcome,
      channelId: row.slack_channel_id ?? null,
      messageTs: row.slack_message_ts ?? null,
      recordedAt: new Date(row.recorded_at).toISOString()
    }));
  }
}

// テスト用の内訳行（append された全項目＋記録時刻）。案件履歴 API の検証に使う。
type MemoryHistoryRow = NotificationHistoryAppend & { recordedAt: string };

export class MemorySlackNotificationHistoryRepository
implements SlackNotificationHistoryRepository {
  // append 済みの全項目（matter_id / channel / ts を含む）。seed 行は list() 用。
  readonly rows: MemoryHistoryRow[] = [];

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
    const recordedAt = new Date().toISOString();
    this.records.push({
      issueKey: entry.issueKey,
      fingerprint: entry.fingerprint,
      outcome: entry.outcome,
      recordedAt
    });
    this.rows.push({ ...entry, recordedAt });
  }

  // テストから直接アンカー候補を用意するための投入口（append の重複判定を経由しない）。
  seedRow(row: NotificationHistoryAppend & { recordedAt?: string }) {
    this.rows.push({ ...row, recordedAt: row.recordedAt ?? new Date().toISOString() });
  }

  private validRows(matterId: number) {
    return this.rows.filter((row) =>
      row.matterId === matterId &&
      (row.outcome === "sent" || row.outcome === "acknowledged") &&
      typeof row.slackChannelId === "string" && row.slackChannelId.trim() !== "" &&
      typeof row.slackMessageTs === "string" && /^\d+\.\d+$/.test(row.slackMessageTs));
  }

  async findMatterThreadAnchor(matterId: number): Promise<MatterSlackThreadAnchor | null> {
    const valid = this.validRows(matterId)
      .slice()
      .sort((a, b) => {
        const intake = Number(b.requesterStatus === "intake") - Number(a.requesterStatus === "intake");
        return intake !== 0 ? intake : a.recordedAt.localeCompare(b.recordedAt);
      });
    const root = valid[0];
    if (!root) return null;
    return {
      matterId,
      issueKey: root.issueKey,
      channelId: root.slackChannelId as string,
      rootMessageTs: root.slackMessageTs as string,
      recordedAt: root.recordedAt,
      legacyRootCount: Math.max(0, valid.length - 1)
    };
  }

  async listMatterDeliveries(matterId: number): Promise<MatterSlackDeliveryRecord[]> {
    return this.rows
      .filter((row) => row.matterId === matterId)
      .slice()
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((row) => ({
        issueKey: row.issueKey,
        headline: row.headline,
        outcome: row.outcome,
        channelId: row.slackChannelId ?? null,
        messageTs: row.slackMessageTs ?? null,
        recordedAt: row.recordedAt
      }));
  }
}
