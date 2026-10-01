import { dateStr, inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import { parsePaymentTerms, payOnFor } from "../conditions/payment-terms.js";
import { basisOf, type UsageType } from "./usage-type.js";
import { ppmToPct } from "./economics.js";
import { roundRoyalty } from "./rounding.js";

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
  /** 対象の許諾先（A-063）。この許諾先だけに効く料率。空なら一律（その作品の許諾先すべて）。 */
  targetPartyId?: number | null; targetPartyName?: string | null;
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
  /** 前金・後金（入金区分）。null は分けない。 */
  paymentStage?: string | null;
  /** 受領額が税込で入っているか（割り戻して算定する）。null は未指定（税抜として扱う）。 */
  taxIncluded?: boolean | null;
  /** 報告の備考。前金・後金の報告では計算書の備考に出る説明。 */
  note?: string | null;
}

/** 来るはずの行（前の回にあった・生きている許諾先がある）。 */
export interface ExpectedLine {
  usageType: string | null; outConditionId: number | null; outName: string | null;
  workId: number | null; workTitle: string | null; why: string;
  /** 言語ごとに報告が来る許諾は、言語ごとに1行（A-061）。 */
  languages?: string[]; regions?: string[];
  /** 人が置いた「予定」の行なら、その id（A-062。「予定を外す」で消す）。 */
  planId?: number;
}

/** 人が置いた「予定」の行（A-062）。from_on 以降の回で来るはずとして待つ。 */
export interface PlanLite {
  id: number; conditionId: number; outConditionId: number | null; outName: string | null;
  languages: string[]; regions: string[]; fromOn: string;
}

export type PartState = "before" | "waiting" | "reported" | "skipped" | "issued";

export interface RoundPart {
  conditionId: number; scheduleId: number | null; eventId: number | null;
  label: string | null; periodFrom: string | null; closeOn: string | null; payOn: string | null;
  events: LedgerEvent[]; skipped: boolean; expected: ExpectedLine[]; state: PartState;
}

export type RoundState = "before" | "input" | "ready" | "issued" | "sent" | "scheduled" | "paid" | "skipped" | "nopay";

export interface RoundDocument {
  id: number; documentNo: string | null; status: string; sent: boolean; net: number;
  /** この計算書の実績に割り当てた支払（取り消していないもの）。空なら「支払なし」。 */
  paymentIds: number[];
}
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
  /** この許諾先の改訂の全版の id。古い版を指す報告も同じ許諾先として扱う。 */
  seriesIds?: number[];
  /** 許諾先（取引先）。許諾先専用の IN 条件と突き合わせる。 */
  partyId?: number | null;
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
  plans?: PlanLite[];
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
      // 製造 1 回＝回 1 つ。1 回の製造に、許諾先・言語・前金後金ごとの報告が何件も付く
      // （英語版 Asmodee の前金・後金、ドイツ語版 MM-Spiele …）。製造日で束ねて
      // 1 本にし、多明細の計算書 1 枚にする。
      const byDay = new Map<string, LedgerEvent[]>();
      for (const e of events) {
        const day = e.occurredOn ?? "";
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(e);
      }
      for (const [day, list] of byDay) {
        const on = day || null;
        // 支払日は製造日から条件の支払条件（製造月の翌月末など）で決める。
        parts.push({ conditionId: c.id, scheduleId: null, eventId: list[0].id,
          label: list.find((e) => e.period)?.period ?? null,
          periodFrom: on, closeOn: on,
          payOn: payOnFor(on, parsePaymentTerms(c.paymentTerms)), events: list, skipped: false,
          expected: [], state: list.every((e) => e.documentId) ? "issued" : "reported" });
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
        // 許諾先専用の IN 条件（A-063）はその許諾先の OUT だけ。一律の IN 条件は、
        // 同じ作品・利用形態で専用の条件が持っている許諾先を除いた残り。
        const claimed = new Set(conditions
          .filter((x) => x.id !== c.id && x.workId === c.workId && x.usageType === c.usageType && x.targetPartyId)
          .map((x) => x.targetPartyId!));
        for (const o of input.outs.filter((x) => x.usageType === c.usageType
            && (x.workId === null || x.workId === c.workId)
            && (c.targetPartyId ? x.partyId === c.targetPartyId : !(x.partyId && claimed.has(x.partyId)))
            && (!x.termStart || !p.closeOn || x.termStart <= p.closeOn))) {
          // 報告は 言語×地域 ごとに来る（英語×北米、英語×欧州、フランス語×欧州）。
          // 1組1行で待つ。「全言語」「全世界」は分けない（1行）。
          const langs = (o.languages ?? []).filter((l) => l !== "全言語");
          const regs = (o.regions ?? []).filter((r) => r !== "全世界");
          // 1つでも行に持たせる（報告の言語・地域が実績に入り、計算書の製品名・許諾範囲に出る）。
          const ls = langs.length ? langs : [null];
          const rs = regs.length ? regs : [null];
          const sameOut = (id: number | null) => id !== null && (id === o.id || (o.seriesIds ?? []).includes(id));
          // 前の回から来た行は、いまの許諾範囲に合わせる。途中で許諾言語・地域を変えた
          // 許諾先では、古い言語・地域の行を待ち続けない（範囲の外の行は落とし、
          // 古い版を指す行はいまの版に寄せる）。
          for (const [k, x] of [...expected.entries()]) {
            if (x.why !== "前の回にあった" || !sameOut(x.outConditionId)) continue;
            const within = (given: string[] | undefined, allowed: string[]) =>
              !(given ?? []).length || !allowed.length || (given ?? []).every((g) => allowed.includes(g));
            if (!within(x.languages, langs) || !within(x.regions, regs)) { expected.delete(k); continue; }
            x.outConditionId = o.id; x.outName = o.name;
          }
          for (const l of ls) for (const r of rs) {
            // 言語・地域を持たない報告・行（A-061 より前のもの）は、その組を覆っているとみなす。
            const match = (e: { languages?: string[]; regions?: string[] }) =>
              (!l || !(e.languages ?? []).length || (e.languages ?? []).includes(l))
              && (!r || !(e.regions ?? []).length || (e.regions ?? []).includes(r));
            const hit = p.events.some((e) => sameOut(e.outConditionId) && match(e));
            if (hit) continue;
            const dup = [...expected.values()].find((x) => x.outConditionId === o.id && match(x));
            if (dup) {
              // 前の回から来た行が言語・地域を欠いていれば、許諾先の範囲で埋める
              // （その行に打った報告に言語・地域が入るように）。
              if (l && !(dup.languages ?? []).length) dup.languages = [l];
              if (r && !(dup.regions ?? []).length) dup.regions = [r];
              continue;
            }
            expected.set(`${c.usageType}|${o.id}||${l ?? ""}|${r ?? ""}`,
              { usageType: c.usageType, outConditionId: o.id, outName: o.name,
                workId: null, workTitle: null, why: "生きている許諾先",
                languages: l ? [l] : [], regions: r ? [r] : [] });
          }
        }
      }
      // 人が置いた予定の行（A-062）。締めが from_on 以降の回で待つ。
      for (const pl of (input.plans ?? []).filter((x) => x.conditionId === c.id)) {
        if (p.closeOn && p.closeOn < pl.fromOn) continue;
        const match = (e: { outConditionId: number | null; languages?: string[]; regions?: string[] }) =>
          (e.outConditionId ?? null) === (pl.outConditionId ?? null)
          && pl.languages.every((l) => (e.languages ?? []).includes(l))
          && pl.regions.every((r) => (e.regions ?? []).includes(r));
        if (p.events.some(match)) continue;
        const dup = [...expected.entries()].find(([, x]) => match(x));
        if (dup) { dup[1].planId = pl.id; dup[1].why = "予定"; continue; }
        expected.set(`plan:${pl.id}`, { usageType: c.usageType, outConditionId: pl.outConditionId, outName: pl.outName,
                                        workId: null, workTitle: null, why: "予定", languages: pl.languages, regions: pl.regions,
                                        planId: pl.id });
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
    // イベント式は製造日で 1 回（同じ作品の別の利用形態の報告も、同じ製造日なら同じ回）。
    const key = p.eventId !== null && c.timing === "event"
      ? (input.bundle === "per_party" ? `e:${p.closeOn ?? p.eventId}` : `e:${c.workId ?? 0}:${p.closeOn ?? p.eventId}`)
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
  /** 時限式の締め（予定明細）。回の整理（報告をどの締めに付けるか）で使う。 */
  schedules: ScheduleLite[];
  rounds: Round[];
  history: Round[];
  requests: RoundRequest[];
}

export interface WorkRoyaltyParty {
  id: number; name: string; kind: string; bundle: Bundle;
  conditions: Array<{ id: number; usageLabel: string; ratePpm: number | null; timing: Timing; targetPartyName?: string | null }>;
  openRounds: number; waiting: number; nextPayOn: string | null;
  otherWorks: number;
  requests: RoundRequest[];
  /** 次にすること。報告待ちの行がある最初の回。無ければ null（締め前など）。 */
  next: { roundKey: string; label: string; waiting: number; closeOn: string | null } | null;
  /** 時限式なのに締めが無い条件。回が立たないので、先に締めを作る案内を出す。 */
  noClose: Array<{ id: number; usageLabel: string }>;
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
          conditions: view.conditions.map((c) => ({ id: c.id, usageLabel: c.usageLabel, ratePpm: c.ratePpm, timing: c.timing,
                                                    targetPartyName: c.targetPartyName ?? null })),
          openRounds: view.rounds.length,
          waiting: view.rounds.flatMap((x) => x.parts).filter((p) => p.state === "waiting").length,
          nextPayOn: view.rounds.map((x) => x.payOn ?? x.closeOn).filter(Boolean).sort()[0] ?? null,
          otherWorks: Number((others.rows[0] as any)?.n ?? 0),
          requests: [...view.requests, ...view.rounds.flatMap((x) => x.requests)]
            .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i),
          noClose: view.conditions.filter((c) => c.timing === "periodic" && !c.schedules)
            .map((c) => ({ id: c.id, usageLabel: c.usageLabel })),
          next: (() => {
            const waitingOf = (x: Round) => x.parts.reduce((n, p) =>
              n + (p.state === "waiting" ? Math.max(p.expected.length, 1) : p.state === "before" ? 0 : p.expected.length), 0);
            const hit = view.rounds.find((x) => x.open && waitingOf(x) > 0);
            if (!hit) return null;
            const label = [...new Set(hit.parts.map((p) => p.label).filter(Boolean))].slice(0, 2).join("・") || (hit.payOn ?? "");
            return { roundKey: hit.key, label, waiting: waitingOf(hit), closeOn: hit.closeOn };
          })()
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
                c.target_party_id, tp.name AS target_party_name,
                COALESCE(c.series_id, c.id) AS series
           FROM conditions c
           LEFT JOIN works w ON w.id = c.work_id
           LEFT JOIN agreements a ON a.id = c.agreement_id
           LEFT JOIN parties tp ON tp.id = c.target_party_id
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
                e.scope_languages, e.scope_regions, e.payment_stage, e.tax_included, e.note
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
          regions: Array.isArray(e.scope_regions) ? e.scope_regions.map(String) : [],
          paymentStage: str(e.payment_stage),
          taxIncluded: e.tax_included === null || e.tax_included === undefined ? null : Boolean(e.tax_included),
          note: str(e.note)
        }))
        : [];
      const skips = ids.length ? ((await q.query(
        `SELECT condition_id, schedule_id FROM royalty_round_skips WHERE condition_id = ANY($1::bigint[])`,
        [allIds])).rows as any[]).map((s) => ({ conditionId: currentOf.get(Number(s.condition_id))!, scheduleId: Number(s.schedule_id) }))
        : [];
      const plans: PlanLite[] = ids.length ? ((await q.query(
        `SELECT pl.id, pl.condition_id, pl.out_condition_id, oc.name AS out_name,
                pl.scope_languages, pl.scope_regions, pl.from_on
           FROM royalty_expected_lines pl
           LEFT JOIN conditions oc ON oc.id = pl.out_condition_id
          WHERE pl.condition_id = ANY($1::bigint[])
          ORDER BY pl.id`, [allIds])).rows as any[])
        .map((x) => ({ id: Number(x.id), conditionId: currentOf.get(Number(x.condition_id))!,
                       outConditionId: int(x.out_condition_id), outName: str(x.out_name),
                       languages: Array.isArray(x.scope_languages) ? x.scope_languages.map(String) : [],
                       regions: Array.isArray(x.scope_regions) ? x.scope_regions.map(String) : [],
                       fromOn: dateStr(x.from_on) ?? "0000-01-01" }))
        : [];
      const workIds = [...new Set(rows.map((c) => int(c.work_id)).filter((x): x is number => !!x))];
      const outs = workIds.length ? ((await q.query(
        `SELECT id, name, usage_type, work_id, term_start, counterparty_id,
                (SELECT array_agg(x.id) FROM conditions x
                  WHERE COALESCE(x.series_id, x.id) = COALESCE(conditions.series_id, conditions.id)) AS series_ids,
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
                                regions: Array.isArray(o.regions) ? o.regions.map(String) : [],
                                seriesIds: Array.isArray(o.series_ids) ? o.series_ids.map(Number) : [],
                                partyId: int(o.counterparty_id) }))
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
        schedules: schedules.filter((s) => s.conditionId === Number(c.id)).length,
        targetPartyId: int(c.target_party_id), targetPartyName: str(c.target_party_name)
      }));

      const built = buildRounds({ conditions, schedules, events, skips, outs, plans, today,
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
        `SELECT r.id, r.request_no, r.title, r.due_on, t.done_at, st.name AS assignee_name,
                l.target_type, l.target_id
           FROM intake_request_links l
           JOIN intake_requests r ON r.id = l.request_id
           LEFT JOIN tasks t ON t.request_id = r.id
           LEFT JOIN staff st ON st.id = t.assignee_staff_id
          WHERE (l.target_type = 'schedule' AND l.target_id = ANY($1::bigint[]))
             OR (l.target_type = 'event' AND l.target_id = ANY($2::bigint[]))
          ORDER BY r.id`, [scheduleIds, eventIds0(events)])).rows as any[] : [];
      const pendingReqs = allIds.length ? (await q.query(
        `SELECT DISTINCT r.id, r.request_no, r.title, r.due_on, t.done_at, st.name AS assignee_name
           FROM intake_requests r
           JOIN intake_request_links l ON l.request_id = r.id AND l.target_type = 'condition'
           LEFT JOIN tasks t ON t.request_id = r.id
           LEFT JOIN staff st ON st.id = t.assignee_staff_id
          WHERE r.state = 'accepted' AND r.handling = 'direct' AND t.done_at IS NULL
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
        round.documents = docs.filter((d) => dIds.has(Number(d.id))).map((d) => {
          const docEvents = new Set(round.parts.flatMap((p) => p.events.filter((e) => e.documentId === Number(d.id)).map((e) => e.id)));
          return {
            id: Number(d.id), documentNo: str(d.document_no), status: String(d.status),
            sent: Boolean(d.sent), net: Number(d.net ?? 0),
            paymentIds: [...new Set(pays.filter((x) => docEvents.has(Number(x.event_id)) && x.status !== "canceled").map((x) => Number(x.id)))]
          };
        });
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
          || (x.target_type === "event" && p.events.some((e) => e.id === Number(x.target_id)))));
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
        schedules,
        rounds: openRounds,
        history: settled.filter((r) => !r.open).reverse(),
        requests: pendingReqs.map(requestOf)
      };
    } catch (error) { throw translate(error); }
  }

  /** 今期は無し（その回は報告が来なかった）。取り消しは undo。 */
  /**
   * 決定した計算書に載った報告を例外的に直す。
   *
   * 数字（数量・単価・受領額・発生日）を直し、利用形態のある実績は許諾料
   * （実額）も条件の料率で計算し直す。直した実績はまだ元の計算書に結ばれた
   * ままなので、続けて台帳から訂正版を出す（/statement-documents に
   * supersedesId を付けて出すと、決定の瞬間に元が退いて実績が移る）。
   * 支払が立っていれば直せない（events.amend が止める）。
   */
  async correct(
    input: { conditionId: number; eventId: number; reason: string;
             quantity?: number | null; unitAmount?: number | null; grossAmount?: number | null; occurredOn?: string | null;
             languages?: string[] | null; regions?: string[] | null;
             taxIncluded?: boolean | null; paymentStage?: "advance" | "balance" | null; note?: string | null;
             /** 決定した計算書に載った報告を直せるのは admin だけ。載っていない報告は legal も直せる。 */
             isAdmin?: boolean },
    events: { amend: (conditionId: number, eventId: number, patch: Record<string, unknown>, reason: string, actor: string)
                => Promise<{ eventId: number; changed: string[] }> },
    actor: string
  ): Promise<{ eventId: number; documentId: number | null; documentNo: string | null; changed: string[] }> {
    try {
      const row = (await this.database.query(
        `SELECT e.id, e.condition_id, e.usage_type, e.quantity, e.sample_quantity, e.unit_amount, e.gross_amount,
                e.payment_stage, e.tax_included, e.out_condition_id, COALESCE(e.rate_ppm, c.rate_ppm) AS rate_ppm,
                e.document_id, d.document_no, d.status AS document_status
           FROM condition_events e JOIN conditions c ON c.id = e.condition_id
           LEFT JOIN documents d ON d.id = e.document_id
          WHERE e.id = $1 AND e.condition_id = $2 AND e.status = 'active'`, [input.eventId, input.conditionId])).rows[0] as any;
      if (!row) throw new DomainError("NOT_FOUND", `実績 ${input.eventId} が見つかりません`);
      if (row.document_status === "issued" && input.isAdmin === false) {
        throw new DomainError("FORBIDDEN", "決定した計算書に載った報告を直せるのは管理者だけです");
      }
      const patch: Record<string, unknown> = {};
      if (input.taxIncluded !== undefined) patch.taxIncluded = input.taxIncluded;
      if (input.paymentStage !== undefined) patch.paymentStage = input.paymentStage;
      if (input.note !== undefined) patch.note = input.note;
      if (input.quantity !== undefined) patch.quantity = input.quantity;
      if (input.unitAmount !== undefined) patch.unitAmount = input.unitAmount;
      if (input.grossAmount !== undefined) patch.grossAmount = input.grossAmount;
      if (input.occurredOn !== undefined) patch.occurredOn = input.occurredOn;
      if (input.languages !== undefined) patch.languages = input.languages;
      if (input.regions !== undefined) patch.regions = input.regions;
      const usage = str(row.usage_type);
      if (usage) {
        // 許諾料は入れ直させない。直した根拠に料率を掛けて出す（記録のときと同じ式）。
        const basis = basisOf({
          usageType: usage as UsageType,
          unitAmount: input.unitAmount !== undefined ? input.unitAmount : int(row.unit_amount),
          quantity: input.quantity !== undefined ? input.quantity : (row.quantity === null ? null : Number(row.quantity)),
          sampleQuantity: row.sample_quantity === null ? null : Number(row.sample_quantity),
          grossAmount: input.grossAmount !== undefined ? input.grossAmount : int(row.gross_amount),
          paymentStage: input.paymentStage !== undefined ? input.paymentStage : (row.payment_stage ?? null),
          taxIncluded: input.taxIncluded !== undefined ? input.taxIncluded : (row.tax_included ?? null)
        }, "この報告");
        patch.amount = roundRoyalty((basis * ppmToPct(int(row.rate_ppm))) / 100);
      } else if (input.grossAmount !== undefined) {
        // 利用形態なし（出版など）は 総額＝実額。
        patch.amount = input.grossAmount;
      }
      const r = await events.amend(input.conditionId, input.eventId, patch, input.reason, actor);
      return { eventId: input.eventId, documentId: row.document_status === "issued" ? int(row.document_id) : null,
               documentNo: str(row.document_no), changed: r.changed };
    } catch (error) { throw translate(error); }
  }

  /**
   * 許諾先（OUT 条件）から見た報告。台帳で入れた実績は許諾料を払う IN 条件に付くので、
   * OUT 条件の画面ではここから引いて見せる（IN 条件・締め・計算書へのリンク付き）。
   */
  async outReports(outConditionId: number): Promise<{
    events: Array<{ id: number; occurredOn: string | null; period: string | null; languages: string[]; regions: string[];
                    quantity: number | null; grossAmount: number | null; amount: number; currency: string;
                    inConditionId: number; inConditionNo: string | null; partyName: string | null;
                    workId: number | null; workTitle: string | null;
                    documentId: number | null; documentNo: string | null; documentStatus: string | null }>;
    inConditions: Array<{ id: number; conditionNo: string | null; usageLabel: string; partyId: number | null; partyName: string | null;
                          workId: number | null; workTitle: string | null; schedules: number; nextCloseOn: string | null }>;
  }> {
    try {
      const series = `(SELECT id FROM conditions WHERE COALESCE(series_id, id) =
                        (SELECT COALESCE(series_id, id) FROM conditions WHERE id = $1))`;
      const ev = (await this.database.query(
        `SELECT e.id, e.occurred_on, e.period, e.scope_languages, e.scope_regions, e.quantity, e.gross_amount, e.amount,
                c.id AS in_id, c.condition_no AS in_no, c.currency, p.name AS party_name, w.id AS work_id, w.title AS work_title,
                d.id AS document_id, d.document_no, d.status AS document_status
           FROM condition_events e
           JOIN conditions c ON c.id = e.condition_id
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
           LEFT JOIN documents d ON d.id = e.document_id
          WHERE e.out_condition_id IN ${series} AND e.status = 'active'
          ORDER BY e.occurred_on DESC, e.id DESC`, [outConditionId])).rows as any[];
      const ins = (await this.database.query(
        `SELECT c.id, c.condition_no, c.usage_type, c.counterparty_id, p.name AS party_name, w.id AS work_id, w.title AS work_title,
                (SELECT count(*)::int FROM condition_schedules s WHERE s.condition_id = c.id) AS schedules,
                (SELECT min(s.due_on) FROM condition_schedules s WHERE s.condition_id = c.id AND s.due_on >= CURRENT_DATE) AS next_close
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
          WHERE c.direction = 'in' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
            AND c.usage_type = (SELECT usage_type FROM conditions WHERE id = $1)
            AND (c.work_id = (SELECT work_id FROM conditions WHERE id = $1)
                 OR c.id IN (SELECT DISTINCT condition_id FROM condition_events WHERE out_condition_id IN ${series}))
          ORDER BY w.title NULLS LAST, c.id`, [outConditionId])).rows as any[];
      return {
        events: ev.map((e) => ({
          id: Number(e.id), occurredOn: dateStr(e.occurred_on), period: str(e.period),
          languages: Array.isArray(e.scope_languages) ? e.scope_languages.map(String) : [],
          regions: Array.isArray(e.scope_regions) ? e.scope_regions.map(String) : [],
          quantity: e.quantity === null ? null : Number(e.quantity), grossAmount: int(e.gross_amount), amount: Number(e.amount ?? 0),
          currency: String(e.currency ?? "JPY"),
          inConditionId: Number(e.in_id), inConditionNo: str(e.in_no), partyName: str(e.party_name),
          workId: int(e.work_id), workTitle: str(e.work_title),
          documentId: int(e.document_id), documentNo: str(e.document_no), documentStatus: str(e.document_status)
        })),
        inConditions: ins.map((c) => ({
          id: Number(c.id), conditionNo: str(c.condition_no), usageLabel: conditionUsageLabel(str(c.usage_type)),
          partyId: int(c.counterparty_id), partyName: str(c.party_name), workId: int(c.work_id), workTitle: str(c.work_title),
          schedules: Number(c.schedules ?? 0), nextCloseOn: dateStr(c.next_close)
        }))
      };
    } catch (error) { throw translate(error); }
  }

  /** 予定の行を置く（A-062）。許諾先は、その条件の作品の OUT 条件に限る。 */
  async plan(input: { conditionId: number; outConditionId: number | null; languages: string[]; regions: string[];
                      fromOn: string; note?: string | null }, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const c = (await client.query(
          `SELECT id, usage_type, work_id FROM conditions WHERE id = $1 AND direction = 'in'`, [input.conditionId])).rows[0] as any;
        if (!c) throw new DomainError("NOT_FOUND", `条件 ${input.conditionId} が見つかりません`);
        if (input.outConditionId) {
          const o = (await client.query(
            `SELECT id FROM conditions WHERE id = $1 AND direction = 'out' AND status IN ('active', 'scheduled', 'draft')`,
            [input.outConditionId])).rows[0];
          if (!o) throw new DomainError("NOT_FOUND", "許諾先（OUT 条件）が見つかりません");
        } else if (c.usage_type === "sublicense" || c.usage_type === "oem") {
          throw new DomainError("VALIDATION", "再許諾・他社販売の予定は許諾先を選んでください");
        }
        const r = await client.query(
          `INSERT INTO royalty_expected_lines
             (condition_id, out_condition_id, scope_languages, scope_regions, from_on, note, created_by)
           VALUES ($1, $2, $3::text[], $4::text[], $5::date, $6, $7) RETURNING id`,
          [input.conditionId, input.outConditionId, input.languages, input.regions, input.fromOn,
           str(input.note), actor]);
        const id = Number((r.rows[0] as any).id);
        await recordAudit(client, { actor, action: "royalty.plan_add", targetType: "condition", targetId: input.conditionId,
          detail: { planId: id, outConditionId: input.outConditionId, languages: input.languages, regions: input.regions, fromOn: input.fromOn } });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /** 予定の行を外す。実績は消えない（予定は「来るはず」の目印なだけ）。 */
  async unplan(id: number, actor: string): Promise<{ ok: true }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query("DELETE FROM royalty_expected_lines WHERE id = $1 RETURNING condition_id", [id]);
        const row = r.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", "その予定の行はもうありません");
        await recordAudit(client, { actor, action: "royalty.plan_remove", targetType: "condition",
          targetId: Number(row.condition_id), detail: { planId: id } });
        return { ok: true };
      });
    } catch (error) { throw translate(error); }
  }

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

  /**
   * 報告をどの回に付けるかを変える（過去分の整理）。
   *
   *   時限式 … 締め（schedule_id）を指させる。null にすると発生日で回に振り分ける。
   *   イベント式 … 報告 1 件＝回 1 つなので締めは持たない（null）。
   *
   * 決定した計算書に載った報告は動かせない（紙の根拠が変わる）。締めは同じ条件
   * （改訂の全版）のものだけ。
   */
  async moveEvent(conditionId: number, eventId: number, scheduleId: number | null, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const row = (await client.query(
          `SELECT e.id, e.condition_id, e.schedule_id, e.document_id, d.status AS document_status, d.document_no,
                  COALESCE(c.series_id, c.id) AS series
             FROM condition_events e
             JOIN conditions c ON c.id = e.condition_id
             LEFT JOIN documents d ON d.id = e.document_id
            WHERE e.id = $1 AND e.status = 'active' FOR UPDATE OF e`, [eventId])).rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `報告 ${eventId} が見つかりません`);
        const ok = (await client.query(
          `SELECT 1 FROM conditions WHERE id = $1 AND COALESCE(series_id, id) = $2`, [conditionId, row.series])).rows[0];
        if (!ok) throw new DomainError("VALIDATION", `報告 ${eventId} は条件 ${conditionId} のものではありません`);
        if (row.document_status === "issued") {
          throw new DomainError("CONFLICT",
            `報告 ${eventId} は決定した計算書 ${row.document_no ?? `#${row.document_id}`} に載っています。` +
            "回を変えるには、先にその計算書を無効化するか訂正版を出してください");
        }
        if (scheduleId !== null) {
          const sc = (await client.query(
            `SELECT s.id, s.label, s.due_on FROM condition_schedules s JOIN conditions c ON c.id = s.condition_id
              WHERE s.id = $1 AND s.trigger_kind = 'periodic' AND COALESCE(c.series_id, c.id) = $2`,
            [scheduleId, row.series])).rows[0] as any;
          if (!sc) throw new DomainError("NOT_FOUND", `締め ${scheduleId} はこの条件のものではありません`);
        }
        const before = int(row.schedule_id);
        if (before === scheduleId) return { eventId, scheduleId, changed: false };
        await client.query(`UPDATE condition_events SET schedule_id = $2 WHERE id = $1`, [eventId, scheduleId]);
        await recordAudit(client, { actor, action: "royalty.move_event", targetType: "condition",
          targetId: conditionId, detail: { eventId, from: before, to: scheduleId } });
        return { eventId, scheduleId, changed: true };
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
