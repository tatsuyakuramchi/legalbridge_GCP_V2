import { type Queryable, type Transactable, dateStr, inTransaction, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { RECEIVED_VIA, SENT_VIA, type ManualReceivedVia, type ManualSentVia } from "../documents/delivery.js";
import {
  buildPayDocRows, countTiles, isTodo, sortRows, TILE_TEST,
  type PayDocRow, type PayDocTile, type PdAllocation, type PdCondition, type PdDocument, type PdDraft,
  type PdEvent, type PdPlan, type PdSchedule, type Trigger
} from "./rows.js";

/**
 * 支払文書（A-074）：計算書・検収書・役務提供完了通知書を、回ごとに
 * 起点 → 文書 → 送付 → 受領 → 支払 まで 1 つの表で見る。
 *
 * 読むのは rows.ts の規則だけ。書くのは送付・受領・過去分・製造予定の記録。
 * 文書を作る・支払を立てる・実績を入れるは、既にある入口（作業テーブル・支払・実績）。
 */

export interface PayDocsQuery {
  partyId?: number | null; workId?: number | null; conditionId?: number | null; matterId?: number | null;
  /** 作品の一覧の数を 1 回で出すとき。 */
  workIds?: number[] | null;
  q?: string | null;
  /** 決済文書の種類（royalty_statement / inspection_certificate / service_completion_notice）。 */
  templateKey?: string | null;
  trigger?: Trigger | null;
  /** 締め月（YYYY-MM）。 */
  month?: string | null;
  view?: "todo" | "all" | "past";
  tile?: PayDocTile | null;
  limit?: number;
}

export interface PayDocsList {
  rows: PayDocRow[];
  tiles: Record<PayDocTile, number>;
  total: number;
  today: string;
}

const CONDITION_SQL = `
  SELECT c.id, c.status, c.condition_no, c.name, c.kind, c.pricing_model, c.usage_type, c.direction,
         c.time_settlement, c.contract_form, c.statement_timing, c.settlement_mode, c.report_due_days,
         p.id AS party_id, p.name AS party_name, w.id AS work_id, w.title AS work_title
    FROM conditions c
    LEFT JOIN parties p ON p.id = c.counterparty_id
    LEFT JOIN works w ON w.id = c.work_id
   WHERE c.status IN ('active', 'scheduled', 'superseded')
     AND c.kind IN ('license', 'product', 'service')`;

export class PayDocsService {
  constructor(private readonly database: Transactable, private readonly today = () => new Date()) {}

  private todayIso(): string {
    return new Date(this.today().getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  }

  /** 範囲の条件から回を組み立てる（絞り込み前）。 */
  async rows(query: PayDocsQuery = {}): Promise<PayDocRow[]> {
    const args: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replaceAll("$?", `$${args.length}`)); };
    if (query.partyId) add("c.counterparty_id = $?", query.partyId);
    if (query.workId) add("c.work_id = $?", query.workId);
    if (query.workIds?.length) add("c.work_id = ANY($?::bigint[])", query.workIds);
    if (query.conditionId) add("c.id = $?", query.conditionId);
    if (query.matterId) add(`EXISTS (SELECT 1 FROM matter_links ml WHERE ml.matter_id = $?
                               AND ml.target_type = 'condition' AND ml.target_ref = c.id::text)`, query.matterId);
    const q = String(query.q ?? "").trim();
    if (q) add(`(c.name ILIKE $? OR COALESCE(c.condition_no, '') ILIKE $? OR COALESCE(p.name, '') ILIKE $?
                 OR COALESCE(w.title, '') ILIKE $?
                 OR EXISTS (SELECT 1 FROM condition_events qe JOIN documents qd ON qd.id = qe.document_id
                             WHERE qe.condition_id = c.id AND qd.document_no ILIKE $?))`, `%${q}%`);
    const cr = await this.database.query(`${CONDITION_SQL}${where.length ? ` AND ${where.join(" AND ")}` : ""}
      ORDER BY c.id`, args);
    const conditions: PdCondition[] = (cr.rows as any[]).map((c) => ({
      id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""), kind: String(c.kind),
      pricingModel: str(c.pricing_model), usageType: str(c.usage_type), direction: c.direction === "out" ? "out" : "in",
      timeSettlement: c.time_settlement === true, contractForm: str(c.contract_form), statementTiming: str(c.statement_timing),
      settlementMode: str(c.settlement_mode), reportDueDays: int(c.report_due_days),
      party: c.party_id ? { id: Number(c.party_id), name: String(c.party_name ?? "") } : null,
      work: c.work_id ? { id: Number(c.work_id), title: String(c.work_title ?? "") } : null
    }));
    const ids = conditions.map((c) => c.id);
    if (!ids.length) return [];
    // 改訂で退いた条件は、実績の付いた回だけ出す（予定だけの回は新しい版が持つ）。
    const superseded = new Set((cr.rows as any[]).filter((c) => c.status === "superseded").map((c) => Number(c.id)));

    const [sr, er, kr, pr] = await Promise.all([
      this.database.query(
        `SELECT id, condition_id, seq, label, due_on, pay_on, planned_amount, trigger_kind
           FROM condition_schedules WHERE condition_id = ANY($1::bigint[])`, [ids]),
      this.database.query(
        `SELECT id, condition_id, schedule_id, event_type, occurred_on, amount, document_id,
                report_received_on, quantity, period
           FROM condition_events WHERE condition_id = ANY($1::bigint[]) AND status = 'active'`, [ids]),
      this.database.query(
        `SELECT condition_id, schedule_id FROM royalty_round_skips WHERE condition_id = ANY($1::bigint[])`, [ids]),
      // 製造予定：開いていて、まだその製造の実績が入っていないもの（予定日の 30 日前から 60 日後までに
      // 製造の実績があれば、入ったとみなして出さない）。
      this.database.query(
        `SELECT pl.id, pl.condition_id, pl.planned_on, pl.quantity, pl.label, pl.source, sd.document_no AS source_no
           FROM production_plans pl
           LEFT JOIN documents sd ON sd.id = pl.source_document_id
          WHERE pl.condition_id = ANY($1::bigint[]) AND pl.status = 'open'
            AND NOT EXISTS (SELECT 1 FROM condition_events e
                             WHERE e.condition_id = pl.condition_id AND e.status = 'active'
                               AND e.event_type = 'manufacturing'
                               AND e.occurred_on BETWEEN pl.planned_on - 30 AND pl.planned_on + 60)`, [ids])
    ]);
    const schedules: PdSchedule[] = (sr.rows as any[]).map((s) => ({
      id: Number(s.id), conditionId: Number(s.condition_id), seq: Number(s.seq ?? 0), label: str(s.label),
      dueOn: dateStr(s.due_on), payOn: dateStr(s.pay_on), plannedAmount: num(s.planned_amount),
      triggerKind: String(s.trigger_kind ?? "periodic")
    }));
    const events: PdEvent[] = (er.rows as any[]).map((e) => ({
      id: Number(e.id), conditionId: Number(e.condition_id), scheduleId: int(e.schedule_id),
      eventType: String(e.event_type), occurredOn: dateStr(e.occurred_on) ?? "", amount: Number(e.amount ?? 0),
      documentId: int(e.document_id), reportReceivedOn: dateStr(e.report_received_on),
      quantity: num(e.quantity), period: str(e.period)
    }));
    const eventIds = events.map((e) => e.id);
    const docIds = [...new Set(events.map((e) => e.documentId).filter((x): x is number => !!x))];

    const [dr, fr, ar] = await Promise.all([
      docIds.length ? this.database.query(
        `SELECT d.id, d.document_no, d.status, d.inbound, (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date AS issued_on,
                COALESCE(t.template_key, '') AS template_key,
                (jsonb_typeof(d.rendered_values) = 'object'
                   AND d.rendered_values->>'needsSignature' IN ('true')) AS needs_signature,
                dv.sent_at, dv.sent_via, dv.received_at, dv.received_via, dv.past
           FROM documents d
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
           LEFT JOIN LATERAL document_delivery(d.id) dv ON true
          WHERE d.id = ANY($1::bigint[])`, [docIds]) : Promise.resolve({ rows: [] }),
      eventIds.length ? this.database.query(
        `SELECT d.id, d.manual_inputs->'_eventIds' AS event_ids FROM documents d
          WHERE d.status = 'draft' AND jsonb_typeof(d.manual_inputs->'_eventIds') = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.manual_inputs->'_eventIds') x
                         WHERE x ~ '^[0-9]+$' AND x::bigint = ANY($1::bigint[]))`, [eventIds]) : Promise.resolve({ rows: [] }),
      eventIds.length ? this.database.query(
        `SELECT a.event_id, a.payment_id, y.payment_no, y.status, y.due_on, y.paid_on
           FROM payment_allocations a JOIN payments y ON y.id = a.payment_id
          WHERE a.event_id = ANY($1::bigint[])`, [eventIds]) : Promise.resolve({ rows: [] })
    ]);
    const documents: PdDocument[] = (dr.rows as any[]).map((d) => ({
      id: Number(d.id), documentNo: str(d.document_no), status: String(d.status), templateKey: str(d.template_key),
      issuedOn: dateStr(d.issued_on),
      sentAt: d.sent_at ? new Date(String(d.sent_at)).toISOString() : null, sentVia: str(d.sent_via),
      receivedAt: d.received_at ? new Date(String(d.received_at)).toISOString() : null, receivedVia: str(d.received_via),
      past: d.past === true, inbound: d.inbound === true, needsSignature: d.needs_signature === true
    }));
    const drafts: PdDraft[] = (fr.rows as any[]).map((d) => ({
      id: Number(d.id), eventIds: (Array.isArray(d.event_ids) ? d.event_ids : []).map(Number).filter(Number.isFinite)
    }));
    const allocations: PdAllocation[] = (ar.rows as any[]).map((a) => ({
      eventId: Number(a.event_id), paymentId: Number(a.payment_id), paymentNo: str(a.payment_no),
      status: String(a.status), dueOn: dateStr(a.due_on), paidOn: dateStr(a.paid_on)
    }));
    const plans: PdPlan[] = (pr.rows as any[]).map((p) => ({
      id: Number(p.id), conditionId: Number(p.condition_id), plannedOn: dateStr(p.planned_on) ?? "",
      quantity: num(p.quantity), label: str(p.label), source: p.source === "order" ? "order" : "manual",
      sourceDocumentNo: str(p.source_no)
    }));
    const skips = (kr.rows as any[]).map((k) => ({ conditionId: Number(k.condition_id), scheduleId: Number(k.schedule_id) }));
    return buildPayDocRows({ conditions, schedules, events, documents, drafts, allocations, plans, skips,
                             today: this.todayIso() })
      .filter((r) => !superseded.has(r.condition.id) || r.eventIds.length > 0);
  }

  async list(query: PayDocsQuery = {}): Promise<PayDocsList> {
    try {
      const today = this.todayIso();
      const all = await this.rows(query);
      // 締め前の回は、半年より先は出さない（期間で決まる条件は何年分も並ぶ）。
      const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 183 * 86_400_000).toISOString().slice(0, 10);
      let rows = all.filter((r) => !(r.source.state === "before" && r.closeOn && r.closeOn > horizon));
      if (query.templateKey) {
        rows = rows.filter((r) => r.templateKey === query.templateKey
          || r.doc.documents.some((d) => d.templateKey === query.templateKey));
      }
      if (query.trigger) rows = rows.filter((r) => r.trigger === query.trigger);
      if (query.month && /^\d{4}-\d{2}$/.test(query.month)) rows = rows.filter((r) => (r.closeOn ?? "").startsWith(query.month!));
      const tiles = countTiles(rows);
      const view = query.view ?? "todo";
      if (view === "todo") rows = rows.filter(isTodo);
      if (view === "past") rows = rows.filter((r) => r.past);
      if (query.tile && TILE_TEST[query.tile]) rows = rows.filter((r) => !r.past && TILE_TEST[query.tile!](r));
      const sorted = sortRows(rows);
      return { rows: sorted.slice(0, query.limit ?? 500), tiles, total: sorted.length, today };
    } catch (error) { throw translate(error); }
  }

  /** 作品ごとの数（作品の検索結果に出す）。 */
  async countsByWork(workIds: number[]): Promise<Map<number, { make: number; unsent: number; await: number; overdue: number; wait: number; rounds: number }>> {
    const out = new Map<number, { make: number; unsent: number; await: number; overdue: number; wait: number; rounds: number }>();
    if (!workIds.length) return out;
    const all = (await this.rows({ workIds })).filter((r) => r.source.state !== "before" && !r.past);
    for (const id of workIds) {
      const rows = all.filter((r) => r.work?.id === id);
      const t = countTiles(rows);
      out.set(id, { make: t.make + t.draft, unsent: t.unsent, await: t.await, overdue: t.overdue, wait: t.wait,
                    rounds: rows.length });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 送付・受領
  // -------------------------------------------------------------------------

  private async issuedDocs(client: Queryable, ids: number[]): Promise<Array<{ id: number; documentNo: string; matterId: number | null }>> {
    if (!ids.length) throw new DomainError("VALIDATION", "文書を選んでください");
    const r = await client.query(
      `SELECT id, document_no, status, matter_id FROM documents WHERE id = ANY($1::bigint[])`, [ids]);
    const rows = r.rows as any[];
    const missing = ids.filter((id) => !rows.some((x) => Number(x.id) === id));
    if (missing.length) throw new DomainError("NOT_FOUND", `文書が見つかりません（${missing.join(", ")}）`);
    const notIssued = rows.filter((x) => x.status !== "issued");
    if (notIssued.length) {
      throw new DomainError("VALIDATION",
        `決定していない文書は送付・受領を記録できません（${notIssued.map((x) => x.document_no ?? `#${x.id}`).join("、")}）`);
    }
    return rows.map((x) => ({ id: Number(x.id), documentNo: String(x.document_no ?? ""), matterId: int(x.matter_id) }));
  }

  /** 送付済みにする（システムの外で送ったもの）。 */
  async markSent(ids: number[], input: { via: string; on?: string | null; memo?: string | null }, actor: string) {
    const via = SENT_VIA.includes(input.via as ManualSentVia) ? input.via : null;
    if (!via) throw new DomainError("VALIDATION", "送り方を選んでください（郵送・手渡し・別のメール・CloudSign の画面・その他）");
    const on = validDate(input.on);
    try {
      return await inTransaction(this.database, async (client) => {
        const docs = await this.issuedDocs(client, ids);
        for (const d of docs) {
          await recordAudit(client, {
            actor, action: "document.sent_manual", targetType: "document", targetId: d.id,
            occurredAt: on ? `${on}T12:00:00+09:00` : null,
            detail: { via, memo: str(input.memo), documentNo: d.documentNo }
          });
        }
        return { count: docs.length };
      });
    } catch (error) { throw translate(error); }
  }

  async clearSent(id: number, reason: string | null, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const [d] = await this.issuedDocs(client, [id]);
        await recordAudit(client, { actor, action: "document.send_cleared", targetType: "document", targetId: d.id,
                                    detail: { reason: str(reason), documentNo: d.documentNo } });
        return { ok: true };
      });
    } catch (error) { throw translate(error); }
  }

  /** 受領を記録（署名済みの控え・返信・口頭）。 */
  async recordReceipt(ids: number[], input: { via: string; on?: string | null; memo?: string | null }, actor: string) {
    const via = RECEIVED_VIA.includes(input.via as ManualReceivedVia) ? input.via : null;
    if (!via) throw new DomainError("VALIDATION", "受け取り方を選んでください（署名済みの控え・メールの返信・口頭・その他）");
    const on = validDate(input.on);
    try {
      return await inTransaction(this.database, async (client) => {
        const docs = await this.issuedDocs(client, ids);
        for (const d of docs) {
          await recordAudit(client, {
            actor, action: "document.received", targetType: "document", targetId: d.id,
            occurredAt: on ? `${on}T12:00:00+09:00` : null,
            detail: { via, memo: str(input.memo), documentNo: d.documentNo }
          });
        }
        return { count: docs.length };
      });
    } catch (error) { throw translate(error); }
  }

  async clearReceipt(id: number, reason: string | null, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const [d] = await this.issuedDocs(client, [id]);
        await recordAudit(client, { actor, action: "document.receipt_cleared", targetType: "document", targetId: d.id,
                                    detail: { reason: str(reason), documentNo: d.documentNo } });
        return { ok: true };
      });
    } catch (error) { throw translate(error); }
  }

  /** 相手から受け取った文書（送付・受領を追わない）にする／戻す。 */
  async setInbound(id: number, inbound: boolean, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(`UPDATE documents SET inbound = $2 WHERE id = $1 RETURNING document_no`, [id, inbound]);
        if (!r.rowCount) throw new DomainError("NOT_FOUND", "文書が見つかりません");
        await recordAudit(client, { actor, action: "document.inbound", targetType: "document", targetId: id,
                                    detail: { inbound, documentNo: str((r.rows[0] as any).document_no) } });
        return { ok: true };
      });
    } catch (error) { throw translate(error); }
  }

  // -------------------------------------------------------------------------
  // 過去分
  // -------------------------------------------------------------------------

  /**
   * 過去分の候補：決定済み・送付の記録なし・相手から受け取った文書でない、のうち
   *   V1 から移した文書（legacy_id あり）か、境目の日より前に決定した文書。
   * 境目の既定は「V3 で最初に作った文書（ひな形あり・移行でない・一括でない）の決定日」。
   */
  private pastWhere(): string {
    return `d.status = 'issued' AND NOT d.inbound
        AND (SELECT dv.sent_at FROM document_delivery(d.id) dv) IS NULL
        AND (d.legacy_id IS NOT NULL OR d.issued_at < $1::date)`;
  }

  async pastCutoff(): Promise<string | null> {
    const r = await this.database.query(
      `SELECT min((issued_at AT TIME ZONE 'Asia/Tokyo')::date) AS first FROM documents
        WHERE status IN ('issued', 'superseded') AND template_version_id IS NOT NULL
          AND legacy_id IS NULL AND batch_id IS NULL`);
    return dateStr((r.rows[0] as any)?.first);
  }

  async pastPreview(cutoff?: string | null) {
    try {
      const on = validDate(cutoff) ?? (await this.pastCutoff()) ?? this.todayIso();
      const r = await this.database.query(
        `SELECT count(*) FILTER (WHERE d.legacy_id IS NOT NULL)::int AS legacy,
                count(*) FILTER (WHERE d.legacy_id IS NULL AND d.template_version_id IS NULL)::int AS imported,
                count(*) FILTER (WHERE d.legacy_id IS NULL AND d.template_version_id IS NOT NULL AND d.batch_id IS NOT NULL)::int AS batch,
                count(*) FILTER (WHERE d.legacy_id IS NULL AND d.template_version_id IS NOT NULL AND d.batch_id IS NULL)::int AS other,
                count(*)::int AS total
           FROM documents d WHERE ${this.pastWhere()}`, [on]);
      const inbound = await this.database.query(`SELECT count(*)::int AS n FROM documents WHERE inbound AND status = 'issued'`);
      const row = r.rows[0] as any;
      return { cutoff: on, legacy: Number(row.legacy), imported: Number(row.imported), batch: Number(row.batch),
               other: Number(row.other), total: Number(row.total), inbound: Number((inbound.rows[0] as any).n) };
    } catch (error) { throw translate(error); }
  }

  async pastSample(cutoff?: string | null, limit = 50) {
    const on = validDate(cutoff) ?? (await this.pastCutoff()) ?? this.todayIso();
    const r = await this.database.query(
      `SELECT d.id, d.document_no, (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date AS issued_on,
              COALESCE(v.template_label, d.manual_inputs->>'documentKind') AS label, v.counterparty,
              (d.legacy_id IS NOT NULL) AS legacy, (d.template_version_id IS NULL) AS imported
         FROM documents d JOIN v_document_display v ON v.document_id = d.id
        WHERE ${this.pastWhere()}
        ORDER BY d.issued_at DESC NULLS LAST, d.id DESC LIMIT $2`, [on, limit]);
    return (r.rows as any[]).map((d) => ({ id: Number(d.id), documentNo: str(d.document_no), issuedOn: dateStr(d.issued_on),
      label: str(d.label), counterparty: str(d.counterparty), legacy: d.legacy === true, imported: d.imported === true }));
  }

  /** 過去分にする。送付日は決定日。受領も付けるなら同じ日で。 */
  async markPast(input: { cutoff?: string | null; receipt?: boolean }, actor: string) {
    try {
      const on = validDate(input.cutoff) ?? (await this.pastCutoff()) ?? this.todayIso();
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `SELECT d.id, d.document_no, COALESCE(d.issued_at, d.created_at) AS at FROM documents d
            WHERE ${this.pastWhere()} FOR UPDATE OF d`, [on]);
        const rows = r.rows as any[];
        for (const d of rows) {
          const at = new Date(String(d.at)).toISOString();
          await recordAudit(client, { actor, action: "document.sent_manual", targetType: "document", targetId: Number(d.id),
                                      occurredAt: at, detail: { via: "past", cutoff: on, documentNo: str(d.document_no) } });
          if (input.receipt !== false) {
            await recordAudit(client, { actor, action: "document.received", targetType: "document", targetId: Number(d.id),
                                        occurredAt: at, detail: { via: "past", cutoff: on, documentNo: str(d.document_no) } });
          }
        }
        await recordAudit(client, { actor, action: "paydocs.mark_past", targetType: "system",
                                    detail: { cutoff: on, count: rows.length, receipt: input.receipt !== false } });
        return { cutoff: on, count: rows.length };
      });
    } catch (error) { throw translate(error); }
  }

  // -------------------------------------------------------------------------
  // 製造予定（手で入れる＋発注書からの候補）
  // -------------------------------------------------------------------------

  async addPlan(input: { conditionId: number; plannedOn: string; quantity?: number | null; label?: string | null;
                         note?: string | null; sourceDocumentId?: number | null }, actor: string) {
    const on = validDate(input.plannedOn);
    if (!on) throw new DomainError("VALIDATION", "製造予定日を入れてください");
    try {
      return await inTransaction(this.database, async (client) => {
        const c = await client.query(`SELECT id FROM conditions WHERE id = $1`, [input.conditionId]);
        if (!c.rowCount) throw new DomainError("NOT_FOUND", "条件明細が見つかりません");
        const r = await client.query(
          `INSERT INTO production_plans (condition_id, planned_on, quantity, label, note, source, source_document_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (condition_id, source_document_id) WHERE source_document_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [input.conditionId, on, input.quantity ?? null, str(input.label), str(input.note),
           input.sourceDocumentId ? "order" : "manual", input.sourceDocumentId ?? null, actor]);
        const id = int((r.rows[0] as any)?.id);
        if (id) {
          await recordAudit(client, { actor, action: "production_plan.add", targetType: "condition", targetId: input.conditionId,
                                      detail: { planId: id, plannedOn: on, quantity: input.quantity ?? null,
                                                sourceDocumentId: input.sourceDocumentId ?? null } });
        }
        return { id, created: !!id };
      });
    } catch (error) { throw translate(error); }
  }

  async dropPlan(id: number, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE production_plans SET status = 'dropped' WHERE id = $1 AND status = 'open' RETURNING condition_id`, [id]);
        if (!r.rowCount) throw new DomainError("NOT_FOUND", "開いている製造予定が見つかりません");
        await recordAudit(client, { actor, action: "production_plan.drop", targetType: "condition",
                                    targetId: Number((r.rows[0] as any).condition_id), detail: { planId: id } });
        return { ok: true };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 発注書からの製造予定の候補（ハイブリッド）。
   * 作品に紐づく印刷・製造の発注書（決定済み）があり、同じ作品の刷ごと・出来事ごとの許諾料の
   * 条件に、その発注のあとの製造の実績も予定も無いものを候補にする。予定日は発注の納期
   * （回の予定日）、無ければ発注日の 30 日後。
   */
  async planCandidates(scope: { workId?: number | null; partyId?: number | null } = {}) {
    try {
      const args: unknown[] = [];
      const narrow: string[] = [];
      if (scope.workId) { args.push(scope.workId); narrow.push(`lc.work_id = $${args.length}`); }
      if (scope.partyId) { args.push(scope.partyId); narrow.push(`lc.counterparty_id = $${args.length}`); }
      const r = await this.database.query(
        `SELECT DISTINCT ON (lc.id, d.id)
                lc.id AS condition_id, lc.name AS condition_name, p.name AS party_name,
                w.id AS work_id, w.title AS work_title,
                d.id AS document_id, d.document_no, (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date AS ordered_on,
                oc.name AS order_name, oc.quantity,
                COALESCE((SELECT min(s.due_on) FROM condition_schedules s WHERE s.condition_id = oc.id),
                         ((d.issued_at AT TIME ZONE 'Asia/Tokyo')::date + 30)) AS planned_on
           FROM documents d
           JOIN document_templates t ON t.id = (SELECT tv.template_id FROM document_template_versions tv WHERE tv.id = d.template_version_id)
           JOIN document_conditions dc ON dc.document_id = d.id
           JOIN conditions oc ON oc.id = dc.condition_id
           JOIN conditions lc ON lc.work_id = oc.work_id AND lc.id <> oc.id
           JOIN works w ON w.id = lc.work_id
           LEFT JOIN parties p ON p.id = lc.counterparty_id
          WHERE d.status = 'issued' AND t.template_key IN ('purchase_order', 'intl_purchase_order')
            AND oc.work_id IS NOT NULL
            AND (oc.name || ' ' || COALESCE(oc.spec, '')) ~ '(印刷|製造|増刷|重版|刷)'
            AND lc.kind IN ('license', 'product') AND lc.direction = 'in' AND lc.status = 'active'
            AND (lc.statement_timing = 'event' OR lc.settlement_mode = 'open'
                 OR (lc.statement_timing IS NULL AND lc.settlement_mode IS NULL AND lc.usage_type = 'pub_print'))
            AND d.issued_at > now() - interval '1 year'
            AND NOT EXISTS (SELECT 1 FROM production_plans pl
                             WHERE pl.condition_id = lc.id AND (pl.source_document_id = d.id
                                   OR pl.planned_on >= (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date - 30))
            AND NOT EXISTS (SELECT 1 FROM condition_events e
                             WHERE e.condition_id = lc.id AND e.status = 'active' AND e.event_type = 'manufacturing'
                               AND e.occurred_on >= (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date - 30)
            ${narrow.length ? `AND ${narrow.join(" AND ")}` : ""}
          ORDER BY lc.id, d.id`, args);
      return (r.rows as any[]).map((x) => ({
        conditionId: Number(x.condition_id), conditionName: String(x.condition_name ?? ""), partyName: str(x.party_name),
        work: { id: Number(x.work_id), title: String(x.work_title ?? "") },
        documentId: Number(x.document_id), documentNo: str(x.document_no), orderedOn: dateStr(x.ordered_on),
        orderName: str(x.order_name), quantity: num(x.quantity), plannedOn: dateStr(x.planned_on)
      }));
    } catch (error) { throw translate(error); }
  }
}

function validDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}
