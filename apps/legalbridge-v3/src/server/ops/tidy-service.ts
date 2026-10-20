import { type Queryable, dateStr, int, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { ORDER_DOCUMENT_SQL, type PartyAgreementMapService, type MapPartyRow } from "../agreements/party-map.js";
import type { PartyMergeService, MergeCandidate } from "../parties/merge-service.js";
import type { TermDefaultService, TermTarget } from "../conditions/term-default.js";
import type { NoticeFillService, NoticeTarget } from "../documents/notice-fill.js";
import type { StatementMergeService, MergeGroup } from "../royalty/statement-merge.js";
import {
  buildTidy, type TidyConditionRow, type TidyDocumentHolder, type TidyEventStat, type TidyPaymentRow,
  type TidyStatementRow, type TidyTree, type MarkKind
} from "./tidy.js";

/**
 * 整理する ― 取引先ひとつぶんの木を組むための行を集める。
 *
 * 契約の層は 取引先⇔基本契約のマップ（PartyAgreementMapService）をそのまま使う。
 * 条件から下（実績・支払文書・支払）と、受取人としての枝、各直し道具の対象はここで引く。
 * 直す操作は持たない。印の fix に、今ある道具（名寄せ・契約を立てる・繋ぐ・期間・通知先・
 * 計算書の統合）への指示を載せ、画面はその道具の API を叩く。
 */

export interface TidyPartyRow extends MapPartyRow {
  /** 印の数（名寄せ候補・期間の空・通知先の空・計算書の多重を足したもの。木を組むと少し変わる）。 */
  marks: number;
}

/** 直し道具。テストで差し替えられるように、必要なメソッドだけ受け取る。 */
export interface TidyTools {
  map: Pick<PartyAgreementMapService, "parties" | "forParty">;
  merge: Pick<PartyMergeService, "candidates">;
  term: Pick<TermDefaultService, "preview">;
  notice: Pick<NoticeFillService, "preview">;
  statements: Pick<StatementMergeService, "preview">;
}

export class TidyService {
  constructor(private readonly database: Queryable, private readonly tools: TidyTools) {}

  /** 取引先の一覧。マップの一覧に、他の道具の対象の数を足す。 */
  async parties(query: { keyword?: string; issuesOnly?: boolean } = {}): Promise<TidyPartyRow[]> {
    try {
      const [rows, merge, term, notice, stmts] = await Promise.all([
        this.tools.map.parties({ keyword: query.keyword, issuesOnly: false }),
        this.tools.merge.candidates(500), this.tools.term.preview(), this.tools.notice.preview(null),
        this.tools.statements.preview()
      ]);
      const resolved = await this.resolveMap([
        ...merge.flatMap((g) => g.parties.map((p) => p.id)),
        ...term.targets.map((t) => t.partyId).filter((x): x is number => x != null),
        ...notice.targets.map((t) => t.partyId).filter((x): x is number => x != null),
        ...stmts.groups.map((g) => g.partyId)
      ]);
      const extra = new Map<number, number>();
      const bump = (id: number | null | undefined) => {
        if (id == null) return;
        const r = resolved.get(id) ?? id;
        extra.set(r, (extra.get(r) ?? 0) + 1);
      };
      for (const g of merge) for (const p of g.parties) bump(p.id);
      for (const t of term.targets) bump(t.partyId);
      for (const t of notice.targets) bump(t.partyId);
      for (const g of stmts.groups) bump(g.partyId);
      const out = rows.map((r) => ({
        ...r, marks: r.issues + r.unlinked + r.looseConditions + (extra.get(r.id) ?? 0)
      }));
      return (query.issuesOnly ? out.filter((r) => r.marks > 0) : out)
        .sort((a, b) => (b.marks > 0 ? 1 : 0) - (a.marks > 0 ? 1 : 0) || a.name.localeCompare(b.name, "ja"));
    } catch (error) { throw translate(error); }
  }

  async forParty(partyId: number): Promise<TidyTree | null> {
    try {
      const map = await this.tools.map.forParty(partyId);
      if (!map) return null;
      const resolvedId = map.party.id;
      const pr = await this.database.query(
        `SELECT r.party_id, p.kind, p.email, p.name
           FROM v_party_resolved r JOIN parties p ON p.id = r.party_id
          WHERE r.resolved_id = $1 ORDER BY (r.party_id = $1) DESC, r.party_id`, [resolvedId]);
      const members = (pr.rows as any[]).map((r) => Number(r.party_id));
      if (!members.includes(resolvedId)) members.unshift(resolvedId);
      const head = (pr.rows as any[]).find((r) => Number(r.party_id) === resolvedId) ?? (pr.rows as any[])[0] ?? {};
      const party = { id: resolvedId, name: map.party.name, kind: String(head.kind ?? "individual"), email: str(head.email) };

      const [conditions, mergeAll, termAll, noticeAll, stmtAll] = await Promise.all([
        this.conditions(members),
        this.tools.merge.candidates(500), this.tools.term.preview(), this.tools.notice.preview(null),
        this.tools.statements.preview()
      ]);
      const ids = conditions.map((c) => c.id);
      const [events, statements, payments] = ids.length
        ? await Promise.all([this.events(ids), this.statements(ids), this.payments(ids)])
        : [[], [], []];
      const memberSet = new Set(members);
      const termTargets: TermTarget[] = termAll.targets.filter((t) => t.partyId != null && memberSet.has(t.partyId));
      const noticeTargets: NoticeTarget[] = noticeAll.targets.filter((t) => t.partyId != null && memberSet.has(t.partyId));
      const noticeHolders = noticeTargets.length ? await this.holders(noticeTargets.map((t) => t.documentId)) : [];
      const mergeCandidates: MergeCandidate[] = mergeAll.filter((g) => g.parties.some((p) => memberSet.has(p.id)));
      const statementGroups: MergeGroup[] = stmtAll.groups.filter((g) => memberSet.has(g.partyId));

      return buildTidy({
        party, members, map, conditions, events, statements, payments,
        mergeCandidates, termTargets, noticeTargets, noticeHolders, statementGroups
      });
    } catch (error) { throw translate(error); }
  }

  /** 印の種類ごとの数（画面の見出し）。 */
  static counts(tree: TidyTree): Array<{ kind: MarkKind; count: number }> {
    return (["dup", "unregistered", "missing", "blank"] as MarkKind[]).map((kind) => ({ kind, count: tree.counts[kind] }));
  }

  private async resolveMap(ids: number[]): Promise<Map<number, number>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const r = await this.database.query(
      "SELECT party_id, resolved_id FROM v_party_resolved WHERE party_id = ANY($1::bigint[])", [uniq]);
    return new Map((r.rows as any[]).map((x) => [Number(x.party_id), Number(x.resolved_id)]));
  }

  /**
   * この取引先の条件。相手方としての分と、受取人（共著の取り分）としての分（shared）。
   * 差し替え済み・取消は出さない（片づけの対象）。
   */
  private async conditions(members: number[]): Promise<TidyConditionRow[]> {
    const r = await this.database.query(
      `SELECT c.id, c.condition_no, c.name, c.kind, c.direction, c.status, c.usage_type,
              c.pricing_model, c.rate_ppm, c.flat_amount,
              c.work_id, w.title AS work_title, c.agreement_id, c.term_start, c.term_end, c.auto_renew,
              (SELECT dc.document_id FROM document_conditions dc
                 JOIN documents d ON d.id = dc.document_id AND d.status NOT IN ('void', 'superseded')
                 LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
                 LEFT JOIN document_templates t ON t.id = tv.template_id
                WHERE dc.condition_id = c.id AND ${ORDER_DOCUMENT_SQL}
                ORDER BY d.issued_at DESC NULLS LAST, d.id DESC LIMIT 1) AS holder_document_id,
              (SELECT count(*)::int FROM condition_shares s WHERE s.condition_id = c.id) AS shares,
              (c.counterparty_id <> ALL($1::bigint[])) AS shared,
              cp.name AS counterparty_name
         FROM conditions c
         LEFT JOIN works w ON w.id = c.work_id
         LEFT JOIN parties cp ON cp.id = c.counterparty_id
        WHERE c.status NOT IN ('superseded', 'void')
          AND (c.counterparty_id = ANY($1::bigint[])
               OR EXISTS (SELECT 1 FROM condition_shares s WHERE s.condition_id = c.id AND s.party_id = ANY($1::bigint[])))
        ORDER BY w.title NULLS LAST, c.term_start NULLS LAST, c.id`, [members]);
    return (r.rows as any[]).map((c) => ({
      id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""), kind: String(c.kind ?? ""),
      direction: c.direction === "out" ? "out" : "in", status: String(c.status ?? ""), usageType: str(c.usage_type),
      pricingModel: str(c.pricing_model), ratePpm: int(c.rate_ppm), flatAmount: int(c.flat_amount),
      workId: int(c.work_id), workTitle: str(c.work_title), agreementId: int(c.agreement_id),
      termStart: dateStr(c.term_start), termEnd: dateStr(c.term_end), autoRenew: c.auto_renew === true,
      holderDocumentId: int(c.holder_document_id), shares: Number(c.shares ?? 0),
      shared: c.shared === true, counterpartyName: str(c.counterparty_name)
    }));
  }

  /** 実績の数と、支払に割り当たっていないもの（取り残し＝割り当て済みより前の日付）。 */
  private async events(conditionIds: number[]): Promise<TidyEventStat[]> {
    const r = await this.database.query(
      `WITH e AS (
         SELECT e.id, e.condition_id, e.occurred_on,
                EXISTS (SELECT 1 FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                         WHERE a.event_id = e.id AND p.status <> 'canceled') AS allocated
           FROM condition_events e
          WHERE e.status = 'active' AND e.condition_id = ANY($1::bigint[])),
       m AS (SELECT condition_id, max(occurred_on) AS last_allocated FROM e WHERE allocated GROUP BY condition_id)
       SELECT e.condition_id, count(*)::int AS total, min(e.occurred_on) AS first, max(e.occurred_on) AS last,
              count(*) FILTER (WHERE NOT e.allocated)::int AS unallocated,
              count(*) FILTER (WHERE NOT e.allocated AND m.last_allocated IS NOT NULL AND e.occurred_on <= m.last_allocated)::int AS gap
         FROM e LEFT JOIN m ON m.condition_id = e.condition_id
        GROUP BY e.condition_id`, [conditionIds]);
    return (r.rows as any[]).map((x) => ({
      conditionId: Number(x.condition_id), total: Number(x.total ?? 0), first: dateStr(x.first), last: dateStr(x.last),
      unallocated: Number(x.unallocated ?? 0), gap: Number(x.gap ?? 0)
    }));
  }

  /** 計算書（支払文書）。差し替え済み・取消は出さない。 */
  private async statements(conditionIds: number[]): Promise<TidyStatementRow[]> {
    const r = await this.database.query(
      `SELECT d.id, d.document_no, d.status, d.issued_at, s.period, s.condition_id, s.payee_party_id, s.net_amount
         FROM statements s JOIN documents d ON d.id = s.document_id
        WHERE s.condition_id = ANY($1::bigint[]) AND d.status IN ('draft', 'issued')
        ORDER BY s.period, d.id`, [conditionIds]);
    return (r.rows as any[]).map((x) => ({
      documentId: Number(x.id), documentNo: str(x.document_no), status: String(x.status ?? ""), issuedOn: dateStr(x.issued_at),
      period: str(x.period), conditionId: Number(x.condition_id), payeePartyId: int(x.payee_party_id),
      netAmount: Number(x.net_amount ?? 0)
    }));
  }

  private async payments(conditionIds: number[]): Promise<TidyPaymentRow[]> {
    const r = await this.database.query(
      `SELECT p.id, p.payment_no, p.status, p.due_on, p.paid_on, p.amount, p.currency,
              array_agg(DISTINCT a.condition_id) AS condition_ids
         FROM payments p JOIN payment_allocations a ON a.payment_id = p.id
        WHERE a.condition_id = ANY($1::bigint[])
        GROUP BY p.id ORDER BY p.due_on NULLS LAST, p.id`, [conditionIds]);
    return (r.rows as any[]).map((x) => ({
      id: Number(x.id), paymentNo: str(x.payment_no), status: String(x.status ?? ""), dueOn: dateStr(x.due_on),
      paidOn: dateStr(x.paid_on), amount: Number(x.amount ?? 0), currency: String(x.currency ?? "JPY"),
      conditionIds: (Array.isArray(x.condition_ids) ? x.condition_ids : []).map(Number)
    }));
  }

  /** 通知先を埋める文書が付いている契約・条件。 */
  private async holders(documentIds: number[]): Promise<TidyDocumentHolder[]> {
    const r = await this.database.query(
      `SELECT d.id, d.agreement_id,
              ARRAY(SELECT dc.condition_id FROM document_conditions dc WHERE dc.document_id = d.id ORDER BY dc.line_no) AS condition_ids
         FROM documents d WHERE d.id = ANY($1::bigint[])`, [documentIds]);
    return (r.rows as any[]).map((x) => ({
      documentId: Number(x.id), agreementId: int(x.agreement_id),
      conditionIds: (Array.isArray(x.condition_ids) ? x.condition_ids : []).map(Number)
    }));
  }
}
