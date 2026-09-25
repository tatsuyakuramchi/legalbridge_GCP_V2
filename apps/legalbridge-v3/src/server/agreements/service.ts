import { type Queryable, type Transactable, inTransaction, dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { termHistory, type TermEvent, type TermHistory, type TermInput } from "./term-history.js";

/**
 * 契約（合意）。
 *
 * 「合意」は締結の事実と期間を持つ器。「文書」は出力物。「条件」は金額。
 * これまで合意は V2 から移した器しか無く、画面からは作れなかった。
 * 新しい相手と契約を結んでも合意が立たず、条件は契約なしのまま、
 * 工程「基本契約の確認」は未済のまま、契約チェックは「なし」のままだった。
 *
 * 作られ方を 3 通りに固定する。
 *   ① 外で結んだ契約を人が登録する（ここ）
 *   ② 条件書（個別利用許諾条件書・出版条件書）を決定したとき自動で起こす
 *   ③ 発注書・検収書・計算書は合意にしない（基本契約の下の個別取引）
 *
 * 番号：基本契約 ARC-SVC／ARC-LIC、単体契約 ARC-ISA／ARC-ILT、
 *       補助文書・解除合意は親番号＋枝番（-S01／-T01）、文書だけは番号なし。
 */

export type AgreementKind = "master" | "standalone" | "supplement" | "termination" | "document";
export type AgreementDomain = "service" | "license";

export const KIND_LABEL: Record<AgreementKind, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "補助文書",
  termination: "解除合意", document: "文書だけ"
};

/** 番号の頭。domain × kind で決まる。 */
export function numberPrefix(kind: AgreementKind, domain: AgreementDomain | null): string | null {
  if (kind === "master") return domain === "license" ? "ARC-LIC" : "ARC-SVC";
  if (kind === "standalone") return domain === "license" ? "ARC-ILT" : "ARC-ISA";
  return null;
}

export interface AgreementInput {
  counterpartyId: number;
  direction: "in" | "out";
  kind: AgreementKind;
  domain?: AgreementDomain | null;
  /** 補助文書・解除合意の親。 */
  parentId?: number | null;
  title: string;
  status?: "draft" | "negotiating" | "executed" | null;
  executedOn?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  autoRenewal?: boolean | null;
  renewalMonths?: number | null;
  renewalNoticeMonths?: number | null;
  counterpartyRefNo?: string | null;
  /** 契約書の現物（Drive リンク）。 */
  sourceUrl?: string | null;
}

export interface AgreementRow {
  id: number; agreementNo: string | null; title: string; direction: "in" | "out";
  kind: AgreementKind; domain: AgreementDomain | null; parentId: number | null;
  status: string; executedOn: string | null; effectiveOn: string | null; expiresOn: string | null;
  autoRenewal: boolean; renewalMonths: number | null; renewalNoticeMonths: number | null;
  renewalStoppedOn: string | null; terminatedOn: string | null;
  counterpartyRefNo: string | null; sourceUrl: string | null;
  counterparty: { id: number; name: string };
  conditionCount: number; documentCount: number; totalFlat: number;
  /** いまの終了日（更新履歴の最終行）。 */
  currentEnd: string | null;
  renewals: number;
}

export interface TerminateInput {
  on: string;
  /** whole 契約ごと終える／conditions 一部の条件だけ */
  scope: "whole" | "conditions";
  conditionIds?: number[];
  reason: string;
  sourceUrl?: string | null;
}

export interface TerminatePlanLine {
  conditionId: number; conditionNo: string | null; name: string;
  currentEnd: string | null; newEnd: string;
  /** 解除日より後の予定（実績の付いていないもの）。取り消す。 */
  schedulesToRemove: number;
  events: number; unpaidPayments: number;
}

const HEAD = `
  SELECT a.id, a.agreement_no, a.title, a.direction, a.status, a.kind, a.domain, a.parent_id,
         a.executed_on, a.effective_on, a.expires_on, a.auto_renewal, a.renewal_months,
         a.renewal_notice_months, a.renewal_stopped_on, a.terminated_on,
         a.counterparty_ref_no, a.source_url,
         p.id AS party_id, p.name AS party_name,
         (SELECT count(*) FROM conditions c WHERE c.agreement_id = a.id)::int AS condition_count,
         (SELECT count(*) FROM documents d WHERE d.agreement_id = a.id)::int AS document_count,
         (SELECT COALESCE(sum(c.flat_amount), 0) FROM conditions c
           WHERE c.agreement_id = a.id AND c.status = 'active')::bigint AS total_flat
    FROM agreements a JOIN parties p ON p.id = a.counterparty_id`;

export class AgreementService {
  constructor(private readonly database: Transactable) {}

  // -------------------------------------------------------------------
  // 読む
  // -------------------------------------------------------------------

  async list(query: { keyword?: string; partyId?: number | null; executedOnly?: boolean } = {})
    : Promise<AgreementRow[]> {
    const q = String(query.keyword ?? "").trim();
    try {
      const r = await this.database.query(
        `${HEAD}
          WHERE ($1 = '' OR a.title ILIKE $1 OR COALESCE(a.agreement_no,'') ILIKE $1 OR p.name ILIKE $1)
            AND ($2::bigint IS NULL OR a.counterparty_id = $2
                 OR a.counterparty_id IN (SELECT party_id FROM v_party_resolved WHERE resolved_id = $2))
            AND ($3::boolean = false OR a.status = 'executed')
          ORDER BY COALESCE(a.parent_id, a.id) DESC, a.parent_id NULLS FIRST, a.id
          LIMIT 300`,
        [q ? `%${q}%` : "", query.partyId ?? null, query.executedOnly === true]);
      const rows = r.rows as any[];
      const events = await this.eventsFor(this.database, "agreement", rows.map((x) => Number(x.id)));
      return rows.map((row) => mapRow(row, events.get(Number(row.id)) ?? []));
    } catch (error) { throw translate(error); }
  }

  async find(id: number): Promise<{
    agreement: AgreementRow; parent: AgreementRow | null; children: AgreementRow[];
    history: TermHistory;
  } | null> {
    try {
      const r = await this.database.query(`${HEAD} WHERE a.id = $1`, [id]);
      const row = r.rows[0] as any;
      if (!row) return null;
      const kids = await this.database.query(`${HEAD} WHERE a.parent_id = $1 ORDER BY a.id`, [id]);
      const ids = [Number(row.id), ...(kids.rows as any[]).map((x) => Number(x.id))];
      if (row.parent_id) ids.push(Number(row.parent_id));
      const events = await this.eventsFor(this.database, "agreement", ids);
      const agreement = mapRow(row, events.get(Number(row.id)) ?? []);
      let parent: AgreementRow | null = null;
      if (row.parent_id) {
        const pr = await this.database.query(`${HEAD} WHERE a.id = $1`, [Number(row.parent_id)]);
        if (pr.rows[0]) parent = mapRow(pr.rows[0] as any, events.get(Number(row.parent_id)) ?? []);
      }
      return {
        agreement, parent,
        children: (kids.rows as any[]).map((k) => mapRow(k, events.get(Number(k.id)) ?? [])),
        history: historyOf(row, events.get(Number(row.id)) ?? [])
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 条件登録で相手先を選んだときの候補。締結済みの基本契約・単体契約だけ。
   * 1 本なら画面が自動で入れる。無ければ「契約を登録する／契約なしで続ける」。
   */
  async candidatesFor(partyId: number): Promise<AgreementRow[]> {
    const rows = await this.list({ partyId, executedOnly: true });
    return rows.filter((a) => (a.kind === "master" || a.kind === "standalone") && !a.terminatedOn);
  }

  /** 更新の記録を対象ごとにまとめて引く。 */
  async eventsFor(
    client: Queryable, targetType: "agreement" | "condition", ids: number[]
  ): Promise<Map<number, TermEvent[]>> {
    const out = new Map<number, TermEvent[]>();
    if (!ids.length) return out;
    const r = await client.query(
      `SELECT e.target_id, e.kind, e.on_date, e.new_end, e.note, a.agreement_no
         FROM term_events e LEFT JOIN agreements a ON a.id = e.ref_agreement_id
        WHERE e.target_type = $1 AND e.target_id = ANY($2::bigint[])
        ORDER BY e.on_date, e.id`, [targetType, ids]);
    for (const row of r.rows as any[]) {
      const id = Number(row.target_id);
      const list = out.get(id) ?? [];
      list.push({ kind: row.kind, onDate: dateStr(row.on_date)!, newEnd: dateStr(row.new_end),
                  basis: str(row.agreement_no) ?? str(row.note) });
      out.set(id, list);
    }
    return out;
  }

  // -------------------------------------------------------------------
  // 作る・直す
  // -------------------------------------------------------------------

  async create(input: AgreementInput, actor: string): Promise<{ id: number; agreementNo: string | null }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "件名を入れてください");
    if (!["master", "standalone", "supplement", "termination", "document"].includes(input.kind)) {
      throw new DomainError("VALIDATION", "契約の種類が読めません");
    }
    if ((input.kind === "master" || input.kind === "standalone") && !input.domain) {
      throw new DomainError("VALIDATION", "種別（業務委託／ライセンス）を選んでください。番号の頭が決まります");
    }
    if ((input.kind === "supplement" || input.kind === "termination") && !input.parentId) {
      throw new DomainError("VALIDATION", "補助文書・解除合意は親の契約（基本契約か単体契約）を選んでください");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const party = await client.query("SELECT id, name FROM parties WHERE id = $1", [input.counterpartyId]);
        if (!party.rows[0]) throw new DomainError("NOT_FOUND", `取引先 ${input.counterpartyId} が見つかりません`);

        let parent: any = null;
        if (input.parentId) {
          const pr = await client.query(
            "SELECT id, agreement_no, kind, counterparty_id, domain, direction FROM agreements WHERE id = $1",
            [input.parentId]);
          parent = pr.rows[0];
          if (!parent) throw new DomainError("NOT_FOUND", `親の契約 ${input.parentId} が見つかりません`);
          if (parent.kind !== "master" && parent.kind !== "standalone") {
            throw new DomainError("VALIDATION", "親にできるのは基本契約か単体契約だけです");
          }
          if (int(parent.counterparty_id) !== input.counterpartyId) {
            throw new DomainError("VALIDATION", "親の契約と相手先が違います");
          }
        }
        const agreementNo = await this.numberFor(client, input.kind, input.domain ?? (parent?.domain ?? null), parent);
        const status = input.status ?? (input.executedOn ? "executed" : "negotiating");
        const r = await client.query(
          `INSERT INTO agreements
             (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id,
              executed_on, effective_on, expires_on, auto_renewal, renewal_months, renewal_notice_months,
              counterparty_ref_no, source_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::date, $12, $13, $14, $15, $16)
           RETURNING id`,
          [agreementNo, title, input.counterpartyId, input.direction, status, input.kind,
           input.domain ?? parent?.domain ?? null, input.parentId ?? null,
           input.executedOn ?? null, input.effectiveOn ?? input.executedOn ?? null, input.expiresOn ?? null,
           input.autoRenewal === true, input.renewalMonths ?? null, input.renewalNoticeMonths ?? null,
           str(input.counterpartyRefNo), str(input.sourceUrl)]);
        const id = Number((r.rows[0] as { id: number }).id);
        await recordAudit(client, {
          actor, action: "agreement.create", targetType: "agreement", targetId: id,
          detail: { agreementNo, kind: input.kind, domain: input.domain ?? null,
                    parentId: input.parentId ?? null, counterpartyId: input.counterpartyId, status }
        });
        return { id, agreementNo };
      });
    } catch (error) { throw translate(error); }
  }

  /** 番号。基本・単体は年の通し、補助・解除は親番号＋枝番、文書だけは無し。 */
  private async numberFor(
    client: Queryable, kind: AgreementKind, domain: AgreementDomain | null, parent: any
  ): Promise<string | null> {
    const prefix = numberPrefix(kind, domain);
    if (prefix) {
      return allocateNumber(client, { prefix, table: "agreements", column: "agreement_no", width: 4 });
    }
    if (kind === "supplement" || kind === "termination") {
      const base = str(parent?.agreement_no) ?? `#${parent?.id}`;
      const mark = kind === "supplement" ? "S" : "T";
      const used = await client.query(
        `SELECT count(*)::int AS n FROM agreements WHERE parent_id = $1 AND kind = $2`,
        [Number(parent.id), kind]);
      const n = Number((used.rows[0] as { n: number }).n) + 1;
      return `${base}-${mark}${String(n).padStart(2, "0")}`;
    }
    return null;
  }

  async update(id: number, patch: Partial<AgreementInput>, actor: string): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown, cast = "") => { vals.push(v); cols.push(`${col} = $${vals.length}${cast}`); };
    if (patch.title !== undefined) {
      const t = String(patch.title ?? "").trim();
      if (!t) throw new DomainError("VALIDATION", "件名を空にはできません");
      put("title", t);
    }
    if (patch.domain !== undefined) put("domain", patch.domain ?? null);
    if (patch.executedOn !== undefined) put("executed_on", patch.executedOn ?? null, "::date");
    if (patch.effectiveOn !== undefined) put("effective_on", patch.effectiveOn ?? null, "::date");
    if (patch.expiresOn !== undefined) put("expires_on", patch.expiresOn ?? null, "::date");
    if (patch.autoRenewal !== undefined) put("auto_renewal", patch.autoRenewal === true);
    if (patch.renewalMonths !== undefined) put("renewal_months", patch.renewalMonths ?? null);
    if (patch.renewalNoticeMonths !== undefined) put("renewal_notice_months", patch.renewalNoticeMonths ?? null);
    if (patch.counterpartyRefNo !== undefined) put("counterparty_ref_no", str(patch.counterpartyRefNo));
    if (patch.sourceUrl !== undefined) put("source_url", str(patch.sourceUrl));
    if (patch.status !== undefined && patch.status) put("status", patch.status);
    if (!cols.length) return;
    vals.push(id);
    try {
      await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE agreements SET ${cols.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING id`, vals);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await recordAudit(client, { actor, action: "agreement.update", targetType: "agreement", targetId: id,
                                    detail: { fields: Object.keys(patch) } });
      });
    } catch (error) { throw translate(error); }
  }

  /** 締結を記録する。文書からでも契約からでもできる（外で結んだ契約には文書が無い）。 */
  async execute(id: number, input: { on?: string | null; note?: string | null }, actor: string): Promise<void> {
    try {
      await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE agreements
              SET status = 'executed',
                  executed_on = COALESCE($2::date, executed_on, current_date),
                  effective_on = COALESCE(effective_on, $2::date, current_date),
                  updated_at = now()
            WHERE id = $1 RETURNING agreement_no`, [id, input.on ?? null]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await recordAudit(client, { actor, action: "agreement.execute", targetType: "agreement", targetId: id,
                                    detail: { on: input.on ?? null, note: str(input.note) } });
      });
    } catch (error) { throw translate(error); }
  }

  /** 不更新。自動更新をその日で止める（いまの期間は満了まで有効）。 */
  async decline(id: number, input: { on: string; note?: string | null }, actor: string): Promise<void> {
    if (!input.on) throw new DomainError("VALIDATION", "不更新を決めた日を入れてください");
    try {
      await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE agreements SET renewal_stopped_on = $2::date, updated_at = now() WHERE id = $1 RETURNING id`,
          [id, input.on]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await client.query(
          `INSERT INTO term_events (target_type, target_id, kind, on_date, note, created_by)
           VALUES ('agreement', $1, 'declined', $2::date, $3, $4)`, [id, input.on, str(input.note), actor]);
        await recordAudit(client, { actor, action: "agreement.decline", targetType: "agreement", targetId: id,
                                    detail: { on: input.on, note: str(input.note) } });
      });
    } catch (error) { throw translate(error); }
  }

  /** 合意による更新。覚書で終了日を決め直したときに、その補助文書を根拠にして記録する。 */
  async renew(
    id: number, input: { on: string; newEnd: string; refAgreementId?: number | null; note?: string | null },
    actor: string
  ): Promise<void> {
    if (!input.on || !input.newEnd) throw new DomainError("VALIDATION", "更新の日と新しい終了日を入れてください");
    try {
      await inTransaction(this.database, async (client) => {
        const r = await client.query("SELECT id FROM agreements WHERE id = $1", [id]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await client.query(
          `INSERT INTO term_events (target_type, target_id, kind, on_date, new_end, ref_agreement_id, note, created_by)
           VALUES ('agreement', $1, 'renewed', $2::date, $3::date, $4, $5, $6)`,
          [id, input.on, input.newEnd, input.refAgreementId ?? null, str(input.note), actor]);
        await recordAudit(client, { actor, action: "agreement.renew", targetType: "agreement", targetId: id,
                                    detail: { on: input.on, newEnd: input.newEnd, refAgreementId: input.refAgreementId ?? null } });
      });
    } catch (error) { throw translate(error); }
  }

  // -------------------------------------------------------------------
  // 解除
  // -------------------------------------------------------------------

  /**
   * 解除の下見。何が終わり、何を取り消し、何を残すかを先に出す。
   * 解除は「ここで終わる」と日付を置く処理。条件・紙・支払は消さない。
   */
  async terminatePlan(
    id: number, input: Pick<TerminateInput, "on" | "scope" | "conditionIds">
  ): Promise<{ agreement: AgreementRow; lines: TerminatePlanLine[]; warnings: string[] }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.on ?? ""))) {
      throw new DomainError("VALIDATION", "解除日を入れてください");
    }
    try {
      const found = await this.find(id);
      if (!found) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
      const agreement = found.agreement;
      if (agreement.kind !== "master" && agreement.kind !== "standalone") {
        throw new DomainError("VALIDATION", "解除できるのは基本契約か単体契約です（補助文書は親ごと解除します）");
      }
      const only = input.scope === "conditions" ? (input.conditionIds ?? []).map(Number).filter(Boolean) : [];
      if (input.scope === "conditions" && !only.length) {
        throw new DomainError("VALIDATION", "終える条件を選んでください");
      }
      const conds = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.term_start, c.term_end, c.auto_renew, c.renew_months,
                c.renew_stopped_on,
                (SELECT count(*) FROM condition_schedules s
                  WHERE s.condition_id = c.id AND s.due_on > $2::date
                    AND NOT EXISTS (SELECT 1 FROM condition_events e
                                     WHERE e.schedule_id = s.id AND e.status = 'active'))::int AS removable,
                (SELECT count(*) FROM condition_events e
                  WHERE e.condition_id = c.id AND e.status = 'active')::int AS events,
                (SELECT count(DISTINCT y.id) FROM payments y
                   JOIN payment_allocations al ON al.payment_id = y.id
                   JOIN condition_events e ON e.id = al.event_id
                  WHERE e.condition_id = c.id AND y.status IN ('planned', 'approved'))::int AS unpaid
           FROM conditions c
          WHERE c.agreement_id = $1 AND c.status = 'active'
            AND ($3::bigint[] = '{}'::bigint[] OR c.id = ANY($3::bigint[]))
          ORDER BY c.id`, [id, input.on, only]);
      const condEvents = await this.eventsFor(this.database, "condition", (conds.rows as any[]).map((c) => Number(c.id)));
      const lines: TerminatePlanLine[] = (conds.rows as any[]).map((c) => {
        const h = termHistory(termInputForCondition(c, agreement, condEvents.get(Number(c.id)) ?? []), input.on);
        return {
          conditionId: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
          currentEnd: h.currentEnd, newEnd: input.on,
          schedulesToRemove: Number(c.removable), events: Number(c.events), unpaidPayments: Number(c.unpaid)
        };
      });
      const warnings: string[] = [];
      if (agreement.terminatedOn) warnings.push(`この契約は ${agreement.terminatedOn} に解除済みです`);
      if (input.scope === "whole") warnings.push("契約の状態を「解除」にします。契約チェックは「解除済み。新しい発注はできません」を返します");
      else warnings.push("契約は締結済みのまま。選んだ条件だけが解除日で終わります");
      const removing = lines.reduce((a, l) => a + l.schedulesToRemove, 0);
      if (removing) warnings.push(`解除日より後の予定明細 ${removing} 回を取り消します（実績の付いた回は残します）`);
      const unpaid = lines.reduce((a, l) => a + l.unpaidPayments, 0);
      if (unpaid) warnings.push(`未払の支払 ${unpaid} 件はそのまま残ります（払うべきもの）`);
      warnings.push("解除日までの実績・検収書・支払は触りません。番号も戻りません");
      return { agreement, lines, warnings };
    } catch (error) { throw translate(error); }
  }

  async terminate(id: number, input: TerminateInput, actor: string)
    : Promise<{ terminationId: number; terminationNo: string | null; conditions: number; schedulesRemoved: number }> {
    const reason = String(input.reason ?? "").trim();
    if (!reason) throw new DomainError("VALIDATION", "解除の理由を書いてください（監査に残ります）");
    const plan = await this.terminatePlan(id, input);
    try {
      return await inTransaction(this.database, async (client) => {
        // 解除合意を親の下に立てる（枝番 -T01）。
        const parent = (await client.query(
          "SELECT id, agreement_no, kind, counterparty_id, domain, direction FROM agreements WHERE id = $1 FOR UPDATE",
          [id])).rows[0] as any;
        const terminationNo = await this.numberFor(client, "termination", null, parent);
        const made = await client.query(
          `INSERT INTO agreements
             (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id,
              executed_on, effective_on, terminated_on, source_url)
           VALUES ($1, $2, $3, $4, 'executed', 'termination', $5, $6, $7::date, $7::date, $7::date, $8)
           RETURNING id`,
          [terminationNo, input.scope === "whole" ? "解除合意" : "一部条件の解除合意",
           parent.counterparty_id, parent.direction, parent.domain, id, input.on, str(input.sourceUrl)]);
        const terminationId = Number((made.rows[0] as { id: number }).id);

        if (input.scope === "whole") {
          await client.query(
            `UPDATE agreements SET status = 'terminated', terminated_on = $2::date, updated_at = now() WHERE id = $1`,
            [id, input.on]);
          await client.query(
            `INSERT INTO term_events (target_type, target_id, kind, on_date, ref_agreement_id, note, created_by)
             VALUES ('agreement', $1, 'terminated', $2::date, $3, $4, $5)`,
            [id, input.on, terminationId, reason, actor]);
        }

        let removed = 0;
        for (const line of plan.lines) {
          // 終了日を解除日に置き換える（条件は無効にしない。番号と履歴はそのまま）。
          await client.query(
            `UPDATE conditions
                SET term_end = CASE WHEN term_end IS NULL OR term_end > $2::date THEN $2::date ELSE term_end END,
                    renew_stopped_on = COALESCE(renew_stopped_on, $2::date),
                    updated_at = now()
              WHERE id = $1`, [line.conditionId, input.on]);
          await client.query(
            `INSERT INTO term_events (target_type, target_id, kind, on_date, ref_agreement_id, note, created_by)
             VALUES ('condition', $1, 'terminated', $2::date, $3, $4, $5)`,
            [line.conditionId, input.on, terminationId, reason, actor]);
          // 解除日より後の予定を取り消す。実績の付いた回は残す。
          const gone = await client.query(
            `DELETE FROM condition_schedules s
              WHERE s.condition_id = $1 AND s.due_on > $2::date
                AND NOT EXISTS (SELECT 1 FROM condition_events e
                                 WHERE e.schedule_id = s.id AND e.status = 'active')`,
            [line.conditionId, input.on]);
          removed += gone.rowCount ?? 0;
        }

        await recordAudit(client, {
          actor, action: "agreement.terminate", targetType: "agreement", targetId: id,
          detail: { on: input.on, scope: input.scope, reason, terminationId, terminationNo,
                    conditionIds: plan.lines.map((l) => l.conditionId), schedulesRemoved: removed }
        });
        return { terminationId, terminationNo, conditions: plan.lines.length, schedulesRemoved: removed };
      });
    } catch (error) { throw translate(error); }
  }
}

// ---------------------------------------------------------------------------
// 行の形と、更新履歴の入力
// ---------------------------------------------------------------------------

function historyOf(row: any, events: TermEvent[]): TermHistory {
  return termHistory({
    termStart: dateStr(row.effective_on) ?? dateStr(row.executed_on),
    termEnd: dateStr(row.expires_on),
    autoRenew: row.auto_renewal === true,
    renewMonths: int(row.renewal_months),
    renewStoppedOn: dateStr(row.renewal_stopped_on),
    terminatedOn: dateStr(row.terminated_on),
    events,
    startBasis: row.status === "executed" ? `締結${dateStr(row.executed_on) ? `（${dateStr(row.executed_on)}）` : ""}`
      : row.status === "negotiating" ? "交渉中" : row.status === "draft" ? "下書き" : "締結"
  });
}

export function mapRow(row: any, events: TermEvent[] = []): AgreementRow {
  const h = historyOf(row, events);
  return {
    id: Number(row.id), agreementNo: str(row.agreement_no), title: String(row.title),
    direction: row.direction === "out" ? "out" : "in",
    kind: (row.kind ?? "master") as AgreementKind,
    domain: (str(row.domain) as AgreementDomain | null) ?? null,
    parentId: int(row.parent_id),
    status: String(row.status),
    executedOn: dateStr(row.executed_on), effectiveOn: dateStr(row.effective_on), expiresOn: dateStr(row.expires_on),
    autoRenewal: row.auto_renewal === true, renewalMonths: int(row.renewal_months),
    renewalNoticeMonths: int(row.renewal_notice_months),
    renewalStoppedOn: dateStr(row.renewal_stopped_on), terminatedOn: dateStr(row.terminated_on),
    counterpartyRefNo: str(row.counterparty_ref_no), sourceUrl: str(row.source_url),
    counterparty: { id: Number(row.party_id), name: String(row.party_name ?? "") },
    conditionCount: Number(row.condition_count ?? 0), documentCount: Number(row.document_count ?? 0),
    totalFlat: Number(row.total_flat ?? 0),
    currentEnd: h.currentEnd, renewals: h.renewals
  };
}

/**
 * 条件の更新履歴の入力。自分の規則が無ければ親の契約の規則を借りる。
 * 契約が解除されていれば、条件もその日で切れる。
 */
export function termInputForCondition(
  cond: { term_start?: unknown; term_end?: unknown; auto_renew?: unknown; renew_months?: unknown;
          renew_stopped_on?: unknown; termStart?: string | null; termEnd?: string | null;
          autoRenew?: boolean | null; renewMonths?: number | null; renewStoppedOn?: string | null },
  agreement: AgreementRow | null,
  events: TermEvent[]
): TermInput {
  const termStart = cond.termStart ?? dateStr(cond.term_start);
  const termEnd = cond.termEnd ?? dateStr(cond.term_end);
  const own = cond.autoRenew ?? (cond.auto_renew === null || cond.auto_renew === undefined ? null : Boolean(cond.auto_renew));
  const borrow = own === null && agreement !== null && agreement.autoRenewal;
  return {
    termStart, termEnd,
    autoRenew: borrow ? true : own,
    renewMonths: borrow ? agreement!.renewalMonths : (cond.renewMonths ?? int(cond.renew_months)),
    renewStoppedOn: cond.renewStoppedOn ?? dateStr(cond.renew_stopped_on)
      ?? (borrow ? agreement!.renewalStoppedOn : null),
    terminatedOn: agreement?.terminatedOn ?? null,
    events,
    startBasis: agreement
      ? `${KIND_LABEL[agreement.kind]} ${agreement.agreementNo ?? `#${agreement.id}`}${borrow ? " の規則に従う" : ""}`
      : "登録"
  };
}
