import { dateStr, type Queryable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";

/**
 * 受付箱の読み取り。
 *
 * 一覧のタブは3つ。未処理（new）、保留（on_hold）、更新あり（受付済みで
 * 受付後に Backlog が更新されたもの）。対象外・重複・受付済みは「すべて」で見る。
 */

export type IntakeTab = "new" | "on_hold" | "updated" | "all";

export interface IntakeRow {
  id: number;
  requestNo: string | null;
  source: string;
  state: string;
  kind: string | null;
  title: string;
  detail: string | null;
  counterpartyName: string | null;
  counterpartyId: number | null;
  dueOn: string | null;
  requesterSlackId: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  backlogIssueKey: string | null;
  backlogStatus: string | null;
  backlogUpdatedAt: string | null;
  backlogSnapshot: Record<string, unknown>;
  hasUnseenUpdate: boolean;
  /** メールの原票（差出人・宛先・添付・続きのメール）。メール以外は空。 */
  mail: { from: string | null; to: string[]; attachments: string[];
          followUps: Array<{ subject: string | null; from: string | null; receivedAt: string | null }> } | null;
  matterId: number | null;
  matterNo: string | null;
  matterTitle: string | null;
  duplicateOfId: number | null;
  duplicateOfNo: string | null;
  reason: string | null;
  holdUntil: string | null;
  handledAt: string | null;
  handledBy: string | null;
  createdAt: string;
}

const SELECT = `
  SELECT r.*, m.matter_no, m.title AS matter_title, d.request_no AS duplicate_of_no
    FROM intake_requests r
    LEFT JOIN matters m ON m.id = r.matter_id
    LEFT JOIN intake_requests d ON d.id = r.duplicate_of_id`;

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function mailOf(p: Record<string, any>): IntakeRow["mail"] {
  const follow = Array.isArray(p.followUps) ? p.followUps : [];
  return {
    from: p.from ?? null,
    to: Array.isArray(p.to) ? p.to.map(String) : [],
    attachments: (Array.isArray(p.attachments) ? p.attachments : []).map((a: any) => String(a?.filename ?? a)),
    followUps: follow.map((m: any) => ({
      subject: m?.subject ?? null, from: m?.from ?? null, receivedAt: m?.receivedAt ?? null
    }))
  };
}

export function toRow(r: Record<string, any>): IntakeRow {
  return {
    id: Number(r.id),
    requestNo: r.request_no ?? null,
    source: String(r.source),
    state: String(r.state),
    kind: r.kind ?? null,
    title: String(r.title),
    detail: r.detail ?? null,
    counterpartyName: r.counterparty_name ?? null,
    counterpartyId: r.counterparty_id === null || r.counterparty_id === undefined ? null : Number(r.counterparty_id),
    dueOn: dateStr(r.due_on),
    requesterSlackId: r.requester_slack_id ?? null,
    requesterName: r.requester_name ?? null,
    requesterEmail: r.requester_email ?? null,
    backlogIssueKey: r.backlog_issue_key ?? null,
    backlogStatus: r.backlog_status ?? null,
    backlogUpdatedAt: iso(r.backlog_updated_at),
    backlogSnapshot: (r.backlog_snapshot ?? {}) as Record<string, unknown>,
    hasUnseenUpdate: Boolean(r.has_unseen_update),
    mail: r.source === "email" ? mailOf(r.source_payload ?? {}) : null,
    matterId: r.matter_id === null || r.matter_id === undefined ? null : Number(r.matter_id),
    matterNo: r.matter_no ?? null,
    matterTitle: r.matter_title ?? null,
    duplicateOfId: r.duplicate_of_id === null || r.duplicate_of_id === undefined ? null : Number(r.duplicate_of_id),
    duplicateOfNo: r.duplicate_of_no ?? null,
    reason: r.reason ?? null,
    holdUntil: dateStr(r.hold_until),
    handledAt: iso(r.handled_at),
    handledBy: r.handled_by ?? null,
    createdAt: iso(r.created_at) ?? ""
  };
}

export interface MatterCandidate { id: number; matterNo: string | null; title: string; status: string; why: string }
export interface DuplicateCandidate { id: number; requestNo: string | null; title: string; state: string; why: string }

export class IntakeRepository {
  constructor(private readonly database: Queryable) {}

  async list(tab: IntakeTab = "new"): Promise<IntakeRow[]> {
    const where = tab === "new" ? "r.state = 'new'"
      : tab === "on_hold" ? "r.state = 'on_hold'"
      : tab === "updated" ? "r.state = 'accepted' AND r.has_unseen_update"
      : "TRUE";
    // 保留は再確認日が来たものを上に。それ以外は新しい順。
    const order = tab === "on_hold"
      ? "r.hold_until NULLS LAST, r.created_at DESC" : "r.created_at DESC";
    try {
      const r = await this.database.query(
        `${SELECT} WHERE ${where} ORDER BY ${order} LIMIT 300`);
      return (r.rows as any[]).map(toRow);
    } catch (error) { throw translate(error); }
  }

  /** タブの件数。ナビとホームの札に出す。 */
  async counts(): Promise<{ new: number; onHold: number; updated: number; holdDue: number }> {
    try {
      const r = await this.database.query(
        `SELECT count(*) FILTER (WHERE state = 'new')::int AS new,
                count(*) FILTER (WHERE state = 'on_hold')::int AS on_hold,
                count(*) FILTER (WHERE state = 'accepted' AND has_unseen_update)::int AS updated,
                count(*) FILTER (WHERE state = 'on_hold' AND hold_until <= CURRENT_DATE)::int AS hold_due
           FROM intake_requests`);
      const row = (r.rows[0] ?? {}) as any;
      return { new: Number(row.new ?? 0), onHold: Number(row.on_hold ?? 0),
               updated: Number(row.updated ?? 0), holdDue: Number(row.hold_due ?? 0) };
    } catch (error) { throw translate(error); }
  }

  /** 1件と、受付の判断に使う候補（接続先の案件・重複の可能性）。 */
  async find(id: number): Promise<{ request: IntakeRow; matterCandidates: MatterCandidate[];
                                    duplicateCandidates: DuplicateCandidate[] }> {
    try {
      const r = await this.database.query(`${SELECT} WHERE r.id = $1`, [id]);
      const raw = r.rows[0] as any;
      if (!raw) throw new DomainError("NOT_FOUND", `依頼 ${id} が見つかりません`);
      const request = toRow(raw);
      return {
        request,
        matterCandidates: await this.matterCandidates(request),
        duplicateCandidates: await this.duplicateCandidates(request)
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 接続先の候補。
   *   ① 本文に書かれた案件番号（MTR-YYYY-NNNNN）
   *   ② 本文に書かれた文書番号（ARC-…）の文書が属する案件（納品・利用報告の「対象契約番号」）
   *   ③ 同じ相手先の開いている案件
   */
  private async matterCandidates(request: IntakeRow): Promise<MatterCandidate[]> {
    const text = `${request.title}\n${request.detail ?? ""}`;
    const matterNos = [...new Set(text.match(/MTR-\d{4}-\d{5}/g) ?? [])];
    const documentNos = [...new Set(text.match(/ARC-[A-Z]+-\d{4}-\d{3,5}/g) ?? [])];
    const out = new Map<number, MatterCandidate>();
    const add = (rows: any[], why: string) => {
      for (const m of rows) {
        const id = Number(m.id);
        if (!out.has(id)) {
          out.set(id, { id, matterNo: m.matter_no ?? null, title: String(m.title),
                        status: String(m.status), why });
        }
      }
    };
    if (matterNos.length) {
      const r = await this.database.query(
        `SELECT id, matter_no, title, status FROM matters
          WHERE matter_no = ANY($1::text[]) AND merged_into_id IS NULL`, [matterNos]);
      add(r.rows as any[], "本文に書かれた案件番号");
    }
    if (documentNos.length) {
      const r = await this.database.query(
        `SELECT DISTINCT m.id, m.matter_no, m.title, m.status
           FROM documents d
           JOIN matters m ON m.id = d.matter_id
          WHERE d.document_no = ANY($1::text[]) AND m.merged_into_id IS NULL`, [documentNos]);
      add(r.rows as any[], `本文に書かれた文書番号（${documentNos.join("・")}）の案件`);
    }
    if (request.counterpartyName) {
      const r = await this.database.query(
        `SELECT m.id, m.matter_no, m.title, m.status
           FROM matters m
           JOIN parties p ON p.id = m.counterparty_id
          WHERE m.status NOT IN ('done', 'canceled') AND m.merged_into_id IS NULL
            AND (btrim(p.name) = btrim($1)
                 OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE btrim(a) = btrim($1)))
          ORDER BY m.updated_at DESC
          LIMIT 5`, [request.counterpartyName]);
      add(r.rows as any[], "同じ相手先の開いている案件");
    }
    return [...out.values()].slice(0, 8);
  }

  /** 重複の可能性。7日以内に入った別の依頼で、件名が同じもの、または相手先・種類が同じ未処理のもの。 */
  private async duplicateCandidates(request: IntakeRow): Promise<DuplicateCandidate[]> {
    if (request.state !== "new" && request.state !== "on_hold") return [];
    const r = await this.database.query(
      `SELECT id, request_no, title, state,
              (btrim(title) = btrim($2)) AS same_title
         FROM intake_requests
        WHERE id <> $1
          AND created_at > now() - interval '7 days'
          -- 同じ件名なら受付済みも候補（二度送られた依頼）。相手先・種類が同じだけのものは
          -- 未処理・保留に限る。受付済みの案件への追加の依頼（納品報告など）は重複ではない。
          AND ((state IN ('new', 'on_hold', 'accepted') AND btrim(title) = btrim($2))
               OR (state IN ('new', 'on_hold') AND $3::text IS NOT NULL
                   AND btrim(counterparty_name) = btrim($3) AND kind IS NOT DISTINCT FROM $4))
        ORDER BY created_at DESC
        LIMIT 5`,
      [request.id, request.title, request.counterpartyName, request.kind]);
    return (r.rows as any[]).map((d) => ({
      id: Number(d.id), requestNo: d.request_no ?? null, title: String(d.title), state: String(d.state),
      why: d.same_title ? "同じ件名で7日以内に入っている" : "同じ相手先・同じ種類で7日以内に入っている"
    }));
  }

  /** 案件の「受付」に繋がっている依頼。 */
  async forMatter(matterId: number): Promise<IntakeRow[]> {
    try {
      const r = await this.database.query(
        `${SELECT} WHERE r.matter_id = $1 AND r.state IN ('accepted', 'duplicate')
          ORDER BY r.created_at`, [matterId]);
      return (r.rows as any[]).map(toRow);
    } catch (error) { throw translate(error); }
  }
}
