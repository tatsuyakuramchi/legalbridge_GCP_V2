import type { DatabasePool } from "../db/pool.js";

// Gmail 受信取込の登録台帳（append＋status）。閲覧/DLだけだった受信契約PDFを
// 「取込済み」として恒久記録する。隔離テーブル lb_v2_inbound_contracts（grant 020）に
// 保存し、既存業務テーブル(documents 等)には触れない。message+attachment を指紋化した
// idempotency_key を一意キーに、同一添付の再取込は多重化しない。

export type InboundContractStatus = "captured" | "linked" | "dismissed";

export interface InboundContractCapture {
  idempotencyKey: string;   // SHA-256(messageId:attachmentId)
  messageId: string;
  attachmentId: string;
  threadId: string | null;
  filename: string;
  fromAddress: string;
  subject: string;
  receivedAt: string | null;   // ISO文字列（メールの Date ヘッダ由来）
  capturedBy: string;
}

export interface InboundContractRecord {
  idempotencyKey: string;
  messageId: string;
  attachmentId: string;
  threadId: string | null;
  filename: string;
  fromAddress: string;
  subject: string;
  receivedAt: string | null;
  driveLink: string | null;
  status: InboundContractStatus;
  capturedAt: string;
  capturedBy: string;
}

export interface InboundContractRepository {
  findByKey(idempotencyKey: string): Promise<InboundContractRecord | null>;
  // 取込を記録し記録済みレコードを返す（既存キーは既存レコードをそのまま返す＝冪等）。
  capture(entry: InboundContractCapture): Promise<InboundContractRecord>;
  list(status?: InboundContractStatus): Promise<InboundContractRecord[]>;
  // status を更新（存在しなければ null）。captured→linked/dismissed の運用遷移用。
  updateStatus(idempotencyKey: string, status: InboundContractStatus): Promise<InboundContractRecord | null>;
}

const SELECT_COLUMNS = `idempotency_key, message_id, attachment_id, thread_id, filename,
  from_address, subject, received_at, drive_link, status, captured_at, captured_by`;

function mapRow(row: Record<string, any>): InboundContractRecord {
  return {
    idempotencyKey: row.idempotency_key,
    messageId: row.message_id,
    attachmentId: row.attachment_id,
    threadId: row.thread_id,
    filename: row.filename,
    fromAddress: row.from_address,
    subject: row.subject,
    receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
    driveLink: row.drive_link,
    status: row.status,
    capturedAt: new Date(row.captured_at).toISOString(),
    capturedBy: row.captured_by
  };
}

export class PgInboundContractRepository implements InboundContractRepository {
  constructor(private readonly database: DatabasePool) {}

  async findByKey(idempotencyKey: string) {
    const result = await this.database.query(
      `SELECT ${SELECT_COLUMNS} FROM lb_v2_inbound_contracts WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async capture(entry: InboundContractCapture) {
    await this.database.query(
      `INSERT INTO lb_v2_inbound_contracts (
         idempotency_key, message_id, attachment_id, thread_id, filename,
         from_address, subject, received_at, status, captured_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'captured',$9)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        entry.idempotencyKey, entry.messageId, entry.attachmentId, entry.threadId,
        entry.filename, entry.fromAddress, entry.subject, entry.receivedAt, entry.capturedBy
      ]
    );
    const record = await this.findByKey(entry.idempotencyKey);
    if (!record) throw new Error("inbound contract capture failed to persist");
    return record;
  }

  async list(status?: InboundContractStatus) {
    const result = await this.database.query(
      `SELECT ${SELECT_COLUMNS} FROM lb_v2_inbound_contracts
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY captured_at DESC, id DESC
        LIMIT 200`,
      [status ?? null]
    );
    return result.rows.map(mapRow);
  }

  async updateStatus(idempotencyKey: string, status: InboundContractStatus) {
    const result = await this.database.query(
      `UPDATE lb_v2_inbound_contracts SET status = $2 WHERE idempotency_key = $1
       RETURNING ${SELECT_COLUMNS}`,
      [idempotencyKey, status]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

export class MemoryInboundContractRepository implements InboundContractRepository {
  constructor(private readonly records: InboundContractRecord[] = []) {}

  async findByKey(idempotencyKey: string) {
    return this.records.find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async capture(entry: InboundContractCapture) {
    const existing = this.records.find((r) => r.idempotencyKey === entry.idempotencyKey);
    if (existing) return existing;
    const record: InboundContractRecord = {
      idempotencyKey: entry.idempotencyKey,
      messageId: entry.messageId,
      attachmentId: entry.attachmentId,
      threadId: entry.threadId,
      filename: entry.filename,
      fromAddress: entry.fromAddress,
      subject: entry.subject,
      receivedAt: entry.receivedAt,
      driveLink: null,
      status: "captured",
      capturedAt: new Date().toISOString(),
      capturedBy: entry.capturedBy
    };
    this.records.push(record);
    return record;
  }

  async list(status?: InboundContractStatus) {
    return this.records
      .filter((r) => !status || r.status === status)
      .slice()
      .reverse();
  }

  async updateStatus(idempotencyKey: string, status: InboundContractStatus) {
    const record = this.records.find((r) => r.idempotencyKey === idempotencyKey);
    if (!record) return null;
    record.status = status;
    return record;
  }
}
