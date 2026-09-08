import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import type { MatterDetail, MatterKind, MatterStatus, MatterSummary } from "../core/model.js";
import { ConditionRepository } from "../conditions/repository.js";

function mapSummary(row: Record<string, any>): MatterSummary {
  return {
    id: Number(row.id),
    matterNo: str(row.matter_no),
    title: String(row.title ?? ""),
    kind: row.kind as MatterKind,
    status: row.status as MatterStatus,
    ownerName: str(row.owner_name),
    counterparty: row.party_id
      ? { id: Number(row.party_id), name: String(row.party_name ?? ""), kind: row.party_kind }
      : null,
    dueOn: dateStr(row.due_on),
    blockedReason: str(row.blocked_reason)
  };
}

const SUMMARY_COLUMNS = `
  m.id, m.matter_no, m.title, m.kind, m.status, m.due_on, m.blocked_reason,
  s.name AS owner_name,
  p.id AS party_id, p.name AS party_name, p.kind AS party_kind`;

const SUMMARY_FROM = `
  FROM matters m
  LEFT JOIN staff   s ON s.id = m.owner_staff_id
  LEFT JOIN parties p ON p.id = m.counterparty_id`;

export class MatterRepository {
  private readonly conditions: ConditionRepository;
  constructor(private readonly database: Transactable) {
    this.conditions = new ConditionRepository(database);
  }

  async list(query: { keyword?: string; kind?: MatterKind; openOnly?: boolean; limit?: number } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.keyword?.trim()) {
      params.push(`%${query.keyword.trim()}%`);
      const i = params.length;
      where.push(`(m.title ILIKE $${i} OR COALESCE(m.matter_no,'') ILIKE $${i} OR COALESCE(p.name,'') ILIKE $${i})`);
    }
    if (query.kind) { params.push(query.kind); where.push(`m.kind = $${params.length}`); }
    if (query.openOnly) where.push("m.status NOT IN ('done','canceled')");
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM}
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY m.updated_at DESC, m.id DESC
          LIMIT $${params.length}`, params);
      return r.rows.map(mapSummary);
    } catch (error) { throw translate(error); }
  }

  /** 案件は所有せず参照する。ここで集めるのは全部リンク先。 */
  async find(id: number): Promise<MatterDetail | null> {
    const head = await this.database.query(
      `SELECT ${SUMMARY_COLUMNS}, m.remarks, m.drive_folder_url ${SUMMARY_FROM}
        WHERE m.id = $1`, [id]);
    const row = head.rows[0] as Record<string, any> | undefined;
    if (!row) return null;

    const [conditions, documents, payments, communications, links, tasks] = await Promise.all([
      this.conditions.list({ matterId: id, limit: 100 }),
      this.documents(id),
      this.payments(id),
      this.communications(id),
      this.links(id),
      this.tasks(id)
    ]);

    return {
      ...mapSummary(row),
      remarks: str(row.remarks),
      driveFolderUrl: str(row.drive_folder_url),
      conditions, documents, payments, communications, links, tasks
    };
  }

  private async documents(id: number) {
    const r = await this.database.query(
      `SELECT d.id, d.document_no, d.status, d.issued_at, v.template_label
         FROM documents d
         LEFT JOIN v_document_display v ON v.document_id = d.id
        WHERE d.matter_id = $1
        ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [id]);
    return r.rows.map((d) => ({
      id: Number(d.id), documentNo: str(d.document_no), status: String(d.status),
      templateLabel: str(d.template_label),
      issuedAt: d.issued_at ? new Date(String(d.issued_at)).toISOString() : null
    }));
  }

  /** 支払は案件に属さない（複数案件をまたぐ）。条件の割当経由で辿る。 */
  private async payments(id: number) {
    const r = await this.database.query(
      `SELECT DISTINCT p.id, p.payment_no, p.direction, p.amount, p.currency, p.due_on, p.status
         FROM payments p
         JOIN payment_allocations a ON a.payment_id = p.id
         JOIN matter_links ml ON ml.target_type = 'condition'
                             AND ml.target_ref = a.condition_id::text
        WHERE ml.matter_id = $1
        ORDER BY p.due_on NULLS LAST, p.id`, [id]);
    return r.rows.map((p) => ({
      id: Number(p.id), paymentNo: str(p.payment_no), direction: p.direction as "in" | "out",
      amount: Number(p.amount ?? 0), currency: String(p.currency ?? "JPY"),
      dueOn: dateStr(p.due_on), status: String(p.status)
    }));
  }

  /** 連絡履歴は監査記録から組む（V2 では送信履歴が3系統に分かれていた）。 */
  private async communications(id: number) {
    const r = await this.database.query(
      `SELECT occurred_at, action, actor, detail
         FROM audit_events
        WHERE (target_type = 'matter' AND target_id = $1)
           OR (target_type = 'document' AND target_id IN (SELECT id FROM documents WHERE matter_id = $1))
        ORDER BY occurred_at DESC LIMIT 100`, [id]);
    return r.rows.map((a) => ({
      occurredAt: new Date(String(a.occurred_at)).toISOString(),
      action: String(a.action), actor: String(a.actor),
      detail: (a.detail as Record<string, unknown>) ?? {}
    }));
  }

  private async links(id: number) {
    const r = await this.database.query(
      `SELECT target_type, target_ref, relation, snapshot FROM matter_links
        WHERE matter_id = $1 ORDER BY target_type, target_ref`, [id]);
    return r.rows.map((l) => ({
      targetType: String(l.target_type), targetRef: String(l.target_ref), relation: String(l.relation),
      // Backlog の状態やメールの件名を写してある。画面で見えるようにする。
      snapshot: (l.snapshot as Record<string, unknown>) ?? {}
    }));
  }

  private async tasks(id: number) {
    const r = await this.database.query(
      `SELECT t.id, t.title, t.status, t.due_at, s.name AS assignee_name
         FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_staff_id
        WHERE t.matter_id = $1 ORDER BY t.due_at NULLS LAST, t.id`, [id]);
    return r.rows.map((t) => ({
      id: Number(t.id), title: String(t.title), status: String(t.status),
      dueAt: t.due_at ? new Date(String(t.due_at)).toISOString() : null,
      assigneeName: str(t.assignee_name)
    }));
  }
}
