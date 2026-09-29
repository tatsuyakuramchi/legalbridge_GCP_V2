import { dateStr, type Queryable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { purposeOf } from "../integrations/slack-intake.js";
import {
  isDailyPurpose, isPaymentPurpose, loadProgress, resolvePaymentTarget,
  type DailyPurpose, type PaymentTarget, type RequestProgress
} from "./payment-request.js";

/** 依頼の種別（デイリータスクの purpose）。原票に無ければ「その他」。 */
export function purposeOfTask(row: { purpose: string | null }): DailyPurpose {
  return isDailyPurpose(row.purpose) ? row.purpose : "other";
}

/**
 * 受付箱の読み取り。
 *
 * 受付箱は振り分けだけ（A-064）。一覧のタブは 未処理（new）、保留（on_hold）、
 * 返信・更新あり（振り分けたあとに Backlog が更新された・依頼者が DM のスレッドに
 * 返信した）、すべて。振り分けたあとの作業はデイリータスク（tasks）か案件で追う。
 */

export type IntakeTab = "new" | "on_hold" | "updated" | "all";

/** 依頼から起こした作業（A-064）。デイリータスクにした依頼だけ持つ。 */
export interface IntakeTaskRef {
  id: number; status: string; matterId: number | null;
  assigneeStaffId: number | null; assigneeName: string | null; dueOn: string | null; doneAt: string | null;
}

export interface IntakeRow {
  id: number;
  requestNo: string | null;
  source: string;
  state: string;
  kind: string | null;
  /** 依頼者が選んだ内容（Slack の /法務依頼）と、その表示。無ければ null。 */
  purpose: string | null;
  purposeLabel: string | null;
  /** 支払の書類（検収書・利用許諾計算書）の対象の発注書番号・契約書番号。 */
  targetDocNo: string | null;
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
  /** matter=案件へ / direct=デイリータスクへ（A-058・A-064）。振り分ける前は null。 */
  handling: "matter" | "direct" | null;
  /** 依頼から起こした作業。デイリータスクにした依頼だけ。担当・期日・完了はこちら。 */
  task: IntakeTaskRef | null;
  /** デイリータスクの工程。詳細で入る。 */
  progress?: RequestProgress | null;
}

const SELECT = `
  SELECT r.*, m.matter_no, m.title AS matter_title, d.request_no AS duplicate_of_no,
         t.id AS task_id, t.status AS task_status, t.matter_id AS task_matter_id,
         t.assignee_staff_id AS task_assignee_staff_id, t.due_at AS task_due_at, t.done_at AS task_done_at,
         st.name AS task_assignee_name
    FROM intake_requests r
    LEFT JOIN matters m ON m.id = r.matter_id
    LEFT JOIN intake_requests d ON d.id = r.duplicate_of_id
    LEFT JOIN tasks t ON t.request_id = r.id
    LEFT JOIN staff st ON st.id = t.assignee_staff_id`;

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
  // 依頼の内容と対象の番号。Slack は送信のとき、それ以外は「案件にせず処理」で受け付けたときに入る。
  // メールの原票は別の形（差出人・本文）なので、受け付けるまでは読まない。
  const payload = (r.source === "slack" || r.handling === "direct"
    ? r.source_payload ?? {} : {}) as Record<string, any>;
  const purpose = purposeOf(payload.purpose);
  return {
    id: Number(r.id),
    requestNo: r.request_no ?? null,
    source: String(r.source),
    state: String(r.state),
    kind: r.kind ?? null,
    // 定型文書・その他は受付箱で選ぶ種別（Slack の依頼の内容には無い）。
    purpose: purpose?.value ?? (isDailyPurpose(payload.purpose) ? payload.purpose : null),
    purposeLabel: purpose?.label ?? (payload.purpose === "template" ? "定型文書" : payload.purpose === "other" ? "その他" : null),
    targetDocNo: payload.targetDocNo ? String(payload.targetDocNo) : null,
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
    createdAt: iso(r.created_at) ?? "",
    handling: r.handling === "direct" || r.handling === "matter" ? r.handling : null,
    task: r.task_id ? {
      id: Number(r.task_id), status: String(r.task_status ?? "todo"),
      matterId: r.task_matter_id ? Number(r.task_matter_id) : null,
      assigneeStaffId: r.task_assignee_staff_id ? Number(r.task_assignee_staff_id) : null,
      assigneeName: r.task_assignee_name ?? null,
      dueOn: taskDueOn(r.task_due_at), doneAt: iso(r.task_done_at)
    } : null
  };
}

/** 作業の期日（timestamptz）を日本の日付に。 */
export function taskDueOn(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return dateStr(v);
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 依頼に繋いだ許諾料の回（A-060）。予定明細の行（時限式）か実績（イベント式）。 */
export interface IntakeRound {
  kind: "schedule" | "event"; targetId: number; label: string | null;
  closeOn: string | null; payOn: string | null;
  conditionId: number; usageType: string | null;
  workId: number | null; workTitle: string | null; partyId: number | null; partyName: string | null;
}

/** 依頼者の DM のスレッドへの返信（案件にせず処理している依頼）。 */
export interface IntakeReply { at: string; user: string; text: string }

export interface MatterCandidate { id: number; matterNo: string | null; title: string; status: string; why: string }
export interface DuplicateCandidate { id: number; requestNo: string | null; title: string; state: string; why: string }

export class IntakeRepository {
  constructor(private readonly database: Queryable) {}

  async list(tab: IntakeTab = "new"): Promise<IntakeRow[]> {
    // 返信・更新ありは、振り分けたあとの依頼（保留・受付済）に来たもの。未処理は未処理のタブで読む。
    const where = tab === "new" ? "r.state = 'new'"
      : tab === "on_hold" ? "r.state = 'on_hold'"
      : tab === "updated" ? "r.state <> 'new' AND r.has_unseen_update"
      : "TRUE";
    // 保留は再確認日が来たものを上に。それ以外は新しい順。
    const order = tab === "on_hold" ? "r.hold_until NULLS LAST, r.created_at DESC" : "r.created_at DESC";
    try {
      const r = await this.database.query(
        `${SELECT} WHERE ${where} ORDER BY ${order} LIMIT 300`);
      return (r.rows as any[]).map(toRow);
    } catch (error) { throw translate(error); }
  }

  /** デイリータスクにした依頼の工程。それ以外は null。完了は作業（tasks）の done_at。 */
  async progressOf(row: IntakeRow): Promise<RequestProgress | null> {
    if (row.handling !== "direct" || !row.task) return null;
    const purpose = purposeOfTask(row);
    return loadProgress(this.database, {
      id: row.id, purpose, createdAt: row.createdAt,
      acceptedAt: row.handledAt, doneAt: row.task.doneAt
    });
  }

  /** タブの件数。ナビとホームの札に出す。 */
  async counts(): Promise<{ new: number; onHold: number; updated: number; holdDue: number }> {
    try {
      const r = await this.database.query(
        `SELECT count(*) FILTER (WHERE state = 'new')::int AS new,
                count(*) FILTER (WHERE state = 'on_hold')::int AS on_hold,
                count(*) FILTER (WHERE state <> 'new' AND has_unseen_update)::int AS updated,
                count(*) FILTER (WHERE state = 'on_hold' AND hold_until <= CURRENT_DATE)::int AS hold_due
           FROM intake_requests`);
      const row = (r.rows[0] ?? {}) as any;
      return { new: Number(row.new ?? 0), onHold: Number(row.on_hold ?? 0),
               updated: Number(row.updated ?? 0), holdDue: Number(row.hold_due ?? 0) };
    } catch (error) { throw translate(error); }
  }

  /** 1件と、受付の判断に使う候補（接続先の案件・重複の可能性）。 */
  async find(id: number): Promise<{ request: IntakeRow; matterCandidates: MatterCandidate[];
                                    duplicateCandidates: DuplicateCandidate[];
                                    target: PaymentTarget | null;
                                    conditions: Array<{ id: number; conditionNo: string | null; name: string;
                                                        workId: number | null; workTitle: string | null; partyId: number | null }>;
                                    rounds: IntakeRound[];
                                    ledgers: Array<{ partyId: number; partyName: string; workId: number; workTitle: string }>;
                                    replies: IntakeReply[] }> {
    try {
      const r = await this.database.query(`${SELECT} WHERE r.id = $1`, [id]);
      const raw = r.rows[0] as any;
      if (!raw) throw new DomainError("NOT_FOUND", `依頼 ${id} が見つかりません`);
      const request = toRow(raw);
      request.progress = await this.progressOf(request);
      // 検収書・計算書の依頼は、対象の番号から条件と案件を引き当てて見せる
      // （発注書が案件に入っていれば、その案件へ繋ぐ）。
      const target = isPaymentPurpose(request.purpose)
        ? await resolvePaymentTarget(this.database, request.purpose, request.targetDocNo) : null;
      const linked = request.handling === "direct"
        ? (await this.database.query(
            `SELECT c.id, c.condition_no, c.name, c.work_id, w.title AS work_title, c.counterparty_id,
                    p.name AS party_name
               FROM intake_request_links l
               JOIN conditions c ON c.id = l.target_id
               LEFT JOIN works w ON w.id = c.work_id
               LEFT JOIN parties p ON p.id = c.counterparty_id
              WHERE l.request_id = $1 AND l.target_type = 'condition'
              ORDER BY c.condition_no NULLS LAST, c.id`, [id])).rows as any[]
        : [];
      const roundRows = request.handling === "direct"
        ? (await this.database.query(
            `SELECT 'schedule' AS kind, s.id AS target_id, s.label, s.due_on AS close_on, s.pay_on,
                    c.id AS condition_id, c.usage_type, c.work_id, w.title AS work_title,
                    c.counterparty_id, p.name AS party_name
               FROM intake_request_links l
               JOIN condition_schedules s ON s.id = l.target_id
               JOIN conditions c ON c.id = s.condition_id
               LEFT JOIN works w ON w.id = c.work_id LEFT JOIN parties p ON p.id = c.counterparty_id
              WHERE l.request_id = $1 AND l.target_type = 'schedule'
             UNION ALL
             SELECT 'event', e.id, e.period, e.occurred_on, NULL,
                    c.id, c.usage_type, c.work_id, w.title, c.counterparty_id, p.name
               FROM intake_request_links l
               JOIN condition_events e ON e.id = l.target_id
               JOIN conditions c ON c.id = e.condition_id
               LEFT JOIN works w ON w.id = c.work_id LEFT JOIN parties p ON p.id = c.counterparty_id
              WHERE l.request_id = $1 AND l.target_type = 'event'
              ORDER BY 4`, [id])).rows as any[]
        : [];
      const rounds: IntakeRound[] = roundRows.map((x) => ({
        kind: x.kind === "event" ? "event" : "schedule", targetId: Number(x.target_id), label: x.label ?? null,
        closeOn: dateStr(x.close_on), payOn: dateStr(x.pay_on), conditionId: Number(x.condition_id),
        usageType: x.usage_type ?? null, workId: x.work_id ? Number(x.work_id) : null, workTitle: x.work_title ?? null,
        partyId: x.counterparty_id ? Number(x.counterparty_id) : null, partyName: x.party_name ?? null
      }));
      const replies = (await this.database.query(
        `SELECT occurred_at, actor, detail FROM audit_events
          WHERE action = 'intake.reply' AND target_type = 'intake_request' AND target_id = $1
          ORDER BY occurred_at, id`, [id])).rows as any[];
      const matterCandidates = await this.matterCandidates(request);
      // 発注書の案件を候補の先頭に置く。
      if (target?.matter && !matterCandidates.some((m) => m.id === target.matter!.id)) {
        matterCandidates.unshift({ ...target.matter,
          why: `${request.purpose === "inspection" ? "発注書" : "契約書"} ${target.documentNo ?? target.docNo} の案件` });
      }
      return {
        request, matterCandidates,
        duplicateCandidates: await this.duplicateCandidates(request),
        target,
        conditions: linked.map((c) => ({ id: Number(c.id), conditionNo: c.condition_no ?? null, name: String(c.name),
          workId: c.work_id ? Number(c.work_id) : null, workTitle: c.work_title ?? null,
          partyId: c.counterparty_id ? Number(c.counterparty_id) : null })),
        rounds,
        // 依頼 → 作家・作品。繋いだ条件と回から、台帳（作家 × 作品）を並べる。
        ledgers: [...new Map([
          ...linked.filter((c) => c.work_id && c.counterparty_id).map((c) => [`${c.counterparty_id}:${c.work_id}`, {
            partyId: Number(c.counterparty_id), partyName: String(c.party_name ?? ""), workId: Number(c.work_id),
            workTitle: String(c.work_title ?? "") }] as const),
          ...rounds.filter((r) => r.workId && r.partyId).map((r) => [`${r.partyId}:${r.workId}`, {
            partyId: r.partyId!, partyName: r.partyName ?? "", workId: r.workId!, workTitle: r.workTitle ?? "" }] as const)
        ]).values()],
        replies: replies.map((x) => ({
          at: iso(x.occurred_at) ?? "", user: String(x.actor ?? ""), text: String(x.detail?.text ?? "")
        }))
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
