import { dateStr, inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import { parsePaymentTerms, payOnFor } from "../conditions/payment-terms.js";

/**
 * 許諾料の台帳（作品 › 利用許諾計算）。docs/royalty-ledger.md
 *
 * 作家 × 作品（作家 × N 作品）で、許諾（IN）の条件を毎期くり返し使って
 * 計算書を出す。データは増やさない。条件・予定明細（締め）・実績・計算書・
 * 支払から「回」を組み立てて見せる。
 *
 *   回（round）… 計算書1枚の単位。
 *     時限式 … 予定明細の1行（締め日・支払日）。作家でまとめる／1作品の中では
 *               同じ支払日の回を1枚にする（契約ごとに締めがずれていてよい）。
 *     イベント式 … 製造・刷の実績1件。締めを待たずにその回だけで1枚。
 *   回の中の1本（part）… 条件 × その回。実績・「今期は無し」・来るはずの行を持つ。
 *
 * 計算そのもの（料率・MG・AG・税）は束ねた計算書（/statement-documents）が持つ。
 * ここは「どの実績をどの回に入れるか」と「回がどこまで進んだか」だけを決める。
 */

export type Timing = "periodic" | "event";
export type Bundle = "per_work" | "per_party";

/** 出し方の既定。紙出版は刷ごと（イベント式）、それ以外は締めで回る（時限式）。 */
export function timingOf(explicit: unknown, usageType: unknown): Timing {
  if (explicit === "periodic" || explicit === "event") return explicit;
  return usageType === "pub_print" ? "event" : "periodic";
}

export interface LedgerCondition {
  id: number; conditionNo: string | null; name: string;
  usageType: string | null; usageLabel: string;
  workId: number | null; workTitle: string | null;
  agreementId: number | null; agreementNo: string | null;
  pricingModel: string; ratePpm: number | null; unitAmount: number | null;
  mgAmount: number | null; agAmount: number | null; currency: string;
  paymentTerms: string | null;
  timing: Timing; timingExplicit: boolean;
  /** 予定明細（時限式の回）が何行あるか。0 なら回が作れない。 */
  schedules: number;
}

export interface LedgerEvent {
  id: number; conditionId: number; scheduleId: number | null;
  eventType: string; occurredOn: string | null; period: string | null;
  usageType: string | null; outConditionId: number | null; outName: string | null;
  workId: number | null; workTitle: string | null;
  quantity: number | null; unitAmount: number | null; grossAmount: number | null; amount: number;
  documentId: number | null;
  /** 結ばれた計算書の番号。台帳から決定した文書のページへ行く。 */
  documentNo?: string | null;
  /** この報告の言語・地域（A-061）。空は指定なし。 */
  languages?: string[]; regions?: string[];
}

/** 来るはずの行（前の回にあった・生きている許諾先がある）。 */
export interface ExpectedLine {
  usageType: string | null; outConditionId: number | null; outName: string | null;
  workId: number | null; workTitle: string | null; why: string;
  /** 言語ごとに報告が来る許諾は、言語ごとに1行（A-061）。 */
  languages?: string[]; regions?: string[];
}

export type PartState = "before" | "waiting" | "reported" | "skipped" | "issued";

export interface RoundPart {
  conditionId: number; scheduleId: number | null; eventId: number | null;
  label: string | null; periodFrom: string | null; closeOn: string | null; payOn: string | null;
  events: LedgerEvent[]; skipped: boolean; expected: ExpectedLine[]; state: PartState;
}

export type RoundState = "before" | "input" | "ready" | "issued" | "sent" | "scheduled" | "paid" | "skipped" | "nopay";

export interface RoundDocument { id: number; documentNo: string | null; status: string; sent: boolean; net: number }
export interface RoundPayment { id: number; paymentNo: string | null; status: string; amount: number; dueOn: string | null; paidOn: string | null }
export interface RoundRequest { id: number; requestNo: string | null; title: string; assigneeName: string | null; dueOn: string | null; done: boolean }

export interface Round {
  key: string; kind: "period" | "event";
  payOn: string | null; closeOn: string | null;
  workIds: number[];
  parts: RoundPart[];
  documents: RoundDocument[]; payments: RoundPayment[]; requests: RoundRequest[];
  state: RoundState; open: boolean;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface ScheduleLite { id: number; conditionId: number; seq: number; dueOn: string | null; payOn: string | null; label: string | null }
export interface OutLite {
  id: number; name: string; usageType: string | null; workId: number | null; termStart: string | null;
  /** 許諾言語・許諾地域。報告は 言語×地域 ごとに来るものとして、1組1行で待つ。 */
  languages?: string[]; regions?: string[];
}

/**
 * 回を組み立てる（純粋関数）。
 *
 * 時限式：実績は、予定明細の回（schedule_id）を指していればその回、無ければ
 *   発生日が「前の締めの翌日〜その回の締め」に入る回。どれにも入らない実績は
 *   「予定の外」として別の回（締め＝発生日）にする（黙って落とさない）。
 * イベント式：製造（manufacturing）の実績1件が1回。
 */
export function buildRounds(input: {
  conditions: LedgerCondition[];
  schedules: ScheduleLite[];
  events: LedgerEvent[];
  skips: Array<{ conditionId: number; scheduleId: number }>;
  outs: OutLite[];
  /** 1作品の中で見ているか。作家でまとめないときも、1作品の中は支払日でまとめる。 */
  bundle: Bundle | "single_work";
  today: string;
  /** 締め前の回をどこまで先まで出すか（日）。 */
  lookaheadDays?: number;
}): Round[] {
  const { conditions, today } = input;
  const horizon = addDays(today, input.lookaheadDays ?? 45);
  const byCondition = new Map(conditions.map((c) => [c.id, c]));
  const skipSet = new Set(input.skips.map((s) => `${s.conditionId}:${s.scheduleId}`));
  const parts: RoundPart[] = [];

  for (const c of conditions) {
    const events = input.events.filter((e) => e.conditionId === c.id);
    if (c.timing === "event") {
      for (const e of events) {
        // 支払日は製造日から条件の支払条件（製造月の翌月末など）で決める。
        parts.push({ conditionId: c.id, scheduleId: null, eventId: e.id, label: e.period,
          periodFrom: e.occurredOn, closeOn: e.occurredOn,
          payOn: payOnFor(e.occurredOn, parsePaymentTerms(c.paymentTerms)), events: [e], skipped: false,
          expected: [], state: e.documentId ? "issued" : "reported" });
      }
      continue;
    }
    const rows = input.schedules.filter((s) => s.conditionId === c.id && s.dueOn)
      .sort((a, b) => String(a.dueOn).localeCompare(String(b.dueOn)));
    const used = new Set<number>();
    const mine: RoundPart[] = rows.map((s, i) => {
      const from = i > 0 ? addDays(String(rows[i - 1].dueOn), 1) : null;
      const inRound = events.filter((e) => {
        if (used.has(e.id)) return false;
        if (e.scheduleId) return e.scheduleId === s.id;
        return !!e.occurredOn && e.occurredOn <= String(s.dueOn) && (!from || e.occurredOn >= from);
      });
      inRound.forEach((e) => used.add(e.id));
      return { conditionId: c.id, scheduleId: s.id, eventId: null, label: s.label, periodFrom: from,
        closeOn: s.dueOn, payOn: s.payOn, events: inRound,
        skipped: skipSet.has(`${c.id}:${s.id}`), expected: [], state: "before" as PartState };
    });
    // 予定の外の実績（予定明細より前・後、予定明細が無い）。
    for (const e of events.filter((x) => !used.has(x.id))) {
      mine.push({ conditionId: c.id, scheduleId: null, eventId: e.id, label: e.period ?? "予定の外",
        periodFrom: e.occurredOn, closeOn: e.occurredOn, payOn: null, events: [e], skipped: false,
        expected: [], state: "before" });
    }
    // 来るはずの行。前の回の行と、生きている許諾先。
    // 行の見分け：利用形態・許諾先・作品・言語×地域（A-061。英語版とフランス語版は別の行）。
    const keyOf = (e: { usageType: string | null; outConditionId: number | null; workId: number | null;
                        languages?: string[]; regions?: string[] }) =>
      `${e.usageType ?? ""}|${e.outConditionId ?? ""}|${e.workId ?? ""}|${(e.languages ?? []).join("・")}|${(e.regions ?? []).join("・")}`;
    const periodic = mine.filter((p) => p.scheduleId);
    periodic.forEach((p, i) => {
      const have = new Set(p.events.map(keyOf));
      const expected = new Map<string, ExpectedLine>();
      for (const e of i > 0 ? periodic[i - 1].events : []) {
        const k = keyOf(e);
        if (!have.has(k)) {
          expected.set(k, { usageType: e.usageType, outConditionId: e.outConditionId, outName: e.outName,
                            workId: e.workId, workTitle: e.workTitle, why: "前の回にあった",
                            languages: e.languages ?? [], regions: e.regions ?? [] });
        }
      }
      if (c.usageType === "sublicense" || c.usageType === "oem") {
        for (const o of input.outs.filter((x) => x.usageType === c.usageType
            && (x.workId === null || x.workId === c.workId)
            && (!x.termStart || !p.closeOn || x.termStart <= p.closeOn))) {
          // 報告は 言語×地域 ごとに来る（英語×北米、英語×欧州、フランス語×欧州）。
          // 1組1行で待つ。「全言語」「全世界」は分けない（1行）。
          const langs = (o.languages ?? []).filter((l) => l !== "全言語");
          const regs = (o.regions ?? []).filter((r) => r !== "全世界");
          const ls = langs.length > 1 ? langs : [null];
          const rs = regs.length > 1 ? regs : [null];
          for (const l of ls) for (const r of rs) {
            const match = (e: { languages?: string[]; regions?: string[] }) =>
              (!l || (e.languages ?? []).includes(l)) && (!r || (e.regions ?? []).includes(r));
            const hit = p.events.some((e) => e.outConditionId === o.id && match(e));
            const already = [...expected.values()].some((x) => x.outConditionId === o.id && match(x));
            if (!hit && !already) {
              expected.set(`${c.usageType}|${o.id}||${l ?? ""}|${r ?? ""}`,
                { usageType: c.usageType, outConditionId: o.id, outName: o.name,
                  workId: null, workTitle: null, why: "生きている許諾先",
                  languages: l ? [l] : [], regions: r ? [r] : [] });
            }
          }
        }
      }
      p.expected = [...expected.values()];
    });
    // 実績の無いまま過ぎた回は、人が「報告なし」にするまで報告待ちのまま出す
    // （古い予定明細は skipBefore でまとめて報告なしにできる）。
    for (const p of mine) {
      p.state = p.skipped ? "skipped"
        : p.events.length && p.events.every((e) => e.documentId) ? "issued"
        : p.events.length ? "reported"
        : p.closeOn && p.closeOn > today ? "before" : "waiting";
      if (p.state === "skipped" || p.state === "issued") p.expected = [];
    }
    parts.push(...mine);
  }

  // 回にまとめる。
  const groups = new Map<string, RoundPart[]>();
  for (const p of parts) {
    const c = byCondition.get(p.conditionId)!;
    const day = p.payOn ?? p.closeOn ?? "";
    const key = p.eventId !== null && c.timing === "event" ? `e:${p.eventId}`
      : p.eventId !== null ? `x:${p.eventId}`
      : input.bundle === "per_work" ? `p:${c.workId ?? 0}:${day}` : `p:${day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const rounds: Round[] = [];
  for (const [key, list] of groups) {
    // 先の回は、締めが近いもの・実績のあるものだけ。
    const closeOn = list.map((p) => p.closeOn).filter(Boolean).sort().at(-1) ?? null;
    const payOn = list.map((p) => p.payOn).filter(Boolean).sort().at(-1) ?? null;
    const anyEvents = list.some((p) => p.events.length);
    if (!anyEvents && closeOn && closeOn > horizon) continue;
    // 何も無いまま過ぎた回で、今期は無しにもしていないものは出す（報告待ち）。
    const states = list.map((p) => p.state);
    let state: RoundState;
    if (states.every((s) => s === "skipped")) state = "skipped";
    else if (states.every((s) => s === "issued" || s === "skipped")) state = "issued";
    else if (states.every((s) => s === "before")) state = "before";
    else if (states.every((s) => s === "reported" || s === "issued" || s === "skipped")) state = "ready";
    else state = "input";
    rounds.push({
      key, kind: key.startsWith("e:") ? "event" : "period", payOn, closeOn,
      workIds: [...new Set(list.map((p) => byCondition.get(p.conditionId)?.workId).filter((x): x is number => !!x))],
      parts: list, documents: [], payments: [], requests: [], state, open: true
    });
  }
  return rounds.sort((a, b) => String(a.payOn ?? a.closeOn).localeCompare(String(b.payOn ?? b.closeOn)));
}

/** 文書・送付・支払から、決まった回がどこまで進んだかを決める（純粋関数）。 */
export function settleRound(round: Round): Round {
  if (round.state !== "issued") return { ...round, open: round.state !== "skipped" };
  const live = round.payments.filter((p) => p.status !== "canceled");
  const net = round.documents.reduce((a, d) => a + d.net, 0);
  let state: RoundState = "issued";
  if (live.length && live.every((p) => p.status === "paid")) state = "paid";
  else if (live.length) state = "scheduled";
  else if (round.documents.some((d) => d.sent)) state = net > 0 ? "sent" : "nopay";
  else if (net <= 0 && round.documents.length) state = "nopay";
  return { ...round, state, open: !["paid", "nopay"].includes(state) };
}

export interface LedgerView {
  party: { id: number; name: string; kind: string; residency: string; bundle: Bundle; bundleExplicit: boolean };
  scope: { workId: number; workTitle: string } | null;
  works: Array<{ id: number; title: string; conditions: number }>;
  conditions: LedgerCondition[];
  rounds: Round[];
  history: Round[];
  requests: RoundRequest[];
}

export interface WorkRoyaltyParty {
  id: number; name: string; kind: string; bundle: Bundle;
  conditions: Array<{ id: number; usageLabel: string; ratePpm: number | null; timing: Timing }>;
  openRounds: number; waiting: number; nextPayOn: string | null;
  otherWorks: number;
  requests: RoundRequest[];
}

const eventIds0 = (events: LedgerEvent[]) => events.map((e) => e.id);

export class RoyaltyLedgerService {
  constructor(private readonly database: Transactable) {}

  /** 作品の「利用許諾計算」：その作品を許諾している作家の一覧。 */
  async forWork(workId: number, today = new Date().toISOString().slice(0, 10)): Promise<{ parties: WorkRoyaltyParty[] }> {
    try {
      const r = await this.database.query(
        `SELECT DISTINCT c.counterparty_id FROM conditions c
          WHERE c.work_id = $1 AND c.direction = 'in' AND c.kind = 'license'
            AND c.status IN ('active', 'scheduled') AND c.pricing_model IN ('revenue_rate', 'unit_rate')`,
        [workId]);
      const out: WorkRoyaltyParty[] = [];
      for (const row of r.rows as any[]) {
        const view = await this.ledger(Number(row.counterparty_id), workId, today);
        const others = await this.database.query(
          `SELECT count(DISTINCT work_id)::int AS n FROM conditions
            WHERE counterparty_id = $1 AND direction = 'in' AND kind = 'license'
              AND status IN ('active', 'scheduled') AND work_id IS NOT NULL AND work_id <> $2`,
          [row.counterparty_id, workId]);
        out.push({
          id: view.party.id, name: view.party.name, kind: view.party.kind, bundle: view.party.bundle,
          conditions: view.conditions.map((c) => ({ id: c.id, usageLabel: c.usageLabel, ratePpm: c.ratePpm, timing: c.timing })),
          openRounds: view.rounds.length,
          waiting: view.rounds.flatMap((x) => x.parts).filter((p) => p.state === "waiting").length,
          nextPayOn: view.rounds.map((x) => x.payOn ?? x.closeOn).filter(Boolean).sort()[0] ?? null,
          otherWorks: Number((others.rows[0] as any)?.n ?? 0),
          requests: [...view.requests, ...view.rounds.flatMap((x) => x.requests)]
            .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
        });
      }
      return { parties: out.sort((a, b) => a.name.localeCompare(b.name, "ja")) };
    } catch (error) { throw translate(error); }
  }

  /** 台帳。workId を渡せば作家 × その作品、渡さなければ作家 × 全作品。 */
  async ledger(partyId: number, workId: number | null, today = new Date().toISOString().slice(0, 10)): Promise<LedgerView> {
    const q = this.database;
    try {
      const p = (await q.query(
        `SELECT id, name, kind, residency, royalty_bundle FROM parties WHERE id = $1`, [partyId])).rows[0] as any;
      if (!p) throw new DomainError("NOT_FOUND", `取引先 ${partyId} が見つかりません`);
      const bundle: Bundle = p.royalty_bundle === "per_party" ? "per_party" : "per_work";
      const work = workId
        ? (await q.query("SELECT id, title FROM works WHERE id = $1", [workId])).rows[0] as any
        : null;
      if (workId && !work) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);

      const cr = await q.query(
        `SELECT c.id, c.condition_no, c.name, c.usage_type, c.work_id, w.title AS work_title,
                c.agreement_id, a.agreement_no, c.pricing_model, c.rate_ppm, c.unit_amount,
                c.mg_amount, c.ag_amount, c.currency, c.payment_terms, c.statement_timing,
                COALESCE(c.series_id, c.id) AS series
           FROM conditions c
           LEFT JOIN works w ON w.id = c.work_id
           LEFT JOIN agreements a ON a.id = c.agreement_id
          WHERE c.counterparty_id = $1 AND c.direction = 'in' AND c.kind = 'license'
            AND c.status IN ('active', 'scheduled') AND c.pricing_model IN ('revenue_rate', 'unit_rate')
            AND ($2::bigint IS NULL OR c.work_id = $2)
          ORDER BY w.title NULLS LAST, c.condition_no NULLS LAST, c.id`, [partyId, workId]);
      const rows = cr.rows as any[];
      const ids = rows.map((c) => Number(c.id));
      // 実績・予定は改訂の全版に付いたまま残る。版をまたいで今の版に寄せる。
      const series = ids.length ? (await q.query(
        `SELECT x.id, COALESCE(x.series_id, x.id) AS series FROM conditions x
          WHERE COALESCE(x.series_id, x.id) = ANY($1::bigint[])`,
        [rows.map((c) => Number(c.series))])).rows as any[] : [];
      const currentOf = new Map<number, number>();
      for (const s of series) {
        const cur = rows.find((c) => Number(c.series) === Number(s.series));
        if (cur) currentOf.set(Number(s.id), Number(cur.id));
      }
      const allIds = [...currentOf.keys()];

      const schedules = allIds.length ? ((await q.query(
        `SELECT id, condition_id, seq, due_on, pay_on, label FROM condition_schedules
          WHERE condition_id = ANY($1::bigint[]) AND trigger_kind = 'periodic'`, [allIds])).rows as any[])
        .map((s): ScheduleLite => ({ id: Number(s.id), conditionId: currentOf.get(Number(s.condition_id))!,
          seq: Number(s.seq), dueOn: dateStr(s.due_on), payOn: dateStr(s.pay_on), label: str(s.label) }))
        : [];
      const events = allIds.length ? ((await q.query(
        `SELECT e.id, e.condition_id, e.schedule_id, e.event_type, e.occurred_on, e.period, e.usage_type,
                e.out_condition_id, oc.name AS out_name, e.work_id, ew.title AS work_title,
                e.quantity, e.unit_amount, e.gross_amount, e.amount, e.document_id, d.status AS document_status, d.document_no,
                e.scope_languages, e.scope_regions
           FROM condition_events e
           LEFT JOIN conditions oc ON oc.id = e.out_condition_id
           LEFT JOIN works ew ON ew.id = e.work_id
           LEFT JOIN documents d ON d.id = e.document_id
          WHERE e.condition_id = ANY($1::bigint[]) AND e.status = 'active'
            AND e.event_type IN ('manufacturing', 'sales', 'sublicense_receipt', 'adjustment')
          ORDER BY e.occurred_on, e.id`, [allIds])).rows as any[])
        .map((e): LedgerEvent => ({
          id: Number(e.id), conditionId: currentOf.get(Number(e.condition_id))!, scheduleId: int(e.schedule_id),
          eventType: String(e.event_type), occurredOn: dateStr(e.occurred_on), period: str(e.period),
          usageType: str(e.usage_type), outConditionId: int(e.out_condition_id), outName: str(e.out_name),
          workId: int(e.work_id), workTitle: str(e.work_title),
          quantity: e.quantity === null ? null : Number(e.quantity), unitAmount: int(e.unit_amount),
          grossAmount: int(e.gross_amount), amount: Number(e.amount ?? 0),
          // 無効にした文書に付いたままの実績は、まだ出していない扱い。
          documentId: e.document_id && e.document_status === "issued" ? Number(e.document_id) : null,
          documentNo: e.document_id && e.document_status === "issued" ? str(e.document_no) : null,
          languages: Array.isArray(e.scope_languages) ? e.scope_languages.map(String) : [],
          regions: Array.isArray(e.scope_regions) ? e.scope_regions.map(String) : []
        }))
        : [];
      const skips = ids.length ? ((await q.query(
        `SELECT condition_id, schedule_id FROM royalty_round_skips WHERE condition_id = ANY($1::bigint[])`,
        [allIds])).rows as any[]).map((s) => ({ conditionId: currentOf.get(Number(s.condition_id))!, scheduleId: Number(s.schedule_id) }))
        : [];
      const workIds = [...new Set(rows.map((c) => int(c.work_id)).filter((x): x is number => !!x))];
      const outs = workIds.length ? ((await q.query(
        `SELECT id, name, usage_type, work_id, term_start,
                (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                  WHERE sc.condition_id = conditions.id AND sc.scope_type = 'language') AS languages,
                (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                  WHERE sc.condition_id = conditions.id AND sc.scope_type = 'region') AS regions
           FROM conditions
          WHERE direction = 'out' AND status IN ('active', 'scheduled')
            AND usage_type IN ('sublicense', 'oem') AND work_id = ANY($1::bigint[])`, [workIds])).rows as any[])
        .map((o): OutLite => ({ id: Number(o.id), name: String(o.name), usageType: str(o.usage_type),
                                workId: int(o.work_id), termStart: dateStr(o.term_start),
                                languages: Array.isArray(o.languages) ? o.languages.map(String) : [],
                                regions: Array.isArray(o.regions) ? o.regions.map(String) : [] }))
        : [];

      const conditions: LedgerCondition[] = rows.map((c) => ({
        id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name),
        usageType: str(c.usage_type), usageLabel: c.usage_type ? conditionUsageLabel(c.usage_type) : "利用形態なし",
        workId: int(c.work_id), workTitle: str(c.work_title),
        agreementId: int(c.agreement_id), agreementNo: str(c.agreement_no),
        pricingModel: String(c.pricing_model), ratePpm: int(c.rate_ppm), unitAmount: int(c.unit_amount),
        mgAmount: int(c.mg_amount), agAmount: int(c.ag_amount), currency: String(c.currency ?? "JPY"),
        paymentTerms: str(c.payment_terms),
        timing: timingOf(c.statement_timing, c.usage_type), timingExplicit: Boolean(c.statement_timing),
        schedules: schedules.filter((s) => s.conditionId === Number(c.id)).length
      }));

      const built = buildRounds({ conditions, schedules, events, skips, outs, today,
        bundle: workId ? "single_work" : bundle });

      // 文書・送付・支払。
      const docIds = [...new Set(events.map((e) => e.documentId).filter((x): x is number => !!x))];
      const docs = docIds.length ? (await q.query(
        `SELECT d.id, d.document_no, d.status,
                EXISTS (SELECT 1 FROM audit_events a WHERE a.target_type = 'document' AND a.target_id = d.id
                         AND a.action IN ('gmail.send', 'cloudsign.send')) AS sent,
                COALESCE((SELECT sum(s.net_amount) FROM statements s WHERE s.document_id = d.id), 0) AS net
           FROM documents d WHERE d.id = ANY($1::bigint[])`, [docIds])).rows as any[] : [];
      const eventIds = events.map((e) => e.id);
      const pays = eventIds.length ? (await q.query(
        `SELECT DISTINCT p.id, p.payment_no, p.status, p.amount, p.due_on, p.paid_on, al.event_id
           FROM payments p JOIN payment_allocations al ON al.payment_id = p.id
          WHERE al.event_id = ANY($1::bigint[])`, [eventIds])).rows as any[] : [];

      // 依頼（受付箱で案件にせず処理した計算書の依頼）。回へは人が選んで繋ぐ（自動では付けない）。
      //   linkedReqs … 回（予定明細の行・実績）に繋いだ依頼
      //   pendingReqs … この作家・作品（条件）に繋がっているが、まだ回を選んでいない依頼
      const scheduleIds = schedules.map((x) => x.id);
      const linkedReqs = (scheduleIds.length || eventIds0(events).length) ? (await q.query(
        `SELECT r.id, r.request_no, r.title, r.due_on, r.done_at, st.name AS assignee_name,
                l.target_type, l.target_id
           FROM intake_request_links l
           JOIN intake_requests r ON r.id = l.request_id
           LEFT JOIN staff st ON st.id = r.assignee_staff_id
          WHERE (l.target_type = 'schedule' AND l.target_id = ANY($1::bigint[]))
             OR (l.target_type = 'event' AND l.target_id = ANY($2::bigint[]))
          ORDER BY r.id`, [scheduleIds, eventIds0(events)])).rows as any[] : [];
      const pendingReqs = allIds.length ? (await q.query(
        `SELECT DISTINCT r.id, r.request_no, r.title, r.due_on, r.done_at, st.name AS assignee_name
           FROM intake_requests r
           JOIN intake_request_links l ON l.request_id = r.id AND l.target_type = 'condition'
           LEFT JOIN staff st ON st.id = r.assignee_staff_id
          WHERE r.state = 'accepted' AND r.handling = 'direct' AND r.done_at IS NULL
            AND l.target_id = ANY($1::bigint[])
            AND NOT EXISTS (SELECT 1 FROM intake_request_links x
                             WHERE x.request_id = r.id
                               AND ((x.target_type = 'schedule' AND x.target_id = ANY($2::bigint[]))
                                 OR (x.target_type = 'event' AND x.target_id = ANY($3::bigint[]))))
          ORDER BY r.id`, [allIds, scheduleIds, eventIds0(events)])).rows as any[] : [];
      const requestOf = (x: any): RoundRequest => ({ id: Number(x.id), requestNo: str(x.request_no),
        title: String(x.title), assigneeName: str(x.assignee_name), dueOn: dateStr(x.due_on), done: Boolean(x.done_at) });

      const settled = built.map((round) => {
        const evIds = new Set(round.parts.flatMap((p) => p.events.map((e) => e.id)));
        const dIds = new Set(round.parts.flatMap((p) => p.events.map((e) => e.documentId)).filter(Boolean));
        round.documents = docs.filter((d) => dIds.has(Number(d.id))).map((d) => ({
          id: Number(d.id), documentNo: str(d.document_no), status: String(d.status),
          sent: Boolean(d.sent), net: Number(d.net ?? 0) }));
        const seen = new Set<number>();
        round.payments = pays.filter((x) => evIds.has(Number(x.event_id)) && !seen.has(Number(x.id)) && seen.add(Number(x.id)))
          .map((x) => ({ id: Number(x.id), paymentNo: str(x.payment_no), status: String(x.status),
                         amount: Number(x.amount ?? 0), dueOn: dateStr(x.due_on), paidOn: dateStr(x.paid_on) }));
        return settleRound(round);
      });

      // 繋いだ依頼を、その予定明細の行・実績を含む回に出す。
      const openRounds = settled.filter((r) => r.open);
      for (const round of settled) {
        const hits = linkedReqs.filter((x) => round.parts.some((p) =>
          (x.target_type === "schedule" && p.scheduleId === Number(x.target_id))
          || (x.target_type === "event" && p.eventId === Number(x.target_id))));
        round.requests = hits.map(requestOf).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
      }

      const worksList = [...new Map(conditions.filter((c) => c.workId).map((c) =>
        [c.workId!, { id: c.workId!, title: c.workTitle ?? "", conditions: conditions.filter((x) => x.workId === c.workId).length }])).values()];
      return {
        party: { id: Number(p.id), name: String(p.name), kind: String(p.kind), residency: String(p.residency ?? "resident"),
                 bundle, bundleExplicit: Boolean(p.royalty_bundle) },
        scope: work ? { workId: Number(work.id), workTitle: String(work.title) } : null,
        works: worksList,
        conditions,
        rounds: openRounds,
        history: settled.filter((r) => !r.open).reverse(),
        requests: pendingReqs.map(requestOf)
      };
    } catch (error) { throw translate(error); }
  }

  /** 今期は無し（その回は報告が来なかった）。取り消しは undo。 */
  async skip(conditionId: number, scheduleId: number, reason: string | null, actor: string, undo = false) {
    try {
      return await inTransaction(this.database, async (client) => {
        const s = (await client.query(
          `SELECT s.id FROM condition_schedules s JOIN conditions c ON c.id = s.condition_id
            WHERE s.id = $1 AND COALESCE(c.series_id, c.id) =
                  (SELECT COALESCE(series_id, id) FROM conditions WHERE id = $2)`, [scheduleId, conditionId])).rows[0];
        if (!s) throw new DomainError("NOT_FOUND", "その条件の予定明細が見つかりません");
        if (undo) {
          await client.query("DELETE FROM royalty_round_skips WHERE condition_id = $1 AND schedule_id = $2",
            [conditionId, scheduleId]);
        } else {
          // 回を指している実績と、回を指さず発生日がその回の期間に入る実績（台帳と同じ読み方）。
          const has = await client.query(
            `WITH s AS (
               SELECT x.id, x.due_on,
                      lag(x.due_on) OVER (ORDER BY x.due_on) AS prev_due
                 FROM condition_schedules x
                WHERE x.condition_id IN (SELECT id FROM conditions WHERE COALESCE(series_id, id) =
                                          (SELECT COALESCE(series_id, id) FROM conditions WHERE id = $1))
                  AND x.trigger_kind = 'periodic' AND x.due_on IS NOT NULL)
             SELECT 1 FROM condition_events e, s
              WHERE s.id = $2 AND e.status = 'active'
                AND e.condition_id IN (SELECT id FROM conditions WHERE COALESCE(series_id, id) =
                                        (SELECT COALESCE(series_id, id) FROM conditions WHERE id = $1))
                AND (e.schedule_id = $2
                     OR (e.schedule_id IS NULL AND e.occurred_on <= s.due_on
                         AND (s.prev_due IS NULL OR e.occurred_on > s.prev_due)))
              LIMIT 1`, [conditionId, scheduleId]);
          if (has.rows[0]) throw new DomainError("CONFLICT", "この回には実績が入っています。報告なしにはできません");
          await client.query(
            `INSERT INTO royalty_round_skips (condition_id, schedule_id, reason, created_by)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [conditionId, scheduleId, reason, actor]);
        }
        await recordAudit(client, {
          actor, action: undo ? "royalty.unskip" : "royalty.skip", targetType: "condition", targetId: conditionId,
          detail: { scheduleId, reason }
        });
        return { conditionId, scheduleId, skipped: !undo };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 古い空の回をまとめて「報告なし」にする。V3 より前から続く条件は、実績の無い
   * 過去の予定明細が報告待ちとして並ぶ。人が日付を決めて、それより前の締めの
   * 空の回を一度に閉じる（実績のある回・締め前の回には触らない）。
   */
  async skipBefore(partyId: number, workId: number | null, before: string, actor: string) {
    const view = await this.ledger(partyId, workId);
    const targets = view.rounds.flatMap((r) => r.parts)
      .filter((p) => p.scheduleId && p.state === "waiting" && p.closeOn && p.closeOn < before);
    try {
      return await inTransaction(this.database, async (client) => {
        for (const p of targets) {
          await client.query(
            `INSERT INTO royalty_round_skips (condition_id, schedule_id, reason, created_by)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [p.conditionId, p.scheduleId, `${before} より前の空の回をまとめて報告なし`, actor]);
        }
        await recordAudit(client, { actor, action: "royalty.skip_before", targetType: "party", targetId: partyId,
          detail: { workId, before, count: targets.length } });
        return { count: targets.length };
      });
    } catch (error) { throw translate(error); }
  }

  /** 計算書の出し方（時限式／イベント式）。null で既定（利用形態から）に戻す。 */
  async setTiming(conditionId: number, timing: Timing | null, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE conditions SET statement_timing = $2, updated_at = now() WHERE id = $1 RETURNING id`,
          [conditionId, timing]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
        await recordAudit(client, { actor, action: "royalty.timing", targetType: "condition",
          targetId: conditionId, detail: { timing } });
        return { conditionId, timing };
      });
    } catch (error) { throw translate(error); }
  }

  /** 作家の計算書のまとめ方。null で既定（作品ごと）に戻す。 */
  async setBundle(partyId: number, bundle: Bundle | null, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE parties SET royalty_bundle = $2, updated_at = now() WHERE id = $1 RETURNING id`,
          [partyId, bundle]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `取引先 ${partyId} が見つかりません`);
        await recordAudit(client, { actor, action: "royalty.bundle", targetType: "party",
          targetId: partyId, detail: { bundle } });
        return { partyId, bundle };
      });
    } catch (error) { throw translate(error); }
  }
}
