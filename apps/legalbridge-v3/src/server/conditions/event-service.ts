import { inTransaction, type Transactable } from "../core/db.js";
import { dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 条件の実績（明細の数値）。
 *
 * これまで condition_events を書けるのは計算書の作成だけだった。製造数も
 * 検収も納品も、画面から記録できず、間違って入った数値を直す手段も無かった。
 *
 * 記録は消さない。取り消しは status を void にして残す。実績は「何がいくつ
 * あったか」の記録なので、消すと後から突き合わせられなくなる。
 *
 * 計算書から作られた実績（document_id を持つもの）はここでは触らない。
 * 触ると計算書の中身と実績が食い違う。直すなら計算書ごと差し替える。
 */

export type EventType =
  | "manufacturing" | "sales" | "sublicense_receipt"
  | "inspection" | "delivery" | "service_period" | "adjustment";

export const EVENT_TYPES: Array<{ value: EventType; label: string }> = [
  { value: "manufacturing", label: "製造" },
  { value: "sales", label: "売上" },
  { value: "sublicense_receipt", label: "再許諾の受領" },
  { value: "inspection", label: "検収" },
  { value: "delivery", label: "納品" },
  { value: "service_period", label: "役務の期間" },
  { value: "adjustment", label: "調整" }
];

export interface EventInput {
  eventType: EventType;
  occurredOn: string;
  period?: string | null;
  quantity?: number | null;
  sampleQuantity?: number | null;
  grossAmount?: number | null;
  deductions?: number | null;
  amount: number;
  note?: string | null;
}

export interface EventRow {
  id: number;
  eventType: string;
  occurredOn: string | null;
  period: string | null;
  quantity: number | null;
  sampleQuantity: number | null;
  grossAmount: number | null;
  deductions: number;
  amount: number;
  status: string;
  note: string | null;
  /** 計算書から作られた実績。画面からは直せない。 */
  documentId: number | null;
  documentNo: string | null;
  createdAt: string;
  createdBy: string;
}

export class ConditionEventService {
  constructor(private readonly database: Transactable) {}

  async list(conditionId: number): Promise<EventRow[]> {
    try {
      const r = await this.database.query(
        `SELECT e.id, e.event_type, e.occurred_on, e.period, e.quantity, e.sample_quantity,
                e.gross_amount, e.deductions, e.amount, e.status, e.note,
                e.document_id, d.document_no, e.created_at, e.created_by
           FROM condition_events e
           LEFT JOIN documents d ON d.id = e.document_id
          WHERE e.condition_id = $1
          ORDER BY e.occurred_on DESC, e.id DESC`, [conditionId]);
      return (r.rows as any[]).map((row) => ({
        id: Number(row.id),
        eventType: String(row.event_type),
        occurredOn: dateStr(row.occurred_on),
        period: str(row.period),
        quantity: num(row.quantity),
        sampleQuantity: num(row.sample_quantity),
        grossAmount: int(row.gross_amount),
        deductions: Number(row.deductions ?? 0),
        amount: Number(row.amount ?? 0),
        status: String(row.status),
        note: str(row.note),
        documentId: int(row.document_id),
        documentNo: str(row.document_no),
        createdAt: new Date(String(row.created_at)).toISOString(),
        createdBy: String(row.created_by)
      }));
    } catch (error) { throw translate(error); }
  }

  async add(conditionId: number, input: EventInput, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, status FROM conditions WHERE id = $1", [conditionId]);
        const condition = head.rows[0] as { id: number; status: string } | undefined;
        if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
        if (condition.status !== "active" && condition.status !== "draft") {
          // 差し替え済み・無効の版に実績を足すと、どの版の実績か分からなくなる。
          throw new DomainError("CONFLICT",
            condition.status === "superseded"
              ? "旧版には実績を足せません。最新版に記録してください"
              : "無効にした条件には実績を足せません");
        }

        const amount = Math.round(input.amount);
        const gross = input.grossAmount === null || input.grossAmount === undefined
          ? null : Math.round(input.grossAmount);
        const deductions = Math.round(input.deductions ?? 0);
        if (gross !== null && gross - deductions !== amount) {
          // 総額・控除・実額が合わない記録を残すと、あとで検算できない。
          throw new DomainError("VALIDATION",
            `総額 ${gross} − 控除 ${deductions} = ${gross - deductions} が実額 ${amount} と合いません`);
        }

        const inserted = await client.query(
          `INSERT INTO condition_events
             (condition_id, event_type, occurred_on, period, quantity, sample_quantity,
              gross_amount, deductions, amount, note, created_by)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [conditionId, input.eventType, input.occurredOn, str(input.period),
           input.quantity ?? null, input.sampleQuantity ?? null,
           gross, deductions, amount, str(input.note), actor]);
        const id = Number((inserted.rows[0] as { id: number }).id);

        await recordAudit(client, {
          actor, action: "condition.event_add", targetType: "condition", targetId: conditionId,
          detail: { eventId: id, eventType: input.eventType, occurredOn: input.occurredOn, amount }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /** 取り消し。行は残す。理由を必ず添える。 */
  async void(conditionId: number, eventId: number, reason: string, actor: string) {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "取り消しの理由は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const found = await client.query(
          `SELECT e.id, e.status, e.amount, e.document_id, d.document_no
             FROM condition_events e
             LEFT JOIN documents d ON d.id = e.document_id
            WHERE e.id = $1 AND e.condition_id = $2`, [eventId, conditionId]);
        const row = found.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `実績 ${eventId} が見つかりません`);
        if (row.status === "void") {
          throw new DomainError("CONFLICT", "すでに取り消されています");
        }
        if (row.document_id) {
          // 計算書の金額はこの実績から出ている。片方だけ消すと食い違う。
          throw new DomainError("CONFLICT",
            `この実績は計算書 ${row.document_no ?? `#${row.document_id}`} から作られています。` +
            "取り消すなら計算書ごと無効にしてください");
        }

        await client.query(
          "UPDATE condition_events SET status = 'void', note = $2 WHERE id = $1",
          [eventId, `取消：${why}`]);
        await recordAudit(client, {
          actor, action: "condition.event_void", targetType: "condition", targetId: conditionId,
          detail: { eventId, amount: Number(row.amount), reason: why }
        });
        return { voided: eventId };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 実績を発行済み文書に結びつける。検収書・計算書がどの実績から出たかは
   * この列（condition_events.document_id）にしか無く、書く処理が無かったため
   * 「この検収書は何回目の分か」が追えなかった。
   *
   * 文書は発行済みのものだけを受ける。下書きに結ぶと、下書きを捨てたときに
   * 実績だけが宙に浮く。
   */
  async linkDocument(
    conditionId: number, eventIds: number[], documentId: number, actor: string
  ): Promise<{ linked: number; documentNo: string | null }> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "結びつける実績がありません");
    try {
      return await inTransaction(this.database, async (client) => {
        const doc = await client.query(
          "SELECT id, document_no, status FROM documents WHERE id = $1", [documentId]);
        const document = doc.rows[0] as
          { document_no: string | null; status: string } | undefined;
        if (!document) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (document.status !== "issued") {
          throw new DomainError("CONFLICT", "発行済みの文書にだけ実績を結びつけられます");
        }

        const rows = await client.query(
          `SELECT id, status, document_id FROM condition_events
            WHERE id = ANY($1::bigint[]) AND condition_id = $2`, [ids, conditionId]);
        const found = rows.rows as Array<{ id: number; status: string; document_id: number | null }>;
        if (found.length !== ids.length) {
          throw new DomainError("NOT_FOUND", "この条件に無い実績が混ざっています");
        }
        const voided = found.filter((r) => r.status !== "active");
        if (voided.length) {
          throw new DomainError("CONFLICT",
            `取り消し済みの実績は結びつけられません（#${voided.map((r) => r.id).join("・")}）`);
        }
        const taken = found.filter((r) => r.document_id !== null && r.document_id !== documentId);
        if (taken.length) {
          throw new DomainError("CONFLICT",
            `すでに別の文書に結びついている実績があります（#${taken.map((r) => r.id).join("・")}）。` +
            "作り直すなら、先にその文書を無効にしてください");
        }

        const updated = await client.query(
          `UPDATE condition_events SET document_id = $3
            WHERE id = ANY($1::bigint[]) AND condition_id = $2 AND document_id IS NULL`,
          [ids, conditionId, documentId]);

        await recordAudit(client, {
          actor, action: "condition.link_document", targetType: "condition", targetId: conditionId,
          detail: { documentId, documentNo: document.document_no, eventIds: ids,
                    linked: updated.rowCount ?? 0 }
        });
        return { linked: updated.rowCount ?? 0, documentNo: document.document_no };
      });
    } catch (error) { throw translate(error); }
  }
}
