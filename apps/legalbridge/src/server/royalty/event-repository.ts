import type { DatabasePool } from "../db/pool.js";

// ロイヤリティ消化イベント（condition_events, event_type='royalty_calc'）の追記。
// V1 `conditionSync.syncRoyaltyCalcEvent` の INSERT 列に倣う。金額は呼び出し側
// （ルート）がサーバ再計算した calculateFee の結果を渡す（フロント値は信用しない）。
//
// スキーマ制約（0063/0064）：
//   - condition_line_id NOT NULL / FK
//   - event_no NOT NULL, UNIQUE(condition_line_id, event_no)
//   - event_type CHECK in (inspection, royalty_calc, payment)
//   - occurred_at NOT NULL
//   - amount_ex_tax NOT NULL DEFAULT 0
//   - CHECK ce_document_pairing: royalty_calc は document_id NOT NULL 必須
// DELETE は行わない（論理取消は voided_at 運用・別スライス）。

export interface RoyaltyCalcEventInput {
  conditionLineId: number;
  documentId: number;              // 確定済み計算書 document（CHECK 制約で必須）
  period?: string | null;          // YYYY-MM
  backlogIssueKey?: string | null;
  amountExTax: number;             // = calculateFee().actual_ex_tax（サーバ再計算値）
  mgConsumedThisTime?: number;     // MG floor 化後は常に 0
  agConsumedThisTime?: number;     // = calculateFee().ag_offset_this_time
}

export interface SavedRoyaltyCalcEvent {
  id: number;
  conditionLineId: number;
  eventNo: number;
  documentId: number;
  amountExTax: number;
  period: string | null;
}

export interface RoyaltyEventRepository {
  appendRoyaltyCalcEvent(input: RoyaltyCalcEventInput): Promise<SavedRoyaltyCalcEvent>;
}

export class RoyaltyEventReferenceError extends Error {}
export class RoyaltyEventConflictError extends Error {
  constructor() {
    super("royalty event changed before it could be saved");
  }
}

export class PgRoyaltyEventRepository implements RoyaltyEventRepository {
  constructor(private readonly database: DatabasePool) {}

  async appendRoyaltyCalcEvent(input: RoyaltyCalcEventInput) {
    if (!input.documentId) {
      throw new RoyaltyEventReferenceError("document is required for a royalty_calc event");
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");

      const line = await client.query(
        "SELECT id FROM condition_lines WHERE id = $1 FOR UPDATE",
        [input.conditionLineId]
      );
      if (!line.rows[0]) throw new RoyaltyEventReferenceError("condition line not found");

      const document = await client.query(
        "SELECT id FROM documents WHERE id = $1",
        [input.documentId]
      );
      if (!document.rows[0]) throw new RoyaltyEventReferenceError("document not found");

      const nextNo = await client.query(
        "SELECT COALESCE(MAX(event_no), 0) + 1 AS event_no FROM condition_events WHERE condition_line_id = $1",
        [input.conditionLineId]
      );
      const eventNo = Number(nextNo.rows[0]?.event_no ?? 1);

      const inserted = await client.query(
        `INSERT INTO condition_events (
           condition_line_id, event_no, event_type, document_id, backlog_issue_key,
           occurred_at, period, amount_ex_tax,
           mg_consumed_this_time, ag_consumed_this_time, source_royalty_calculation_id
         ) VALUES (
           $1, $2, 'royalty_calc', $3, $4,
           CURRENT_TIMESTAMP, $5, $6,
           $7, $8, NULL
         )
         RETURNING id`,
        [
          input.conditionLineId,
          eventNo,
          input.documentId,
          input.backlogIssueKey ?? null,
          input.period ?? null,
          input.amountExTax,
          input.mgConsumedThisTime ?? 0,
          input.agConsumedThisTime ?? 0
        ]
      );

      await client.query("COMMIT");
      return {
        id: Number(inserted.rows[0].id),
        conditionLineId: input.conditionLineId,
        eventNo,
        documentId: input.documentId,
        amountExTax: input.amountExTax,
        period: input.period ?? null
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new RoyaltyEventConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export class MemoryRoyaltyEventRepository implements RoyaltyEventRepository {
  private sequence = 1;
  readonly events: SavedRoyaltyCalcEvent[] = [];

  constructor(
    private readonly conditionLineIds = new Set([1]),
    private readonly documentIds = new Set([10])
  ) {}

  async appendRoyaltyCalcEvent(input: RoyaltyCalcEventInput) {
    if (!input.documentId) {
      throw new RoyaltyEventReferenceError("document is required for a royalty_calc event");
    }
    if (!this.conditionLineIds.has(input.conditionLineId)) {
      throw new RoyaltyEventReferenceError("condition line not found");
    }
    if (!this.documentIds.has(input.documentId)) {
      throw new RoyaltyEventReferenceError("document not found");
    }
    const eventNo =
      this.events.filter((event) => event.conditionLineId === input.conditionLineId).length + 1;
    const saved: SavedRoyaltyCalcEvent = {
      id: this.sequence,
      conditionLineId: input.conditionLineId,
      eventNo,
      documentId: input.documentId,
      amountExTax: input.amountExTax,
      period: input.period ?? null
    };
    this.sequence += 1;
    this.events.push(saved);
    return saved;
  }
}
