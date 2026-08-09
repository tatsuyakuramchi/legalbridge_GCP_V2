import type { DatabasePool } from "../db/pool.js";
import { MatterWriteError } from "./write-repository.js";

// 案件の文書送信履歴（document_sends・append専用）。grant 027 で SELECT/INSERT。
// email/slack/drive/manual のチャネル別に送信実績を1行ずつ残す。

export const SEND_CHANNELS = ["email", "slack", "drive", "manual"] as const;
export type SendChannel = typeof SEND_CHANNELS[number];
export const SEND_STATUSES = ["sent", "failed", "queued"] as const;
export type SendStatus = typeof SEND_STATUSES[number];

export interface SendRecordInput {
  documentId: number;
  channel: SendChannel;
  recipient?: string | null;
  status: SendStatus;
  subject?: string | null;
  bodyPreview?: string | null;
  messageId?: string | null;
  sentBy?: string | null;
  remarks?: string | null;
}

export interface SendRecord {
  id: number;
  documentId: number;
  channel: string;
  recipient: string | null;
  status: string;
  subject: string | null;
  messageId: string | null;
  sentBy: string | null;
  remarks: string | null;
  sentAt: string;
}

export interface MatterSendRepository {
  list(matterId: number): Promise<SendRecord[]>;
  record(matterId: number, input: SendRecordInput): Promise<SendRecord>;
}

function mapRow(row: Record<string, any>): SendRecord {
  return {
    id: Number(row.id), documentId: Number(row.document_id), channel: row.channel,
    recipient: row.recipient, status: row.status, subject: row.subject,
    messageId: row.message_id, sentBy: row.sent_by, remarks: row.remarks,
    sentAt: new Date(row.sent_at).toISOString()
  };
}

function translate(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code === "42501") {
    throw new MatterWriteError("MATTER_SEND_GRANT_MISSING", "document_sends への権限がありません（grant 027 未適用）");
  }
  if (code === "23503") {
    throw new MatterWriteError("MATTER_REFERENCE_INVALID", "文書または案件が存在しません");
  }
  throw error as Error;
}

export class PgMatterSendRepository implements MatterSendRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(matterId: number) {
    const result = await this.database.query(
      `SELECT id, document_id, channel, recipient, status, subject, message_id, sent_by, remarks, sent_at
         FROM document_sends WHERE matter_id = $1 ORDER BY sent_at DESC, id DESC LIMIT 200`,
      [matterId]
    );
    return result.rows.map(mapRow);
  }

  async record(matterId: number, input: SendRecordInput) {
    try {
      const result = await this.database.query(
        `INSERT INTO document_sends
           (document_id, matter_id, channel, recipient, status, subject, body_preview, message_id, sent_by, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, document_id, channel, recipient, status, subject, message_id, sent_by, remarks, sent_at`,
        [input.documentId, matterId, input.channel, input.recipient ?? null, input.status,
         input.subject ?? null, input.bodyPreview ?? null, input.messageId ?? null,
         input.sentBy ?? null, input.remarks ?? null]
      );
      await this.database.query(`UPDATE matters SET updated_at = now() WHERE id = $1`, [matterId]);
      return mapRow(result.rows[0]);
    } catch (error) {
      return translate(error);
    }
  }
}

export class MemoryMatterSendRepository implements MatterSendRepository {
  private seq = 0;
  constructor(private readonly records: Array<SendRecord & { matterId: number }> = []) {}

  async list(matterId: number) {
    return this.records.filter((r) => r.matterId === matterId)
      .slice().reverse().map(({ matterId: _m, ...rest }) => rest);
  }

  async record(matterId: number, input: SendRecordInput) {
    const record: SendRecord & { matterId: number } = {
      matterId, id: ++this.seq, documentId: input.documentId, channel: input.channel,
      recipient: input.recipient ?? null, status: input.status, subject: input.subject ?? null,
      messageId: input.messageId ?? null, sentBy: input.sentBy ?? null, remarks: input.remarks ?? null,
      sentAt: new Date().toISOString()
    };
    this.records.push(record);
    const { matterId: _m, ...rest } = record;
    return rest;
  }
}
