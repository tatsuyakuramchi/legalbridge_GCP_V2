import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import type {
  ConditionDetail, ConditionRevision, ConditionScope, ConditionSummary, Direction, ScopeType
} from "../core/model.js";

const SUMMARY_COLUMNS = `
  c.id, c.condition_no, c.direction, c.kind, c.name, c.currency, c.pricing_model,
  c.rate_ppm, c.flat_amount, c.unit_amount, c.mg_amount, c.ag_amount, c.term_start, c.term_end,
  c.status, c.effective_from,
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
    unitAmount: int(row.unit_amount),
    mgAmount: int(row.mg_amount),
    agAmount: int(row.ag_amount),
    termStart: dateStr(row.term_start),
    termEnd: dateStr(row.term_end),
    effectiveFrom: dateStr(row.effective_from),
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

    const [scopes, balance, documents, events, matters] = await Promise.all([
      this.scopes(id),
      this.balance(id),
      this.documents(id),
      this.events(id),
      this.matters(id)
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
      scopes, balance, documents, events, matters
    };
  }

  /**
   * この条件を扱っている案件。matter_links は案件→条件の向きしか無いので、
   * 条件から読むにはここで反転する。読めないと、条件の画面では案件に付いて
   * いるかどうかすら分からない。
   */
  private async matters(id: number) {
    const r = await this.database.query(
      `SELECT m.id, m.matter_no, m.title, m.kind, m.status
         FROM matter_links ml
         JOIN matters m ON m.id = ml.matter_id
        WHERE ml.target_type = 'condition' AND ml.target_ref = $1::text
        ORDER BY m.id`, [String(id)]);
    return r.rows.map((m: Record<string, any>) => ({
      id: Number(m.id), matterNo: str(m.matter_no), title: String(m.title),
      kind: String(m.kind), status: String(m.status)
    }));
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
      `SELECT mg_amount, ag_amount, planned_total, consumed_total,
              ag_consumed, ag_remaining, ag_consumption_rate
         FROM v_condition_balance WHERE condition_id = $1`, [id]);
    const b = r.rows[0] as Record<string, any> | undefined;
    if (!b) return null;
    return {
      mgAmount: Number(b.mg_amount ?? 0),
      agAmount: Number(b.ag_amount ?? 0),
      plannedTotal: Number(b.planned_total ?? 0),
      consumedTotal: Number(b.consumed_total ?? 0),
      agConsumed: Number(b.ag_consumed ?? 0),
      agRemaining: Number(b.ag_remaining ?? 0),
      agConsumptionRate: num(b.ag_consumption_rate)
    };
  }

  /** 文書 → 条件の参照なので、条件側からは document_conditions を辿る。 */
  private async documents(id: number) {
    const r = await this.database.query(
      `SELECT d.id, d.document_no, d.status, d.issued_at, d.matter_id
         FROM document_conditions dc
         JOIN documents d ON d.id = dc.document_id
        WHERE dc.condition_id = $1
        ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [id]);
    return r.rows.map((d) => ({
      id: Number(d.id), documentNo: str(d.document_no), status: String(d.status),
      issuedAt: d.issued_at ? new Date(String(d.issued_at)).toISOString() : null,
      matterId: int(d.matter_id)
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

  /** 保証のある条件の消化状況。お金の画面が使う。 */
  /**
   * 改訂の履歴。
   *
   * 契約変更で金額を直すと、旧版を残して新版を作る（superseded_by_id で繋ぐ）。
   * 書く処理はあったが読む処理が無く、画面からは「いま有効な版」しか見えず、
   * 前がいくらだったのか・どれが生きているのかを追えなかった。
   *
   * 系列（series_id）で引く。superseded_by_id の鎖を辿ると、まだ効いていない
   * 予約の版が見えない。予約の版は旧版を差し替えていないので鎖に入らず、
   * 「2027-04-01 から適用予定の改訂がある」ことが画面に出せなかった。
   *
   * どの版から開いても同じ並びが返る。並びは適用開始日の順で、
   * 予約の版は最後に来る。
   */
  async revisions(id: number): Promise<ConditionRevision[]> {
    try {
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.status, c.superseded_by_id, c.effective_from,
                c.pricing_model, c.rate_ppm, c.flat_amount, c.unit_amount,
                c.mg_amount, c.ag_amount, c.currency,
                c.term_start, c.term_end, c.tax_category, c.payment_terms, c.notes,
                c.created_at, c.updated_at,
                p.id AS party_id, p.name AS party_name,
                (SELECT count(*)::int FROM condition_events e
                  WHERE e.condition_id = c.id AND e.status = 'active') AS event_count,
                (SELECT count(*)::int FROM document_conditions dc
                  WHERE dc.condition_id = c.id) AS document_count
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
          WHERE c.series_id = (SELECT series_id FROM conditions WHERE id = $1)
          ORDER BY c.effective_from NULLS FIRST, c.created_at, c.id`,
        [id]);
      return (r.rows as any[]).map((row, index) => ({
        id: Number(row.id),
        conditionNo: str(row.condition_no),
        name: String(row.name),
        status: String(row.status) as ConditionDetail["status"],
        // 生きているのは active だけ。draft は未発効、あとは役目を終えた版。
        live: row.status === "active",
        supersededById: int(row.superseded_by_id),
        effectiveFrom: dateStr(row.effective_from),
        revision: index + 1,
        currency: String(row.currency),
        pricingModel: String(row.pricing_model),
        ratePpm: int(row.rate_ppm),
        flatAmount: int(row.flat_amount),
        unitAmount: int(row.unit_amount),
        mgAmount: int(row.mg_amount),
        agAmount: int(row.ag_amount),
        termStart: dateStr(row.term_start),
        termEnd: dateStr(row.term_end),
        taxCategory: String(row.tax_category),
        paymentTerms: str(row.payment_terms),
        notes: str(row.notes),
        counterparty: row.party_id
          ? { id: Number(row.party_id), name: String(row.party_name) } : null,
        eventCount: Number(row.event_count ?? 0),
        documentCount: Number(row.document_count ?? 0),
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString()
      }));
    } catch (error) { throw translate(error); }
  }

  async balances(limit = 200) {
    try {
      const r = await this.database.query(
        `SELECT b.condition_id, b.condition_no, b.currency, b.direction,
                b.mg_amount, b.ag_amount, b.planned_total, b.consumed_total,
                b.ag_consumed, b.ag_remaining, b.ag_consumption_rate,
                c.name, p.name AS party_name, w.title AS work_title
           FROM v_condition_balance b
           JOIN conditions c ON c.id = b.condition_id
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w   ON w.id = c.work_id
          WHERE c.status = 'active'
            AND (COALESCE(b.mg_amount, 0) > 0 OR COALESCE(b.ag_amount, 0) > 0
                 OR COALESCE(b.consumed_total, 0) > 0)
          ORDER BY b.ag_remaining DESC, b.condition_id
          LIMIT $1`, [Math.min(Math.max(limit, 1), 500)]);
      return r.rows.map((row: Record<string, any>) => ({
        conditionId: Number(row.condition_id),
        conditionNo: str(row.condition_no),
        name: String(row.name ?? ""),
        direction: String(row.direction),
        currency: String(row.currency ?? "JPY"),
        counterparty: str(row.party_name),
        workTitle: str(row.work_title),
        mgAmount: Number(row.mg_amount ?? 0),
        agAmount: Number(row.ag_amount ?? 0),
        plannedTotal: Number(row.planned_total ?? 0),
        consumedTotal: Number(row.consumed_total ?? 0),
        agConsumed: Number(row.ag_consumed ?? 0),
        agRemaining: Number(row.ag_remaining ?? 0),
        agConsumptionRate: num(row.ag_consumption_rate)
      }));
    } catch (error) { throw translate(error); }
  }

  async requireExisting(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT id, condition_no, status, counterparty_id, currency, series_id, effective_from
         FROM conditions WHERE id = $1 FOR UPDATE`,
      [id]);
    const row = r.rows[0];
    if (!row) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
    return row as {
      id: number; condition_no: string | null; status: string;
      counterparty_id: number; currency: string;
      series_id: number | null; effective_from: unknown;
    };
  }
}
