import type { DatabasePool } from "../db/pool.js";

// Gmail 送信の冪等強制のための append 専用履歴（Slack 001 相当）。
// idempotencyKey（SHA-256指紋）を一意キーに、送信成功を1件だけ記録する。
// 再POSTでは hasSent() が true を返し、実送信をスキップして冪等を保証する。

export interface GmailSendHistoryEntry {
  idempotencyKey: string;   // SHA-256指紋（buildFinalizeNotification が算出）
  documentId: number;
  recipient: string;
  messageId: string;
  threadId: string | null;
  recordedBy: string;
}

export interface GmailSendHistoryRecord {
  idempotencyKey: string;
  messageId: string;
  threadId: string | null;
  recordedAt: string;
}

export interface GmailSendHistoryRepository {
  // 既に送信済みなら受領情報を返す（未送信は null）。
  findByKey(idempotencyKey: string): Promise<GmailSendHistoryRecord | null>;
  // 送信成功を記録する。既存キーは ON CONFLICT DO NOTHING（多重記録しない）。
  record(entry: GmailSendHistoryEntry): Promise<void>;
}

export class PgGmailSendHistoryRepository implements GmailSendHistoryRepository {
  constructor(private readonly database: DatabasePool) {}

  async findByKey(idempotencyKey: string) {
    const result = await this.database.query(
      `SELECT idempotency_key, gmail_message_id, gmail_thread_id, recorded_at
         FROM lb_v2_gmail_send_history
        WHERE idempotency_key = $1
        LIMIT 1`,
      [idempotencyKey]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      idempotencyKey: row.idempotency_key,
      messageId: row.gmail_message_id,
      threadId: row.gmail_thread_id,
      recordedAt: new Date(row.recorded_at).toISOString()
    };
  }

  async record(entry: GmailSendHistoryEntry) {
    await this.database.query(
      `INSERT INTO lb_v2_gmail_send_history (
         idempotency_key, document_id, recipient, gmail_message_id, gmail_thread_id, recorded_by
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        entry.idempotencyKey,
        entry.documentId,
        entry.recipient,
        entry.messageId,
        entry.threadId,
        entry.recordedBy
      ]
    );
  }
}

export class MemoryGmailSendHistoryRepository implements GmailSendHistoryRepository {
  constructor(private readonly records: GmailSendHistoryRecord[] = []) {}

  async findByKey(idempotencyKey: string) {
    return this.records.find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async record(entry: GmailSendHistoryEntry) {
    if (this.records.some((r) => r.idempotencyKey === entry.idempotencyKey)) return;
    this.records.push({
      idempotencyKey: entry.idempotencyKey,
      messageId: entry.messageId,
      threadId: entry.threadId,
      recordedAt: new Date().toISOString()
    });
  }
}
