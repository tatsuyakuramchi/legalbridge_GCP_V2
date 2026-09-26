import { inTransaction, dateStr, str, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 稟議（R-00001）と取締役会決議（B-00001）の台帳。V1 の ringi_records の置き換え（A-053）。
 *
 * 稟議の番号は社内の稟議で決まった番号をそのまま入れる（こちらで振らない）。
 * B- は関連当事者の議案を起票したときにこちらで振る（rpt/service.ts）。
 *
 * 稟議は文書・契約・条件・案件・作品と多対多で繋ぐ。番号（ARC-PO-…・AGR-…・CL-…・
 * MTR-…）を入れれば、何の番号かはこちらで見分ける。
 *
 * 稟議は消さない。取り下げは status を cancelled にする。繋ぎは外せる（監査に残す）。
 */

export const RINGI_STATUSES = ["open", "approved", "rejected", "closed", "cancelled"] as const;
export type RingiStatus = typeof RINGI_STATUSES[number];
export const RINGI_STATUS_LABEL: Record<RingiStatus, string> = {
  open: "起案中", approved: "承認", rejected: "否決", closed: "完了", cancelled: "取り下げ"
};

export type RingiTarget = "document" | "agreement" | "condition" | "matter" | "work";
export const RINGI_TARGET_LABEL: Record<RingiTarget, string> = {
  document: "文書", agreement: "契約", condition: "条件", matter: "案件", work: "作品"
};

export interface Ringi {
  id: number;
  ringiNo: string;
  decisionType: "ringi" | "board_resolution";
  title: string;
  category: string | null;
  ownerName: string | null;
  ownerDepartment: string | null;
  approvedOn: string | null;
  backlogIssueKey: string | null;
  status: RingiStatus;
  totalBudget: number | null;
  remarks: string | null;
  linkCount: number;
  updatedAt: string | null;
}

export interface RingiLink {
  targetType: RingiTarget;
  targetId: number;
  code: string | null;
  title: string;
  context: string | null;
  linkedAt: string | null;
}

export interface RingiInput {
  ringiNo?: string;
  title?: string;
  category?: string | null;
  ownerName?: string | null;
  ownerDepartment?: string | null;
  approvedOn?: string | null;
  backlogIssueKey?: string | null;
  status?: string;
  totalBudget?: number | null;
  remarks?: string | null;
}

/**
 * 稟議番号を揃える。5 桁だけなら R- を付ける（V1 の古い番号・稟議書の番号の書き方）。
 * 読めなければ null。
 */
export function normalizeRingiNo(input: string | null | undefined): string | null {
  const s = String(input ?? "").trim().toUpperCase().replace(/[ー－―‐]/g, "-").replace(/\s+/g, "");
  if (/^[0-9]{5}$/.test(s)) return `R-${s}`;
  if (/^[RB][0-9]{5}$/.test(s)) return `${s[0]}-${s.slice(1)}`;
  return /^[RB]-[0-9]{5}$/.test(s) ? s : null;
}

const text = (v: unknown, max: number, label: string) => {
  if (v === undefined) return undefined;
  const s = str(v)?.trim() ?? "";
  if (s.length > max) throw new DomainError("VALIDATION", `${label}が長すぎます（${max}字まで）`);
  return s || null;
};

/** 入れる前に形を確かめる。create では番号と件名が要る。 */
export function parseRingiInput(input: RingiInput, mode: "create" | "update") {
  const out: Record<string, unknown> = {};
  if (mode === "create" || input.ringiNo !== undefined) {
    const no = normalizeRingiNo(input.ringiNo);
    if (!no) throw new DomainError("VALIDATION", "稟議番号は R-00001（取締役会は B-00001）か 5 桁の数字で入れてください");
    out.ringi_no = no;
  }
  if (mode === "create" || input.title !== undefined) {
    const title = text(input.title, 300, "件名");
    if (!title) throw new DomainError("VALIDATION", "件名は空にできません");
    out.title = title;
  }
  const put = (col: string, v: unknown) => { if (v !== undefined) out[col] = v; };
  put("category", text(input.category, 50, "区分"));
  put("owner_name", text(input.ownerName, 100, "起案者"));
  put("owner_department", text(input.ownerDepartment, 100, "起案部署"));
  put("remarks", text(input.remarks, 2000, "備考"));
  if (input.backlogIssueKey !== undefined) {
    const key = text(input.backlogIssueKey, 40, "Backlog の課題キー");
    if (key && !/^[A-Z0-9_]+-\d+$/.test(key.toUpperCase())) {
      throw new DomainError("VALIDATION", "Backlog の課題キーは LEGAL-123 の形で入れてください");
    }
    out.backlog_issue_key = key ? key.toUpperCase() : null;
  }
  if (input.approvedOn !== undefined) {
    const d = text(input.approvedOn, 10, "承認日");
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new DomainError("VALIDATION", "承認日は YYYY-MM-DD で入れてください");
    out.approved_on = d;
  }
  if (input.status !== undefined) {
    if (!(RINGI_STATUSES as readonly string[]).includes(String(input.status))) {
      throw new DomainError("VALIDATION", `状態 ${input.status} は使えません`);
    }
    out.status = input.status;
  }
  if (input.totalBudget !== undefined) {
    const n = input.totalBudget === null || (input.totalBudget as unknown) === "" ? null : Number(input.totalBudget);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n >= 1e13)) throw new DomainError("VALIDATION", "予算額が正しくありません");
    out.total_budget = n;
  }
  return out;
}

const mapRingi = (r: any): Ringi => ({
  id: Number(r.id), ringiNo: String(r.ringi_no),
  decisionType: r.decision_type === "board_resolution" ? "board_resolution" : "ringi",
  title: String(r.title), category: str(r.category), ownerName: str(r.owner_name),
  ownerDepartment: str(r.owner_department), approvedOn: dateStr(r.approved_on),
  backlogIssueKey: str(r.backlog_issue_key), status: r.status as RingiStatus,
  totalBudget: r.total_budget === null || r.total_budget === undefined ? null : Number(r.total_budget),
  remarks: str(r.remarks), linkCount: Number(r.link_count ?? 0),
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null
});

const SELECT_RINGI = `
  SELECT r.*, (SELECT count(*) FROM ringi_links l WHERE l.ringi_id = r.id) AS link_count
    FROM ringi r`;

export class RingiService {
  constructor(private readonly database: Transactable) {}

  async list(options: { q?: string; status?: string; limit?: number } = {}): Promise<Ringi[]> {
    const q = String(options.q ?? "").trim();
    const params: unknown[] = [];
    const where: string[] = [];
    if (q) {
      const no = normalizeRingiNo(q);
      params.push(`%${q}%`);
      const like = `$${params.length}`;
      if (no) { params.push(no); }
      where.push(`(r.ringi_no ILIKE ${like} OR r.title ILIKE ${like} OR COALESCE(r.owner_name,'') ILIKE ${like}
                   OR COALESCE(r.owner_department,'') ILIKE ${like} OR COALESCE(r.category,'') ILIKE ${like}
                   ${no ? `OR r.ringi_no = $${params.length}` : ""})`);
    }
    if (options.status && (RINGI_STATUSES as readonly string[]).includes(options.status)) {
      params.push(options.status);
      where.push(`r.status = $${params.length}`);
    }
    params.push(Math.min(Math.max(options.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `${SELECT_RINGI} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY r.ringi_no DESC LIMIT $${params.length}`, params);
      return r.rows.map(mapRingi);
    } catch (error) { throw translate(error); }
  }

  async get(id: number): Promise<Ringi & { links: RingiLink[] }> {
    try {
      const r = await this.database.query(`${SELECT_RINGI} WHERE r.id = $1`, [id]);
      if (!r.rows[0]) throw new DomainError("NOT_FOUND", "稟議が見つかりません");
      return { ...mapRingi(r.rows[0]), links: await this.links(id) };
    } catch (error) { throw translate(error); }
  }

  /** 番号で引く（R-/B- 付き、または 5 桁）。/法務検索 から使う。 */
  async findByNo(input: string): Promise<(Ringi & { links: RingiLink[] }) | null> {
    const no = normalizeRingiNo(input);
    if (!no) return null;
    try {
      const r = await this.database.query(`${SELECT_RINGI} WHERE r.ringi_no = $1`, [no]);
      if (!r.rows[0]) return null;
      const ringi = mapRingi(r.rows[0]);
      return { ...ringi, links: await this.links(ringi.id) };
    } catch (error) { throw translate(error); }
  }

  /** 相手（文書・契約など）に繋がっている稟議。各画面に出す。 */
  async forTarget(targetType: RingiTarget, targetId: number): Promise<Ringi[]> {
    try {
      const r = await this.database.query(
        `${SELECT_RINGI}
          WHERE EXISTS (SELECT 1 FROM ringi_links l
                         WHERE l.ringi_id = r.id AND l.target_type = $1 AND l.target_id = $2)
          ORDER BY r.ringi_no DESC`, [targetType, targetId]);
      return r.rows.map(mapRingi);
    } catch (error) { throw translate(error); }
  }

  async create(input: RingiInput, actor: string): Promise<Ringi & { links: RingiLink[] }> {
    const values = parseRingiInput(input, "create");
    const no = String(values.ringi_no);
    values.decision_type = no.startsWith("B-") ? "board_resolution" : "ringi";
    values.created_by = actor;
    const cols = Object.keys(values);
    try {
      const id = await inTransaction(this.database, async (client) => {
        const dup = await client.query("SELECT id FROM ringi WHERE ringi_no = $1", [no]);
        if (dup.rows[0]) throw new DomainError("CONFLICT", `${no} はもう登録されています`);
        const r = await client.query(
          `INSERT INTO ringi (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
           RETURNING id`, cols.map((c) => values[c]));
        const newId = Number((r.rows[0] as any).id);
        await recordAudit(client, { actor, action: "ringi.create", targetType: "ringi", targetId: newId,
                                    detail: { ringiNo: no, title: values.title } });
        return newId;
      });
      return this.get(id);
    } catch (error) { throw translate(error); }
  }

  async update(id: number, input: RingiInput, actor: string): Promise<Ringi & { links: RingiLink[] }> {
    const values = parseRingiInput(input, "update");
    if (values.ringi_no !== undefined) {
      values.decision_type = String(values.ringi_no).startsWith("B-") ? "board_resolution" : "ringi";
    }
    const cols = Object.keys(values);
    if (!cols.length) return this.get(id);
    try {
      await inTransaction(this.database, async (client) => {
        const before = await client.query("SELECT * FROM ringi WHERE id = $1 FOR UPDATE", [id]);
        if (!before.rows[0]) throw new DomainError("NOT_FOUND", "稟議が見つかりません");
        if (values.ringi_no !== undefined && values.ringi_no !== (before.rows[0] as any).ringi_no) {
          const dup = await client.query("SELECT 1 FROM ringi WHERE ringi_no = $1 AND id <> $2", [values.ringi_no, id]);
          if (dup.rows[0]) throw new DomainError("CONFLICT", `${values.ringi_no} はもう登録されています`);
        }
        await client.query(
          `UPDATE ringi SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now()
            WHERE id = $1`, [id, ...cols.map((c) => values[c])]);
        const b = before.rows[0] as Record<string, unknown>;
        await recordAudit(client, { actor, action: "ringi.update", targetType: "ringi", targetId: id,
          detail: { changed: Object.fromEntries(cols.map((c) => [c, { from: b[c] ?? null, to: values[c] }])) } });
      });
      return this.get(id);
    } catch (error) { throw translate(error); }
  }

  /**
   * 繋ぐ。番号（ARC-PO-2026-1001・AGR-2025-0011・CL-2026-00031・MTR-2026-00217）か、
   * 種類と ID で指定する。番号から何の番号かを見分ける。
   */
  async link(id: number, target: { ref?: string; targetType?: RingiTarget; targetId?: number }, actor: string) {
    try {
      const resolved = target.ref ? await this.resolveRef(target.ref)
        : target.targetType && target.targetId ? { targetType: target.targetType, targetId: Number(target.targetId) } : null;
      if (!resolved) throw new DomainError("VALIDATION", `「${target.ref ?? ""}」に当たる文書・契約・条件・案件がありません`);
      await inTransaction(this.database, async (client) => {
        const r = await client.query("SELECT ringi_no FROM ringi WHERE id = $1", [id]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", "稟議が見つかりません");
        const ins = await client.query(
          `INSERT INTO ringi_links (ringi_id, target_type, target_id, linked_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`, [id, resolved.targetType, resolved.targetId, actor]);
        if (ins.rowCount) {
          await recordAudit(client, { actor, action: "ringi.link", targetType: "ringi", targetId: id,
                                      detail: { ...resolved, ref: target.ref ?? null } });
        }
      });
      return this.get(id);
    } catch (error) { throw translate(error); }
  }

  async unlink(id: number, targetType: RingiTarget, targetId: number, actor: string) {
    try {
      await inTransaction(this.database, async (client) => {
        const del = await client.query(
          "DELETE FROM ringi_links WHERE ringi_id = $1 AND target_type = $2 AND target_id = $3",
          [id, targetType, targetId]);
        if (del.rowCount) {
          await recordAudit(client, { actor, action: "ringi.unlink", targetType: "ringi", targetId: id,
                                      detail: { targetType, targetId } });
        }
      });
      return this.get(id);
    } catch (error) { throw translate(error); }
  }

  /** 番号から相手を見分ける。文書 → 契約 → 条件 → 案件の順に、完全一致で引く。 */
  async resolveRef(ref: string): Promise<{ targetType: RingiTarget; targetId: number } | null> {
    const s = ref.trim().toUpperCase();
    if (!s) return null;
    const r = await this.database.query(
      `SELECT 'document' AS t, id FROM documents WHERE upper(document_no) = $1
       UNION ALL SELECT 'agreement', id FROM agreements WHERE upper(agreement_no) = $1
       UNION ALL SELECT 'condition', id FROM conditions WHERE upper(condition_no) = $1
       UNION ALL SELECT 'matter', id FROM matters WHERE upper(matter_no) = $1
       UNION ALL SELECT 'work', id FROM works WHERE upper(work_code) = $1
       LIMIT 1`, [s]);
    const row = r.rows[0] as any;
    return row ? { targetType: row.t as RingiTarget, targetId: Number(row.id) } : null;
  }

  private async links(id: number): Promise<RingiLink[]> {
    const r = await this.database.query(
      `SELECT l.target_type, l.target_id, l.linked_at,
              COALESCE(d.document_no, a.agreement_no, c.condition_no, m.matter_no, w.work_code) AS code,
              COALESCE(t.label, a.title, c.name, m.title, w.title, '（見つからない）') AS title,
              COALESCE(d.status, a.status, c.status, m.status, w.status) AS context
         FROM ringi_links l
         LEFT JOIN documents d ON l.target_type = 'document' AND d.id = l.target_id
         LEFT JOIN document_template_versions v ON v.id = d.template_version_id
         LEFT JOIN document_templates t ON t.id = v.template_id
         LEFT JOIN agreements a ON l.target_type = 'agreement' AND a.id = l.target_id
         LEFT JOIN conditions c ON l.target_type = 'condition' AND c.id = l.target_id
         LEFT JOIN matters m ON l.target_type = 'matter' AND m.id = l.target_id
         LEFT JOIN works w ON l.target_type = 'work' AND w.id = l.target_id
        WHERE l.ringi_id = $1
        ORDER BY array_position(ARRAY['agreement','document','condition','matter','work'], l.target_type), code`, [id]);
    return (r.rows as any[]).map((x) => ({
      targetType: x.target_type as RingiTarget, targetId: Number(x.target_id), code: str(x.code),
      title: String(x.title), context: str(x.context), linkedAt: x.linked_at ? new Date(x.linked_at).toISOString() : null
    }));
  }
}
