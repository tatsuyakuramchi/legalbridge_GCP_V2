import { str, type Queryable, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { conditionContracts } from "../conditions/contracts.js";
import { RoyaltyLedgerService, type LedgerView, type Round, type RoundDocument, type RoundPayment, type Timing } from "./ledger-service.js";

/**
 * 回と文書の一覧（作品タブ「回と文書」・横断の「回の一覧」）。docs/royalty-ledger.md §9
 *
 * 台帳（ledger-service）が組み立てた回を、条件の行 × 回の列に並べ直して見せるだけ。
 * データは増やさない。回号は条件ごと（時限式＝締めの seq、イベント式＝製造日の順）、
 * 計算書の番号は作家 × 作品の通し（numberStatements）。
 */

export interface OverviewDocument {
  id: number; documentNo: string | null; status: string; issuedOn: string | null;
  sent: boolean; net: number; seq: number | null;
}
export interface OverviewCell {
  roundKey: string; kind: "period" | "event";
  /** この条件の第 N 回。予定の外は null。 */
  roundNo: number | null;
  label: string | null; periodFrom: string | null; closeOn: string | null; payOn: string | null;
  state: string; roundState: string;
  reports: number;
  documents: OverviewDocument[];
  payments: RoundPayment[];
}
/** 条件書・契約書（条件の根拠の文書）。 */
export interface OverviewContract { kind: "master" | "agreement" | "terms"; no: string | null; title: string; status: string; documentId?: number | null }
/** この IN 条件の下で報告の来た（来るはずの）許諾先（OUT 条件）。 */
export interface OverviewOut { id: number; name: string; agreementNo: string | null; reports: number }

export interface OverviewRow {
  conditionId: number; conditionNo: string | null; name: string;
  partyId: number; partyName: string;
  workId: number | null; workTitle: string | null;
  usageType: string | null; usageLabel: string;
  timing: Timing; settlementMode: string | null;
  ratePpm: number | null; unitAmount: number | null; pricingModel: string;
  targetPartyName: string | null;
  contracts: OverviewContract[];
  outs: OverviewOut[];
  cells: OverviewCell[];
}

const docOf = (d: RoundDocument): OverviewDocument => ({
  id: d.id, documentNo: d.documentNo, status: d.status, issuedOn: d.issuedOn ?? null,
  sent: d.sent, net: d.net, seq: d.seq ?? null
});

/** 台帳の 1 枚（作家 × 作品 / 全作品）を、条件の行 × 回のマスにする（純粋関数）。 */
export function overviewRows(view: LedgerView): OverviewRow[] {
  const rounds: Round[] = [...view.rounds, ...view.history];
  return view.conditions.map((c) => {
    const cells: OverviewCell[] = [];
    const outs = new Map<number, OverviewOut>();
    for (const r of rounds) {
      for (const p of r.parts.filter((x) => x.conditionId === c.id)) {
        // 共著の取り分は受取人ごとの計算書も（明細で繋がるもの）。
        const docIds = new Set(p.events.flatMap((e) => [e.documentId, ...(e.extraDocumentIds ?? [])]).filter((x): x is number => !!x));
        cells.push({
          roundKey: r.key, kind: p.scheduleId ? "period" : r.kind,
          roundNo: p.roundNo ?? null, label: p.label,
          periodFrom: p.periodFrom, closeOn: p.closeOn, payOn: p.payOn ?? r.payOn,
          state: p.state, roundState: r.state, reports: p.events.length,
          documents: r.documents.filter((d) => docIds.has(d.id)).map(docOf),
          payments: r.payments
        });
        for (const e of p.events) {
          if (!e.outConditionId) continue;
          const o = outs.get(e.outConditionId) ?? { id: e.outConditionId, name: e.outName ?? `#${e.outConditionId}`, agreementNo: null, reports: 0 };
          o.reports += 1;
          outs.set(e.outConditionId, o);
        }
        for (const x of p.expected) {
          if (x.outConditionId && !outs.has(x.outConditionId)) {
            outs.set(x.outConditionId, { id: x.outConditionId, name: x.outName ?? `#${x.outConditionId}`, agreementNo: null, reports: 0 });
          }
        }
      }
    }
    // 回号の順（無いものは日付で後ろに）。同じ回号なら締め・製造日の順。
    cells.sort((a, b) => String(a.closeOn ?? "").localeCompare(String(b.closeOn ?? ""))
                        || (a.roundNo ?? 1e9) - (b.roundNo ?? 1e9));
    return {
      conditionId: c.id, conditionNo: c.conditionNo, name: c.name,
      partyId: view.party.id, partyName: view.party.name,
      workId: c.workId, workTitle: c.workTitle,
      usageType: c.usageType, usageLabel: c.usageLabel,
      timing: c.timing, settlementMode: c.settlementMode ?? null,
      ratePpm: c.ratePpm, unitAmount: c.unitAmount, pricingModel: c.pricingModel,
      targetPartyName: c.targetPartyName ?? null,
      contracts: [], outs: [...outs.values()], cells
    };
  });
}

/** 横断の一覧の 1 行（回 1 つ）。 */
export interface CrossRound {
  key: string; kind: "period" | "event";
  partyId: number; partyName: string;
  works: Array<{ id: number; title: string }>;
  conditions: Array<{ id: number; conditionNo: string | null; name: string; usageLabel: string; roundNo: number | null; label: string | null }>;
  closeOn: string | null; payOn: string | null; state: string;
  reports: number;
  documents: OverviewDocument[]; payments: RoundPayment[];
}

export function crossRounds(view: LedgerView): CrossRound[] {
  const byId = new Map(view.conditions.map((c) => [c.id, c]));
  return [...view.rounds, ...view.history].map((r) => ({
    key: `${view.party.id}:${r.key}`, kind: r.kind,
    partyId: view.party.id, partyName: view.party.name,
    works: r.workIds.map((id) => ({ id, title: view.works.find((w) => w.id === id)?.title ?? `#${id}` })),
    conditions: r.parts.map((p) => {
      const c = byId.get(p.conditionId);
      return { id: p.conditionId, conditionNo: c?.conditionNo ?? null, name: c?.name ?? "", usageLabel: c?.usageLabel ?? "",
               roundNo: p.roundNo ?? null, label: p.label };
    }),
    closeOn: r.closeOn, payOn: r.payOn, state: r.state,
    reports: r.parts.reduce((n, p) => n + p.events.length, 0),
    documents: r.documents.map(docOf), payments: r.payments
  }));
}

export class RoundOverviewService {
  private readonly ledger: RoyaltyLedgerService;
  constructor(private readonly database: Transactable) { this.ledger = new RoyaltyLedgerService(database); }

  /** 作品の「回と文書」。その作品を許諾している作家ごとの条件の行。 */
  async forWork(workId: number, today = new Date().toISOString().slice(0, 10)): Promise<{ rows: OverviewRow[] }> {
    try {
      const parties = (await this.database.query(
        `SELECT DISTINCT c.counterparty_id FROM conditions c
          WHERE c.work_id = $1 AND c.direction = 'in' AND c.kind = 'license'
            AND c.status IN ('active', 'scheduled') AND c.pricing_model IN ('revenue_rate', 'unit_rate')`,
        [workId])).rows as Array<{ counterparty_id: number }>;
      const rows: OverviewRow[] = [];
      for (const p of parties) {
        rows.push(...overviewRows(await this.ledger.ledger(Number(p.counterparty_id), workId, today)));
      }
      await attachContracts(this.database, rows);
      return { rows: rows.sort((a, b) => a.partyName.localeCompare(b.partyName, "ja")
                                          || String(a.conditionNo ?? "").localeCompare(String(b.conditionNo ?? ""))) };
    } catch (error) { throw translate(error); }
  }

  /**
   * 横断の回の一覧。作家・作品・期間（締め／製造日か支払日が範囲に入る回）・出し方で絞る。
   * 作家ごとに台帳を組むので、作家を絞らないときは許諾料の条件を持つ作家すべてを回る。
   */
  async cross(input: { from?: string | null; to?: string | null; partyId?: number | null; workId?: number | null;
                       kind?: "period" | "event" | null; openOnly?: boolean },
              today = new Date().toISOString().slice(0, 10)): Promise<{ rounds: CrossRound[] }> {
    try {
      const parties = (await this.database.query(
        `SELECT DISTINCT c.counterparty_id FROM conditions c
          WHERE c.direction = 'in' AND c.kind = 'license'
            AND c.status IN ('active', 'scheduled') AND c.pricing_model IN ('revenue_rate', 'unit_rate')
            AND ($1::bigint IS NULL OR c.counterparty_id = $1)
            AND ($2::bigint IS NULL OR c.work_id = $2)`,
        [input.partyId ?? null, input.workId ?? null])).rows as Array<{ counterparty_id: number }>;
      const out: CrossRound[] = [];
      for (const p of parties) {
        const view = await this.ledger.ledger(Number(p.counterparty_id), input.workId ?? null, today);
        out.push(...crossRounds(view));
      }
      const inRange = (d: string | null) => !!d && (!input.from || d >= input.from) && (!input.to || d <= input.to);
      const closed = new Set(["paid", "nopay", "skipped"]);
      return {
        rounds: out
          .filter((r) => !input.kind || r.kind === input.kind)
          .filter((r) => !input.openOnly || !closed.has(r.state))
          .filter((r) => (!input.from && !input.to) || inRange(r.closeOn) || inRange(r.payOn))
          .sort((a, b) => String(b.closeOn ?? b.payOn ?? "").localeCompare(String(a.closeOn ?? a.payOn ?? "")))
      };
    } catch (error) { throw translate(error); }
  }
}

/** 条件の行に、根拠の契約書・条件書と、許諾先（OUT 条件）の契約番号を添える。 */
async function attachContracts(q: Queryable, rows: OverviewRow[]): Promise<void> {
  for (const row of rows) {
    const cc = await conditionContracts(q, row.conditionId);
    const list: OverviewContract[] = [];
    if (cc.master) list.push({ kind: "master", no: cc.master.no, title: cc.master.title, status: cc.master.status });
    if (cc.agreement && cc.agreement.id !== cc.master?.id) {
      list.push({ kind: "agreement", no: cc.agreement.no, title: cc.agreement.title, status: cc.agreement.status });
    }
    for (const t of cc.terms) {
      list.push({ kind: "terms", no: t.no, title: t.label, status: t.status, documentId: t.id });
    }
    row.contracts = list;
  }
  const outIds = [...new Set(rows.flatMap((r) => r.outs.map((o) => o.id)))];
  if (!outIds.length) return;
  const nos = (await q.query(
    `SELECT c.id, COALESCE(m.agreement_no, m_d.agreement_no) AS agreement_no
       FROM conditions c
       LEFT JOIN agreements m_d ON m_d.id = c.agreement_id
       LEFT JOIN agreements m ON m.id = CASE WHEN m_d.kind IN ('supplement', 'termination') THEN m_d.parent_id ELSE m_d.id END
      WHERE c.id = ANY($1::bigint[])`, [outIds])).rows as Array<{ id: number; agreement_no: string | null }>;
  const noOf = new Map(nos.map((x) => [Number(x.id), str(x.agreement_no)]));
  for (const row of rows) for (const o of row.outs) o.agreementNo = noOf.get(o.id) ?? null;
}

