import type { Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { termHistory } from "../agreements/term-history.js";
import { translate } from "../core/errors.js";
import type { MatterAgreementRef, MatterDetail, MatterKind, MatterRef, MatterStatus, MatterSummary } from "../core/model.js";
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
    blockedReason: str(row.blocked_reason),
    documentStyle: (str(row.document_style) as MatterSummary["documentStyle"]) ?? null,
    settled: { fixed: Number(row.fixed_count ?? 0), done: Number(row.done_count ?? 0) },
    mergedIntoId: row.merged_into_id ? Number(row.merged_into_id) : null,
    mergedIntoNo: str(row.merged_into_no),
    work: row.work_id
      ? { id: Number(row.work_id), workCode: str(row.work_code), title: String(row.work_title ?? "") }
      : null,
    businessLine: (str(row.business_line) as MatterSummary["businessLine"]) ?? null,
    businessName: str(row.business_name),
    production: row.production === null || row.production === undefined ? null : Boolean(row.production),
    parentId: row.parent_id ? Number(row.parent_id) : null,
    parentNo: str(row.parent_no),
    parentTitle: str(row.parent_title),
    childCount: Number(row.child_count ?? 0),
    titleManual: row.title_manual !== false,
    remappedFrom: str(row.remapped_from)
  };
}

function mapRef(row: Record<string, any>): MatterRef {
  return {
    id: Number(row.id), matterNo: str(row.matter_no), title: String(row.title ?? ""),
    kind: row.kind as MatterKind, status: row.status as MatterStatus,
    counterparty: str(row.party_name)
  };
}

const SUMMARY_COLUMNS = `
  m.id, m.matter_no, m.title, m.kind, m.status, m.due_on, m.blocked_reason, m.document_style,
  m.merged_into_id, mi.matter_no AS merged_into_no,
  s.name AS owner_name,
  p.id AS party_id, p.name AS party_name, p.kind AS party_kind,
  fx.fixed_count, fx.done_count,
  m.work_id, w.work_code, w.title AS work_title,
  m.business_line, m.business_name, m.production, m.parent_id,
  mp.matter_no AS parent_no, mp.title AS parent_title,
  (SELECT count(*)::int FROM matters k WHERE k.parent_id = m.id) AS child_count,
  m.title_manual, m.remapped_from`;

// 定額の条件が何本あって何本が払い切れたか。一覧に「支払済み」の札を出すため。
const SUMMARY_FROM = `
  FROM matters m
  LEFT JOIN staff   s ON s.id = m.owner_staff_id
  LEFT JOIN parties p ON p.id = m.counterparty_id
  LEFT JOIN matters mi ON mi.id = m.merged_into_id
  LEFT JOIN works   w  ON w.id = m.work_id
  LEFT JOIN matters mp ON mp.id = m.parent_id
  LEFT JOIN LATERAL (
    -- 改訂の予約中は旧版と新版が両方 active なので系列で1本と数え、
    -- 支払の割当は旧版の id に残るので系列の全版で足す。
    SELECT count(DISTINCT COALESCE(c.series_id, c.id))::int AS fixed_count,
           count(DISTINCT COALESCE(c.series_id, c.id))
             FILTER (WHERE c.closed_at IS NOT NULL OR COALESCE(pd.paid, 0) >= c.flat_amount)::int AS done_count
      FROM matter_links ml
      JOIN conditions c ON ml.target_type = 'condition' AND c.id::text = ml.target_ref
      LEFT JOIN LATERAL (
        SELECT sum(al.amount) AS paid FROM payment_allocations al
          JOIN payments y ON y.id = al.payment_id
         WHERE y.status = 'paid'
           AND al.condition_id IN (SELECT x.id FROM conditions x
                                    WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))
      ) pd ON true
     WHERE ml.matter_id = m.id AND c.status = 'active'
       AND c.pricing_model IN ('fixed', 'unit_rate') AND COALESCE(c.flat_amount, 0) > 0
  ) fx ON true`;

export class MatterRepository {
  private readonly conditions: ConditionRepository;
  constructor(private readonly database: Transactable) {
    this.conditions = new ConditionRepository(database);
  }

  async list(query: { keyword?: string; kind?: MatterKind; openOnly?: boolean; limit?: number;
                      /** 親で絞る。プロジェクトの子だけを出す。 */
                      parentId?: number | null } = {}) {
    // 統合済みの案件は一覧に出さない。開けば統合先へ飛ぶ。
    const where: string[] = ["m.merged_into_id IS NULL"];
    const params: unknown[] = [];
    if (query.keyword?.trim()) {
      params.push(`%${query.keyword.trim()}%`);
      const i = params.length;
      where.push(`(m.title ILIKE $${i} OR COALESCE(m.matter_no,'') ILIKE $${i} OR COALESCE(p.name,'') ILIKE $${i})`);
    }
    if (query.kind) { params.push(query.kind); where.push(`m.kind = $${params.length}`); }
    if (query.openOnly) where.push("m.status NOT IN ('done','canceled')");
    if (query.parentId) { params.push(query.parentId); where.push(`m.parent_id = $${params.length}`); }
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

    const [conditions, documents, payments, communications, links, tasks, family, agreements] = await Promise.all([
      // 出版は作品 80 点・条件 170 本で1案件になる。100 だと条件タブに出ない
      // 条件ができ、案件から実績も支払も立てられなくなる。
      this.conditions.list({ matterId: id, limit: 500 }),
      this.documents(id),
      this.payments(id),
      this.communications(id),
      this.links(id),
      this.tasks(id),
      this.family(id, row.parent_id ? Number(row.parent_id) : null),
      this.agreements(id)
    ]);

    return {
      ...mapSummary(row),
      remarks: str(row.remarks),
      driveFolderUrl: str(row.drive_folder_url),
      conditions, documents, payments, communications, links, tasks,
      ...family, agreements
    };
  }

  /** 親・子・関連。案件どうしの繋がり（A-044）。 */
  private async family(id: number, parentId: number | null) {
    const REF = `SELECT m.id, m.matter_no, m.title, m.kind, m.status, p.name AS party_name
                   FROM matters m LEFT JOIN parties p ON p.id = m.counterparty_id`;
    const [parent, children, related] = await Promise.all([
      parentId ? this.database.query(`${REF} WHERE m.id = $1`, [parentId]) : Promise.resolve({ rows: [] as any[] }),
      this.database.query(`${REF} WHERE m.parent_id = $1 ORDER BY m.id`, [id]),
      this.database.query(
        `${REF} WHERE m.id IN (SELECT b_id FROM matter_relations WHERE a_id = $1
                              UNION SELECT a_id FROM matter_relations WHERE b_id = $1)
          ORDER BY m.id`, [id])
    ]);
    return {
      parent: parent.rows[0] ? mapRef(parent.rows[0] as any) : null,
      children: (children.rows as any[]).map(mapRef),
      related: (related.rows as any[]).map(mapRef)
    };
  }

  /**
   * 付帯する契約と、いまの終了日。完了の判定と「継続」の欄に使う。
   * 条件の合意と文書の合意から辿る。補助文書は親に畳んで見る。
   */
  private async agreements(id: number): Promise<MatterAgreementRef[]> {
    const r = await this.database.query(
      `SELECT DISTINCT a.id, a.agreement_no, a.title, a.kind, a.status, a.effective_on, a.executed_on,
              a.expires_on, a.auto_renewal, a.renewal_months, a.renewal_stopped_on, a.terminated_on
         FROM agreements a
        WHERE COALESCE(a.kind, 'master') IN ('master', 'standalone')
          AND (a.id IN (SELECT COALESCE(pa.id, x.id) FROM matter_links ml
                          JOIN conditions c ON ml.target_type = 'condition' AND c.id::text = ml.target_ref
                          JOIN agreements x ON x.id = c.agreement_id
                          LEFT JOIN agreements pa ON pa.id = x.parent_id
                         WHERE ml.matter_id = $1)
            OR a.id IN (SELECT COALESCE(pa.id, x.id) FROM documents d
                          JOIN agreements x ON x.id = d.agreement_id
                          LEFT JOIN agreements pa ON pa.id = x.parent_id
                         WHERE d.matter_id = $1))
        ORDER BY a.id`, [id]);
    const today = new Date().toISOString().slice(0, 10);
    return (r.rows as any[]).map((a) => {
      const h = termHistory({
        termStart: dateStr(a.effective_on) ?? dateStr(a.executed_on), termEnd: dateStr(a.expires_on),
        autoRenew: a.auto_renewal === true, renewMonths: int(a.renewal_months),
        renewStoppedOn: dateStr(a.renewal_stopped_on), terminatedOn: dateStr(a.terminated_on)
      }, today);
      const live = String(a.status) === "executed" && !a.terminated_on
        && (h.currentEnd === null || h.currentEnd >= today);
      return {
        id: Number(a.id), agreementNo: str(a.agreement_no), title: String(a.title ?? ""),
        kind: String(a.kind ?? "master"), status: String(a.status), currentEnd: h.currentEnd, live
      };
    });
  }

  private async documents(id: number) {
    const r = await this.database.query(
      `SELECT d.id, d.document_no, d.status, d.issued_at, v.template_label,
              v.counterparty, v.counterparty_id, t.template_key, a.status AS agreement_status,
              snd.sent_at, snd.sent_via
         FROM documents d
         LEFT JOIN v_document_display v ON v.document_id = d.id
         LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
         LEFT JOIN document_templates t ON t.id = tv.template_id
         LEFT JOIN agreements a ON a.id = d.agreement_id
         -- 送った記録（文書の一覧と同じ引き方）。案件の文書タブで CloudSign の段を出す。
         LEFT JOIN LATERAL (
           SELECT x.occurred_at AS sent_at, split_part(x.action, '.', 1) AS sent_via
             FROM audit_events x
            WHERE x.target_type = 'document' AND x.target_id = d.id
              AND x.action IN ('gmail.send', 'cloudsign.send')
            ORDER BY x.occurred_at DESC LIMIT 1
         ) snd ON true
        WHERE d.matter_id = $1
        ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [id]);
    return r.rows.map((d) => ({
      id: Number(d.id), documentNo: str(d.document_no), status: String(d.status),
      templateLabel: str(d.template_label),
      // 相手先。番号と種別だけでは、どれが誰あての1枚か読めない。
      counterparty: str(d.counterparty),
      // 相手先を絞って見るための id（1案件に20社以上のことがある）。
      counterpartyId: d.counterparty_id ? Number(d.counterparty_id) : null,
      // ひな形の種類。画面が「発注書だけ」を選り分けるのに要る
      // （名前で見分けると「発注書 (国内)」の表記に依存する）。
      templateKey: str(d.template_key),
      issuedAt: d.issued_at ? new Date(String(d.issued_at)).toISOString() : null,
      sentAt: d.sent_at ? new Date(String(d.sent_at)).toISOString() : null,
      sentVia: str(d.sent_via),
      agreementStatus: str(d.agreement_status)
    }));
  }

  /** 支払は案件に属さない（複数案件をまたぐ）。条件の割当経由で辿る。 */
  private async payments(id: number) {
    const r = await this.database.query(
      `SELECT DISTINCT p.id, p.payment_no, p.direction, p.amount, p.currency, p.due_on, p.status,
              p.basis_received_on, p.paid_on, p.note,
              cp.counterparty_id, cp.counterparty_name
         FROM payments p
         JOIN payment_allocations a ON a.payment_id = p.id
         JOIN matter_links ml ON ml.target_type = 'condition'
                             AND ml.target_ref = a.condition_id::text
         -- 支払の相手先。支払そのものは持っていないので、割当先の条件から引く。
         -- 1件の支払は1社あて（条件をまたいでも払い先は同じ）なので先頭でよい。
         LEFT JOIN LATERAL (
           SELECT c.counterparty_id, pt.name AS counterparty_name
             FROM payment_allocations x
             JOIN conditions c ON c.id = x.condition_id
             LEFT JOIN parties pt ON pt.id = c.counterparty_id
            WHERE x.payment_id = p.id AND c.counterparty_id IS NOT NULL
            ORDER BY x.id LIMIT 1
         ) cp ON true
        WHERE ml.matter_id = $1
        ORDER BY p.due_on NULLS LAST, p.id`, [id]);
    return r.rows.map((p) => ({
      id: Number(p.id), paymentNo: str(p.payment_no), direction: p.direction as "in" | "out",
      amount: Number(p.amount ?? 0), currency: String(p.currency ?? "JPY"),
      dueOn: dateStr(p.due_on), status: String(p.status),
      // 管理者が直せる欄（A-041）。画面の修正欄がいまの値を出すのに使う。
      basisReceivedOn: dateStr(p.basis_received_on), paidOn: dateStr(p.paid_on), note: str(p.note),
      // 相手先を絞って見るため（1案件に20社以上のことがある）。
      counterpartyId: p.counterparty_id ? Number(p.counterparty_id) : null,
      counterparty: str(p.counterparty_name)
    }));
  }

  /** 連絡履歴は監査記録から組む（V2 では送信履歴が3系統に分かれていた）。 */
  private async communications(id: number) {
    const r = await this.database.query(
      `SELECT occurred_at, action, actor, detail
         FROM audit_events
        WHERE (target_type = 'matter'
               AND target_id IN (SELECT m.id FROM matters m WHERE m.id = $1 OR m.merged_into_id = $1))
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
