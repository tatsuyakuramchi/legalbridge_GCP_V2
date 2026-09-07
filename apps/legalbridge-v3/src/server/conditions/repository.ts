import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import type {
  ConditionDetail, ConditionScope, ConditionSummary, Direction, ScopeType
} from "../core/model.js";

const SUMMARY_COLUMNS = `
  c.id, c.condition_no, c.direction, c.kind, c.name, c.currency, c.pricing_model,
  c.rate_ppm, c.flat_amount, c.mg_amount, c.ag_amount, c.term_start, c.term_end, c.status,
  p.id AS party_id, p.name AS party_name, p.kind AS party_kind,
  w.id AS work_id, w.work_code, w.title AS work_title`;

const SUMMARY_JOINS = `
  FROM conditions c
  LEFT JOIN parties p ON p.id = c.counterparty_id
  LEFT JOIN works   w ON w.id = c.work_id`;

function mapSummary(row: Record<string, any>): ConditionSummary {
  return {
    id: Number(row.id),
    conditionNo: str(row.condition_no),
    direction: row.direction as Direction,
    kind: row.kind,
    name: String(row.name ?? ""),
    counterparty: row.party_id
      ? { id: Number(row.party_id), name: String(row.party_name ?? ""), kind: row.party_kind }
      : null,
    work: row.work_id
      ? { id: Number(row.work_id), workCode: str(row.work_code), title: String(row.work_title ?? "") }
      : null,
    currency: String(row.currency ?? "JPY"),
    pricingModel: row.pricing_model,
    ratePpm: int(row.rate_ppm),
    flatAmount: int(row.flat_amount),
    mgAmount: int(row.mg_amount),
    agAmount: int(row.ag_amount),
    termStart: dateStr(row.term_start),
    termEnd: dateStr(row.term_end),
    status: row.status
  };
}

export interface ConditionListQuery {
  keyword?: string;
  direction?: Direction;
  kind?: string;
  workId?: number;
  matterId?: number;
  limit?: number;
}

export class ConditionRepository {
  constructor(private readonly database: Transactable) {}

  async list(query: ConditionListQuery = {}): Promise<ConditionSummary[]> {
    const where: string[] = ["c.status <> 'void'"];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace("$?", `$${params.length}`)); };

    if (query.keyword?.trim()) {
      params.push(`%${query.keyword.trim()}%`);
      const i = params.length;
      where.push(`(c.name ILIKE $${i} OR COALESCE(c.condition_no,'') ILIKE $${i}
                   OR COALESCE(p.name,'') ILIKE $${i} OR COALESCE(w.title,'') ILIKE $${i})`);
    }
    if (query.direction) add("c.direction = $?", query.direction);
    if (query.kind) add("c.kind = $?", query.kind);
    if (query.workId) add("c.work_id = $?", query.workId);
    if (query.matterId) {
      params.push(query.matterId);
      where.push(`EXISTS (SELECT 1 FROM matter_links ml
                           WHERE ml.matter_id = $${params.length}
                             AND ml.target_type = 'condition'
                             AND ml.target_ref = c.id::text)`);
    }
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));

    try {
      const result = await this.database.query(
        `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_JOINS}
          WHERE ${where.join(" AND ")}
          ORDER BY c.condition_no DESC NULLS LAST, c.id DESC
          LIMIT $${params.length}`,
        params
      );
      return result.rows.map(mapSummary);
    } catch (error) { throw translate(error); }
  }

  async find(id: number): Promise<ConditionDetail | null> {
    const detail = await this.database.query(
      `SELECT ${SUMMARY_COLUMNS},
              c.agreement_id, c.parent_id, c.work_part_id, c.exclusivity, c.sublicensable,
              c.tax_category, c.payment_terms, c.cycle, c.notes,
              ag.title AS agreement_title, pc.condition_no AS parent_condition_no,
              wp.name AS work_part_name
         ${SUMMARY_JOINS}
         LEFT JOIN agreements ag ON ag.id = c.agreement_id
         LEFT JOIN conditions pc ON pc.id = c.parent_id
         LEFT JOIN work_parts wp ON wp.id = c.work_part_id
        WHERE c.id = $1`,
      [id]
    );
    const row = detail.rows[0] as Record<string, any> | undefined;
    if (!row) return null;

    const [scopes, balance, documents, events] = await Promise.all([
      this.scopes(id),
      this.balance(id),
      this.documents(id),
      this.events(id)
    ]);

    return {
      ...mapSummary(row),
      agreementId: int(row.agreement_id),
      agreementTitle: str(row.agreement_title),
      parentId: int(row.parent_id),
      parentConditionNo: str(row.parent_condition_no),
      workPartId: int(row.work_part_id),
      workPartName: str(row.work_part_name),
      exclusivity: row.exclusivity ?? null,
      sublicensable: row.sublicensable === null || row.sublicensable === undefined
        ? null : Boolean(row.sublicensable),
      taxCategory: row.tax_category ?? "taxable",
      paymentTerms: str(row.payment_terms),
      cycle: str(row.cycle),
      notes: str(row.notes),
      scopes, balance, documents, events
    };
  }

  private async scopes(id: number): Promise<ConditionScope[]> {
    const r = await this.database.query(
      `SELECT scope_type, label, code FROM condition_scopes
        WHERE condition_id = $1 ORDER BY scope_type, sort_order, label`, [id]);
    return r.rows.map((s) => ({
      scopeType: s.scope_type as ScopeType, label: String(s.label), code: str(s.code)
    }));
  }

  private async balance(id: number) {
    const r = await this.database.query(
      `SELECT mg_amount, ag_amount, planned_total, consumed_total, ag_remaining, ag_consumption_rate
         FROM v_condition_balance WHERE condition_id = $1`, [id]);
    const b = r.rows[0] as Record<string, any> | undefined;
    if (!b) return null;
    return {
      mgAmount: Number(b.mg_amount ?? 0),
      agAmount: Number(b.ag_amount ?? 0),
      plannedTotal: Number(b.planned_total ?? 0),
      consumedTotal: Number(b.consumed_total ?? 0),
      agRemaining: Number(b.ag_remaining ?? 0),
      agConsumptionRate: num(b.ag_consumption_rate)
    };
  }

  /** 文書 → 条件の参照なので、条件側からは document_conditions を辿る。 */
  private async documents(id: number) {
    const r = await this.database.query(
      `SELECT d.id, d.document_no, d.status, d.issued_at
         FROM document_conditions dc
         JOIN documents d ON d.id = dc.document_id
        WHERE dc.condition_id = $1
        ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [id]);
    return r.rows.map((d) => ({
      id: Number(d.id), documentNo: str(d.document_no), status: String(d.status),
      issuedAt: d.issued_at ? new Date(String(d.issued_at)).toISOString() : null
    }));
  }

  private async events(id: number) {
    const r = await this.database.query(
      `SELECT id, event_type, occurred_on, period, amount
         FROM condition_events
        WHERE condition_id = $1 AND status = 'active'
        ORDER BY occurred_on DESC, id DESC LIMIT 100`, [id]);
    return r.rows.map((e) => ({
      id: Number(e.id), eventType: String(e.event_type),
      occurredOn: dateStr(e.occurred_on) ?? "",
      period: str(e.period), amount: Number(e.amount ?? 0)
    }));
  }

  async requireExisting(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT id, condition_no, status, counterparty_id, currency FROM conditions WHERE id = $1 FOR UPDATE`,
      [id]);
    const row = r.rows[0];
    if (!row) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
    return row as { id: number; condition_no: string | null; status: string; counterparty_id: number; currency: string };
  }
}
