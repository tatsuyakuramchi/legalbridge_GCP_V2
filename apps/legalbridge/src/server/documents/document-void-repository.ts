import type { PoolClient } from "pg";
import type { DatabasePool } from "../db/pool.js";
import type { DocumentVoidInput } from "./document-void-schema.js";

// 発行文書の void（無効化・Phase 10-2）。V1（services/worker/server.ts の
// /api/documents/:id/void）と同じ挙動を、V2 の guarded-write／隔離台帳の作法で移植する：
//   1. documents を lifecycle_status='voided'・is_primary=FALSE に更新（既 void はスキップ）。
//   2. 紐づく有効実績 condition_events を voided_at/void_reason で取消（残高復元）。
//   3. 監査台帳 lb_v2_document_void_ledger（grant 033）へ記録。
// すべて同一トランザクション。権限未整備(42501)は FORBIDDEN_DB として 503 に橋渡しする。

export interface DocumentVoidResult {
  documentId: number;
  documentNumber: string | null;
  issueKey: string | null;
  alreadyVoided: boolean;
  voidedEvents: number;
  affectedLines: number[];
}

export interface DocumentVoidRepository {
  void(documentId: number, input: DocumentVoidInput, actor: string): Promise<DocumentVoidResult>;
}

export class DocumentVoidError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DocumentVoidError";
  }
}

export class PgDocumentVoidRepository implements DocumentVoidRepository {
  constructor(private readonly database: DatabasePool) {}

  async void(documentId: number, input: DocumentVoidInput, actor: string): Promise<DocumentVoidResult> {
    const reason = input.reason?.trim() || null;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const doc = await lockDocument(client, documentId);
      if (!doc) {
        await client.query("ROLLBACK");
        throw new DocumentVoidError("文書が見つかりません", "DOCUMENT_VOID_NOT_FOUND");
      }
      // 既に void 済みなら副作用なしで返す（べき等）。
      if (String(doc.lifecycle_status) === "voided") {
        await client.query("ROLLBACK");
        return {
          documentId, documentNumber: doc.document_number ?? null, issueKey: doc.issue_key ?? null,
          alreadyVoided: true, voidedEvents: 0, affectedLines: []
        };
      }

      await client.query(
        `UPDATE documents SET lifecycle_status = 'voided', is_primary = FALSE
          WHERE id = $1 AND lifecycle_status <> 'voided'`,
        [documentId]
      );

      const events = await client.query(
        `UPDATE condition_events
            SET voided_at = now(), void_reason = $2
          WHERE document_id = $1 AND voided_at IS NULL
          RETURNING id, condition_line_id`,
        [documentId, reason]
      );
      const voidedEvents = events.rowCount ?? 0;
      const affectedLines = [...new Set(events.rows
        .map((r) => Number(r.condition_line_id))
        .filter((n) => Number.isFinite(n)))];

      await client.query(
        `INSERT INTO lb_v2_document_void_ledger
           (document_id, document_number, reason, voided_events, voided_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [documentId, doc.document_number ?? null, reason, voidedEvents, actor]
      );

      await client.query("COMMIT");
      return {
        documentId, documentNumber: doc.document_number ?? null, issueKey: doc.issue_key ?? null,
        alreadyVoided: false, voidedEvents, affectedLines
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if ((error as { code?: string })?.code === "42501") {
        throw new DocumentVoidError("文書 void の権限が付与されていません", "DOCUMENT_VOID_FORBIDDEN_DB");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockDocument(client: PoolClient, documentId: number) {
  const result = await client.query(
    `SELECT id, document_number, issue_key, lifecycle_status
       FROM documents WHERE id = $1 FOR UPDATE`,
    [documentId]
  );
  return result.rows[0] as
    | { id: number; document_number: string | null; issue_key: string | null; lifecycle_status: string | null }
    | undefined;
}

// メモリ実装（テスト用）。documents/condition_events を簡易モデル化。
export interface MemoryVoidDoc {
  id: number;
  documentNumber: string | null;
  issueKey: string | null;
  lifecycleStatus: string;
}
export interface MemoryVoidEvent {
  id: number;
  documentId: number;
  conditionLineId: number;
  voidedAt: string | null;
  voidReason: string | null;
}

export class MemoryDocumentVoidRepository implements DocumentVoidRepository {
  readonly ledger: DocumentVoidResult[] = [];
  constructor(
    private readonly docs: MemoryVoidDoc[] = [],
    private readonly events: MemoryVoidEvent[] = [],
    private readonly forbidden = false
  ) {}

  async void(documentId: number, input: DocumentVoidInput, _actor: string): Promise<DocumentVoidResult> {
    if (this.forbidden) throw new DocumentVoidError("文書 void の権限が付与されていません", "DOCUMENT_VOID_FORBIDDEN_DB");
    const doc = this.docs.find((d) => d.id === documentId);
    if (!doc) throw new DocumentVoidError("文書が見つかりません", "DOCUMENT_VOID_NOT_FOUND");
    if (doc.lifecycleStatus === "voided") {
      return { documentId, documentNumber: doc.documentNumber, issueKey: doc.issueKey, alreadyVoided: true, voidedEvents: 0, affectedLines: [] };
    }
    doc.lifecycleStatus = "voided";
    const reason = input.reason?.trim() || null;
    const affected = this.events.filter((e) => e.documentId === documentId && e.voidedAt === null);
    for (const e of affected) { e.voidedAt = new Date().toISOString(); e.voidReason = reason; }
    const affectedLines = [...new Set(affected.map((e) => e.conditionLineId))];
    const result = { documentId, documentNumber: doc.documentNumber, issueKey: doc.issueKey, alreadyVoided: false, voidedEvents: affected.length, affectedLines };
    this.ledger.push(result);
    return result;
  }
}
