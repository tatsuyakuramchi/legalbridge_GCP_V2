import type { DatabasePool } from "../db/pool.js";

// CloudSign 署名依頼の履歴台帳（append＋status）。Gmail 送信履歴(5-1)と同型に、
// idempotency_key で二重送信を防ぎ、加えて cloud_sign_document_id を永続化して
// ステータス照会を後から可能にする。隔離テーブル lb_v2_cloudsign_requests(grant 022)。
// 既存業務テーブルには触れない。

export type CloudSignRequestStatus = string; // draft/sent/completed/canceled 等（正規化済みラベル）

export interface CloudSignRequestRecordInput {
  idempotencyKey: string;        // SHA-256(cloudsign:documentId:number/issueKey)
  documentId: number;
  cloudSignDocumentId: string;
  status: CloudSignRequestStatus;
  participantCount: number;
  recordedBy: string;
}

export interface CloudSignRequestRecord {
  idempotencyKey: string;
  documentId: number;
  cloudSignDocumentId: string;
  status: CloudSignRequestStatus;
  participantCount: number;
  recordedAt: string;
  recordedBy: string;
}

export interface CloudSignRequestRepository {
  findByKey(idempotencyKey: string): Promise<CloudSignRequestRecord | null>;
  // 依頼成立を記録し、記録済みレコードを返す（既存キーは既存をそのまま返す＝冪等）。
  record(entry: CloudSignRequestRecordInput): Promise<CloudSignRequestRecord>;
  // 締結状況の更新（fetchStatus 取得時に反映）。存在しなければ null。
  updateStatus(cloudSignDocumentId: string, status: CloudSignRequestStatus): Promise<CloudSignRequestRecord | null>;
  list(): Promise<CloudSignRequestRecord[]>;
}

const COLUMNS = `idempotency_key, document_id, cloud_sign_document_id, status,
  participant_count, recorded_at, recorded_by`;

function mapRow(row: Record<string, any>): CloudSignRequestRecord {
  return {
    idempotencyKey: row.idempotency_key,
    documentId: Number(row.document_id),
    cloudSignDocumentId: row.cloud_sign_document_id,
    status: row.status,
    participantCount: Number(row.participant_count),
    recordedAt: new Date(row.recorded_at).toISOString(),
    recordedBy: row.recorded_by
  };
}

export class PgCloudSignRequestRepository implements CloudSignRequestRepository {
  constructor(private readonly database: DatabasePool) {}

  async findByKey(idempotencyKey: string) {
    const result = await this.database.query(
      `SELECT ${COLUMNS} FROM lb_v2_cloudsign_requests WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async record(entry: CloudSignRequestRecordInput) {
    await this.database.query(
      `INSERT INTO lb_v2_cloudsign_requests (
         idempotency_key, document_id, cloud_sign_document_id, status, participant_count, recorded_by
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [entry.idempotencyKey, entry.documentId, entry.cloudSignDocumentId,
       entry.status, entry.participantCount, entry.recordedBy]
    );
    const record = await this.findByKey(entry.idempotencyKey);
    if (!record) throw new Error("cloudsign request failed to persist");
    return record;
  }

  async updateStatus(cloudSignDocumentId: string, status: CloudSignRequestStatus) {
    const result = await this.database.query(
      `UPDATE lb_v2_cloudsign_requests SET status = $2 WHERE cloud_sign_document_id = $1
       RETURNING ${COLUMNS}`,
      [cloudSignDocumentId, status]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async list() {
    const result = await this.database.query(
      `SELECT ${COLUMNS} FROM lb_v2_cloudsign_requests
        ORDER BY recorded_at DESC, id DESC LIMIT 200`
    );
    return result.rows.map(mapRow);
  }
}

export class MemoryCloudSignRequestRepository implements CloudSignRequestRepository {
  constructor(private readonly records: CloudSignRequestRecord[] = []) {}

  async findByKey(idempotencyKey: string) {
    return this.records.find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async record(entry: CloudSignRequestRecordInput) {
    const existing = this.records.find((r) => r.idempotencyKey === entry.idempotencyKey);
    if (existing) return existing;
    const record: CloudSignRequestRecord = {
      idempotencyKey: entry.idempotencyKey,
      documentId: entry.documentId,
      cloudSignDocumentId: entry.cloudSignDocumentId,
      status: entry.status,
      participantCount: entry.participantCount,
      recordedAt: new Date().toISOString(),
      recordedBy: entry.recordedBy
    };
    this.records.push(record);
    return record;
  }

  async updateStatus(cloudSignDocumentId: string, status: CloudSignRequestStatus) {
    const record = this.records.find((r) => r.cloudSignDocumentId === cloudSignDocumentId);
    if (!record) return null;
    record.status = status;
    return record;
  }

  async list() {
    return this.records.slice().reverse();
  }
}
