import { type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ConditionScheduleService } from "../conditions/schedule-service.js";
import { ConditionEventService } from "../conditions/event-service.js";
import { DocumentIssueService } from "../documents/issue-service.js";
import { PaymentService } from "../payments/service.js";
import { ClosingService, type PeriodRow } from "./service.js";
import { documentFor, needsReport, notYet } from "./state.js";
import { loadDistribution, loadShares } from "../royalty/shares.js";
import type { StatementIssuer } from "../royalty/statement-issue.js";

/**
 * まとめて締める。
 *
 * 選んだ回について 実績 → 決済文書 → 支払 を続けて進める。1回ぶんで3手、
 * 6か月ぶんなら18手を人が押していた。
 *
 * 作るものは既存の入口と同じ経路を通す（実績は ConditionScheduleService.record、
 * 文書は DocumentIssueService、支払は PaymentService.createFromInspection）。
 * ここで別の作り方をすると、画面から1件ずつ押したときと違うものができる。
 *
 * 決めごと3つ：
 * - 決済文書の決定日はその回の締め日。紙の日付と台帳の決定日を合わせる。
 * - 支払は「立てる」まで。払った事実は銀行にしかない。
 * - 料率で売上報告の入っていない回は対象から外す。金額が出ない。
 * - 料率（売上報告ベース）の計算書の回は、検収書の道ではなく計算書の道（StatementIssuer）で
 *   締める。実績の額は報告売上で、そのまま支払にすると料率が掛からない。計算書は試算の行を
 *   焼き付け、支払は計算書から立てる。共著の取り分（直接払い）は受取人ごとに 1 枚。
 */

/** 計算書の道で締める回。料率（売上報告ベース）の許諾。 */
export const isStatementRow = (row: Pick<PeriodRow, "kind" | "pricingModel">): boolean =>
  documentFor(row.kind).templateKey === "royalty_statement" && needsReport(row.pricingModel);

/** 計算書 1 枚ぶん。宛先（受取人か相手先）・載る条件と実績・回。 */
export interface StatementDocPlan {
  key: string;
  party: { id: number; name: string } | null;
  payeePartyId: number | null;
  rows: PeriodRow[];
  entries: Array<{ conditionId: number; eventIds: number[]; payeePartyId: number | null }>;
}

/** 締められない理由。preview でも run でも同じ言葉を使う。 */
export type Refusal =
  | "needs_report"      // 料率で売上報告が無い
  | "no_planned_amount" // 予定額が無いので「予定どおり」で記録できない
  | "no_closing_date"   // 締め日が無い
  | "unplanned"         // 予定の回ではない（浮いた実績）
  | "not_yet"           // 締め日がまだ来ていない
  | "done";             // すでに締め済

export const REFUSAL_LABEL: Record<Refusal, string> = {
  needs_report: "売上報告が入っていません。報告を入れてから締めてください",
  no_planned_amount: "予定額が入っていません。実績の額を決められません",
  no_closing_date: "締め日が入っていません",
  unplanned: "予定の回ではありません。個別に締めてください",
  not_yet: "締め日がまだ来ていません。締め日を過ぎてから締めてください",
  done: "すでに締め済です"
};

export interface CloseTarget {
  scheduleId: number;
  conditionId: number;
  conditionName: string;
  seq: number | null;
  label: string | null;
  closingOn: string | null;
  party: { id: number; name: string } | null;
  /** この回で起こすこと。すでに済んでいる手は入らない。 */
  willRecordEvent: boolean;
  amount: number | null;
  /** 予定の額。締める前に直したときに比べられるように。 */
  plannedAmount: number | null;
  /** 画面で直した額で記録する。 */
  overridden: boolean;
  documentLabel: string;
  dueOn: string | null;
  dueSource: string;
  dueLabel: string;
}

export interface CloseSkip { scheduleId: number; conditionName: string; seq: number | null;
                             reason: Refusal; label: string }

/**
 * 決済文書のまとめ方。
 * - condition: 条件ごとに1枚（これまでどおり）。
 * - party: 相手先ごとに1枚。同じ相手先・同じ種類の文書・同じ通貨の条件を
 *   1枚の検収書と1件の支払にまとめる。定期払いの条件がいくつもある相手先で、
 *   条件の画面を行き来せずに済む。
 */
export type CloseBundle = "condition" | "party";

/** 締める前に直す実績の額。予定どおりでない回だけ渡す。 */
export interface CloseOverride { amount?: number | null; note?: string | null }
export type CloseOverrides = Record<number, CloseOverride>;

export interface CloseOptions { bundle?: CloseBundle; overrides?: CloseOverrides }

export interface CloseDocPlan {
  /** 先頭の条件（条件ごとのときはその条件）。 */
  conditionId: number;
  conditionName: string;
  /** この1枚に載る条件。相手先ごとにまとめると複数になる。 */
  conditionIds: number[];
  conditionNames: string[];
  party: { id: number; name: string } | null;
  templateKey: string;
  documentLabel: string;
  /** その文書に載る回。締め日のいちばん遅い日を決定日にする。 */
  scheduleIds: number[];
  issuedOn: string | null;
  amount: number;
  willCreatePayment: boolean;
}

export interface ClosePreview {
  targets: CloseTarget[];
  skipped: CloseSkip[];
  documents: CloseDocPlan[];
  numbers: Array<{ templateKey: string; label: string; prefix: string; year: number;
                   count: number; from: string; to: string }>;
  bundle: CloseBundle;
  summary: {
    rows: number; parties: number;
    events: number; documents: number; payments: number; total: number;
    /** 支払期日の根拠が「上限60日」になる件数。条件に支払条件が無い。 */
    dueByLimit: number;
  };
}

export interface CloseOutcome {
  scheduleId: number;
  conditionId: number;
  conditionName: string;
  seq: number | null;
  ok: boolean;
  eventId: number | null;
  documentId: number | null;
  documentNo: string | null;
  paymentId: number | null;
  paymentNo: string | null;
  /** どこまで進んだか。落ちたときにどこで止まったかが読める。 */
  reached: "event" | "document" | "payment";
  error: string | null;
}

export interface CloseResult {
  ok: number; failed: number;
  outcomes: CloseOutcome[];
  skipped: CloseSkip[];
}

// ---------------------------------------------------------------------------

/** その回を締められるか。締められないなら理由。 */
export function refusalFor(
  row: PeriodRow, today: string, override?: CloseOverride
): Refusal | null {
  if (row.step === "done") return "done";
  if (row.scheduleId === null) return "unplanned";
  if (!row.closingOn) return "no_closing_date";
  // 締め日の前に締めると、決済文書の決定日が先の日付になる。紙に刷った日と
  // 台帳の決定日が食い違うので、issue 側でも弾かれる。
  if (notYet(row.closingOn, today)) return "not_yet";
  if (row.step === "event") {
    // 料率は売上報告からしか金額が出ない。予定額で埋めてはいけない。
    if (needsReport(row.pricingModel)) return "needs_report";
    // 画面で額を入れた回は、予定額が無くても締められる。
    if (!row.plannedAmount && !(override?.amount && override.amount > 0)) return "no_planned_amount";
  }
  return null;
}

/** 締める前に直した額を読む。予定と違う額には理由が要る。 */
export function readOverrides(raw: CloseOverrides | undefined): CloseOverrides {
  const out: CloseOverrides = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const id = Math.trunc(Number(key));
    if (!(id > 0) || !value) continue;
    const amount = value.amount === null || value.amount === undefined || Number.isNaN(Number(value.amount))
      ? null : Math.round(Number(value.amount));
    if (amount !== null && amount <= 0) {
      throw new DomainError("VALIDATION", "実績の金額は1以上で入れてください");
    }
    const note = typeof value.note === "string" && value.note.trim() ? value.note.trim() : null;
    if (amount === null && !note) continue;
    out[id] = { amount, note };
  }
  return out;
}

/** 予定と違う額で記録するなら理由が要る。検収書の変更履歴に出るため。 */
function assertReasons(rows: PeriodRow[], overrides: CloseOverrides) {
  const missing = rows.filter((r) => {
    const o = overrides[r.scheduleId!];
    return o?.amount && r.plannedAmount && o.amount !== r.plannedAmount && !o.note;
  });
  if (missing.length) {
    throw new DomainError("VALIDATION",
      `予定と違う額にした回は理由を入れてください（${missing.map((r) =>
        `${r.conditionName}${r.seq ? ` 第${r.seq}回` : ""}`).join("・")}）`);
  }
}

/**
 * 1枚にまとめる鍵。相手先ごとでも、文書の種類と通貨が違えば分ける
 * （検収書と計算書を1枚にはできない。通貨の違う額は足せない）。
 */
export function bundleKey(row: PeriodRow, bundle: CloseBundle): string {
  if (bundle === "condition") return `c:${row.conditionId}`;
  return `p:${row.party?.id ?? `c${row.conditionId}`}:${documentFor(row.kind).templateKey}:${row.currency || "JPY"}`;
}

/** その回で記録する（した）額。直した額 → 実績 → 予定。 */
function amountOf(row: PeriodRow, overrides: CloseOverrides): number | null {
  if (row.eventAmount !== null) return row.eventAmount;
  return overrides[row.scheduleId ?? 0]?.amount ?? row.plannedAmount;
}

export class ClosingCloseService {
  private readonly reads: ClosingService;
  constructor(
    private readonly database: Transactable,
    private readonly today = () => new Date(),
    private readonly schedules = new ConditionScheduleService(database),
    private readonly events = new ConditionEventService(database),
    private readonly issues = new DocumentIssueService(database),
    private readonly payments = new PaymentService(database)
  ) {
    this.reads = new ClosingService(database);
  }

  /** 計算書の道。routes が文書作成フォームと同じものを渡す（渡さなければ検収書の道のまま）。 */
  private statements: StatementIssuer | null = null;
  useStatements(issuer: StatementIssuer): this { this.statements = issuer; return this; }
  private viaStatement(row: PeriodRow): boolean { return this.statements !== null && isStatementRow(row); }

  /**
   * 計算書の回を 1 枚ずつの組にする。相手先ごとなら宛先（受取人か相手先）× 通貨、条件ごとなら
   * 条件 × 受取人。共著の取り分（直接払い）の条件は、取り分の人数ぶん計算書が出る。
   * 載せる実績は、選んだ回に付いた、まだ文書の無い実績。
   */
  async statementDocs(rows: PeriodRow[], bundle: CloseBundle): Promise<StatementDocPlan[]> {
    const scheduleIds = rows.map((r) => r.scheduleId!).filter(Boolean);
    if (!scheduleIds.length) return [];
    const events = (await this.database.query(
      `SELECT id, schedule_id FROM condition_events
        WHERE schedule_id = ANY($1::bigint[]) AND status = 'active' AND document_id IS NULL
        ORDER BY id`, [scheduleIds])).rows as Array<{ id: number; schedule_id: number }>;
    const eventsOf = new Map<number, number[]>();
    for (const e of events) eventsOf.set(Number(e.schedule_id), [...(eventsOf.get(Number(e.schedule_id)) ?? []), Number(e.id)]);

    const payeesOf = new Map<number, Array<{ id: number; name: string } | null>>();
    for (const conditionId of new Set(rows.map((r) => r.conditionId))) {
      const shares = await loadShares(this.database, conditionId);
      const direct = shares.length > 0 && await loadDistribution(this.database, conditionId) === "direct";
      payeesOf.set(conditionId, direct ? shares.map((x) => ({ id: x.partyId, name: x.partyName })) : [null]);
    }

    const docs = new Map<string, StatementDocPlan>();
    for (const row of rows) {
      const eventIds = eventsOf.get(row.scheduleId!) ?? [];
      if (!eventIds.length) continue;
      for (const payee of payeesOf.get(row.conditionId) ?? [null]) {
        const to = payee ?? row.party;
        // 受取人として載る分と、自分が相手先の条件は別の紙（受取人宛ての紙は載る条件すべてに取り分が要る）。
        const key = bundle === "party"
          ? `s:${to?.id ?? `c${row.conditionId}`}:${payee ? "payee" : "party"}:${row.currency || "JPY"}`
          : `s:c${row.conditionId}:${payee?.id ?? 0}`;
        const doc = docs.get(key) ?? { key, party: to, payeePartyId: payee?.id ?? null, rows: [], entries: [] };
        if (!doc.rows.includes(row)) doc.rows.push(row);
        const entry = doc.entries.find((x) => x.conditionId === row.conditionId);
        if (entry) entry.eventIds.push(...eventIds);
        else doc.entries.push({ conditionId: row.conditionId, eventIds: [...eventIds], payeePartyId: payee?.id ?? null });
        docs.set(key, doc);
      }
    }
    return [...docs.values()];
  }

  /**
   * 何が起きるかを先に出す。枚数・番号・合計・支払期日の根拠まで。
   * 押したあとに「思っていたのと違う」が起きないようにする。
   */
  async preview(scheduleIds: number[], options: CloseOptions = {}): Promise<ClosePreview> {
    try {
      const bundle: CloseBundle = options.bundle === "party" ? "party" : "condition";
      const overrides = readOverrides(options.overrides);
      const rows = await this.rowsFor(scheduleIds);
      const today = this.today().toISOString().slice(0, 10);
      const refuse = (row: PeriodRow) => refusalFor(row, today, overrides[row.scheduleId ?? 0]);
      const targets: CloseTarget[] = [];
      const skipped: CloseSkip[] = [];

      for (const row of rows) {
        const refusal = refuse(row);
        if (refusal) {
          skipped.push({ scheduleId: row.scheduleId ?? 0, conditionName: row.conditionName,
                         seq: row.seq, reason: refusal, label: REFUSAL_LABEL[refusal] });
          continue;
        }
        targets.push({
          scheduleId: row.scheduleId!,
          conditionId: row.conditionId,
          conditionName: row.conditionName,
          seq: row.seq, label: row.label, closingOn: row.closingOn, party: row.party,
          willRecordEvent: row.step === "event",
          amount: amountOf(row, overrides),
          plannedAmount: row.plannedAmount,
          overridden: row.step === "event" && !!overrides[row.scheduleId!]?.amount,
          documentLabel: row.documentLabel,
          dueOn: row.due.on, dueSource: row.due.source, dueLabel: row.due.label
        });
      }

      // 計算書の回は、報告売上ではなく料率を掛けた額（試算）を出す。
      const statementRows = rows.filter((r) => !refuse(r) && r.documentId === null && this.viaStatement(r));
      const statementPlans = await this.statementDocs(statementRows, bundle);
      const royaltyOf = new Map<number, number>();
      for (const row of statementRows) {
        const eventIds = statementPlans.flatMap((d) => d.entries)
          .filter((e) => e.conditionId === row.conditionId).flatMap((e) => e.eventIds);
        try {
          const [p] = await this.statements!.previewBundle([{ conditionId: row.conditionId, eventIds: [...new Set(eventIds)] }]);
          royaltyOf.set(row.scheduleId!, p.fee.actual_ex_tax);
        } catch { /* 試算できない回は額を出さない（締めるときに理由が出る） */ }
      }
      for (const t of targets) if (royaltyOf.has(t.scheduleId)) t.amount = royaltyOf.get(t.scheduleId)!;

      // 決済文書は条件ごと（または相手先ごと）に1枚。同じ組の回を1枚にまとめる。
      // すでに文書のある回は枚数に数えない（その回は支払だけが残っている）。
      const groups = new Map<string, PeriodRow[]>();
      for (const row of rows) {
        if (refuse(row) || row.documentId !== null || this.viaStatement(row)) continue;
        const key = bundleKey(row, bundle);
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }
      const documents: CloseDocPlan[] = [...groups.values()].map((list) => {
        const head = list[0]!;
        const conditions = new Map(list.map((r) => [r.conditionId, r.conditionName]));
        return {
          conditionId: head.conditionId, conditionName: head.conditionName,
          conditionIds: [...conditions.keys()], conditionNames: [...conditions.values()],
          party: head.party,
          templateKey: documentFor(head.kind).templateKey,
          documentLabel: head.documentLabel,
          scheduleIds: list.map((r) => r.scheduleId!),
          // 1枚に数回を載せるときは、いちばん遅い締め日で決定する。
          issuedOn: list.map((r) => r.closingOn).filter((d): d is string => !!d).sort().at(-1) ?? null,
          amount: list.reduce((a, r) => a + (amountOf(r, overrides) ?? 0), 0),
          willCreatePayment: true
        };
      });
      for (const plan of statementPlans) {
        const head = plan.rows[0]!;
        let amount = 0;
        try {
          const previews = await this.statements!.previewBundle(plan.entries);
          amount = previews.reduce((a, p) => a + p.fee.actual_ex_tax, 0);
        } catch { amount = 0; }
        const conditions = new Map(plan.rows.map((r) => [r.conditionId, r.conditionName]));
        documents.push({
          conditionId: head.conditionId, conditionName: head.conditionName,
          conditionIds: [...conditions.keys()], conditionNames: [...conditions.values()],
          party: plan.party,
          templateKey: documentFor(head.kind).templateKey,
          documentLabel: plan.payeePartyId ? `${head.documentLabel}（受取人 ${plan.party?.name ?? ""}）` : head.documentLabel,
          scheduleIds: plan.rows.map((r) => r.scheduleId!),
          issuedOn: plan.rows.map((r) => r.closingOn).filter((d): d is string => !!d).sort().at(-1) ?? null,
          amount, willCreatePayment: true
        });
      }

      // 支払は文書1枚につき1件。すでに文書のある回はその文書で、まだの回は組で数える。
      const payingRows = rows.filter((r) => !refuse(r) && r.paymentId === null && !(r.documentId === null && this.viaStatement(r)));
      const payingKeys = new Set([
        ...payingRows.map((r) => r.documentId !== null ? `d:${r.documentId}` : bundleKey(r, bundle)),
        ...statementPlans.map((d) => d.key)
      ]);
      return {
        targets, skipped, documents, bundle,
        numbers: await this.peekNumbers(documents),
        summary: {
          rows: targets.length,
          parties: new Set(targets.map((t) => t.party?.id ?? 0)).size,
          events: targets.filter((t) => t.willRecordEvent).length,
          documents: documents.length,
          payments: payingKeys.size,
          total: targets.reduce((a, t) => a + (t.amount ?? 0), 0),
          dueByLimit: targets.filter((t) => t.dueSource === "limit").length
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 締める。
   *
   * 1件でも止まったら終わり、にはしない。できたものはでき、落ちたものは
   * 理由を返す。途中で止めると、どこまで進んだのか画面から読めなくなる
   * （遡及一括の取り込みと同じ考え方）。
   */
  async run(scheduleIds: number[], actor: string, options: CloseOptions = {}): Promise<CloseResult> {
    const plan = await this.preview(scheduleIds, options);
    const overrides = readOverrides(options.overrides);
    const outcomes: CloseOutcome[] = [];

    // 組ごとに進める。決済文書は組（条件、または相手先）で1枚にまとめるので、
    // 回を1つずつ進めると同じ組に何枚も出てしまう。
    // 組の鍵は行から引く（相手先・文書の種類・通貨）。対象の行は preview と同じ。
    const rows = plan.targets.length
      ? await this.rowsFor(plan.targets.map((t) => t.scheduleId)) : [];
    const rowOf = new Map(rows.map((r) => [r.scheduleId!, r]));
    assertReasons(rows.filter((r) => r.step === "event"), overrides);
    // 計算書の回（料率）は計算書の道でまとめて締める。
    const statementRows = rows.filter((r) => r.documentId === null && this.viaStatement(r));
    if (statementRows.length) outcomes.push(...await this.closeStatements(statementRows, plan.bundle, actor));
    const groups = new Map<string, CloseTarget[]>();
    for (const t of plan.targets) {
      const row = rowOf.get(t.scheduleId);
      if (row && statementRows.includes(row)) continue;
      const key = row ? bundleKey(row, plan.bundle) : `c:${t.conditionId}`;
      const list = groups.get(key) ?? [];
      list.push(t);
      groups.set(key, list);
    }

    for (const list of groups.values()) {
      try {
        outcomes.push(...await this.closeGroup(list, actor, overrides));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const t of list) {
          outcomes.push({
            scheduleId: t.scheduleId, conditionId: t.conditionId, conditionName: t.conditionName, seq: t.seq,
            ok: false, eventId: null, documentId: null, documentNo: null,
            paymentId: null, paymentNo: null, reached: "event", error: message
          });
        }
      }
    }

    const result: CloseResult = {
      ok: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o) => !o.ok).length,
      outcomes, skipped: plan.skipped
    };
    // 監査は1回で残す。何回ぶんを誰がいつ締めたかが、これ1件で読める。
    await recordAudit(this.database, {
      action: "closing.run", targetType: "condition_schedule",
      targetId: null, actor,
      detail: { scheduleIds, bundle: plan.bundle, ok: result.ok, failed: result.failed,
                skipped: plan.skipped.length,
                ...(Object.keys(overrides).length ? { overrides } : {}) }
    });
    return result;
  }

  /**
   * 計算書の回を締める。計算書 1 枚ごとに 試算 → 決定 → 計算書を結ぶ（StatementIssuer）→
   * 支払（計算書から）。1 枚が落ちても他は進める。回の結果は、その回が載った計算書が
   * 全部できたときだけ ok。
   */
  private async closeStatements(rows: PeriodRow[], bundle: CloseBundle, actor: string): Promise<CloseOutcome[]> {
    const out = new Map<number, CloseOutcome>(rows.map((r) => [r.scheduleId!, {
      scheduleId: r.scheduleId!, conditionId: r.conditionId, conditionName: r.conditionName, seq: r.seq,
      ok: false, eventId: r.eventId, documentId: null, documentNo: null,
      paymentId: null, paymentNo: null, reached: "event", error: null
    }]));
    const add = (prev: string | null, next: string | null) => [prev, next].filter(Boolean).join("・") || null;
    const docs = await this.statementDocs(rows, bundle);
    for (const doc of docs) {
      const issuedOn = doc.rows.map((r) => r.closingOn).filter((d): d is string => !!d).sort().at(-1) ?? null;
      const dueOn = doc.rows.map((r) => r.due.on).filter((d): d is string => !!d).sort()[0] ?? null;
      const matters = new Set(doc.rows.map((r) => r.matter?.id ?? null));
      try {
        const made = await this.statements!.issue({
          templateKey: documentFor(doc.rows[0]!.kind).templateKey,
          entries: doc.entries, issuedOn,
          matterId: matters.size === 1 ? doc.rows[0]!.matter?.id ?? null : null
        }, actor);
        for (const r of doc.rows) {
          const o = out.get(r.scheduleId!)!;
          o.documentId ??= made.document.id; o.documentNo = add(o.documentNo, made.document.documentNo);
          if (o.reached === "event") o.reached = "document";
        }
        const paid = await this.payments.createFromStatementDocument(made.document.id, actor, { dueOn });
        for (const r of doc.rows) {
          const o = out.get(r.scheduleId!)!;
          o.paymentId ??= paid.paymentId; o.paymentNo = add(o.paymentNo, paid.paymentNo ?? null);
          o.reached = "payment";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const who = doc.payeePartyId ? `（${doc.party?.name ?? "受取人"}）` : "";
        for (const r of doc.rows) {
          const o = out.get(r.scheduleId!)!;
          o.error = add(o.error, `${message}${who}`);
        }
      }
    }
    for (const r of rows) {
      const o = out.get(r.scheduleId!)!;
      if (!docs.some((d) => d.rows.includes(r))) o.error ??= "この回に、計算書に載せられる実績がありません（実績がもう別の文書に結ばれています）";
      o.ok = !o.error && o.paymentId !== null;
    }
    return [...out.values()];
  }

  /** 1つの組（条件、または相手先）の回をまとめて進める。 */
  private async closeGroup(
    targets: CloseTarget[], actor: string, overrides: CloseOverrides
  ): Promise<CloseOutcome[]> {
    const rows = await this.rowsFor(targets.map((t) => t.scheduleId));
    const base = (row: PeriodRow): CloseOutcome => ({
      scheduleId: row.scheduleId!, conditionId: row.conditionId, conditionName: row.conditionName, seq: row.seq,
      ok: false, eventId: row.eventId, documentId: row.documentId, documentNo: row.documentNo,
      paymentId: row.paymentId, paymentNo: row.paymentNo, reached: "event", error: null
    });
    const out = new Map<number, CloseOutcome>(rows.map((r) => [r.scheduleId!, base(r)]));

    // ① 実績。予定どおりの額で記録する。画面で額を直した回はその額と理由で
    //    記録する（理由は検収書の変更履歴に出る）。
    for (const row of rows) {
      const o = out.get(row.scheduleId!)!;
      if (row.eventId !== null) continue;
      const fix = overrides[row.scheduleId!];
      try {
        // 画面の「理由」は差分の記録（検収書の変更履歴の理由）。備考ではない。
        const made = await this.schedules.record(row.conditionId, row.scheduleId!,
          fix ? { amount: fix.amount ?? null, varianceNote: fix.note ?? null } : {}, actor);
        o.eventId = made.eventId;
      } catch (error) {
        o.error = error instanceof Error ? error.message : String(error);
      }
    }

    const live = rows.filter((r) => out.get(r.scheduleId!)!.eventId !== null
                                 && !out.get(r.scheduleId!)!.error);
    if (!live.length) return [...out.values()];

    // ② 決済文書。すでに文書のある回はそのまま使う。
    const needDoc = live.filter((r) => r.documentId === null);
    if (needDoc.length) {
      const head = needDoc[0]!;
      const eventIds = needDoc.map((r) => out.get(r.scheduleId!)!.eventId!);
      const conditionIds = [...new Set(needDoc.map((r) => r.conditionId))];
      // 案件は全部が同じときだけ渡す。違えば決めない（文書の側で引く）。
      const matters = new Set(needDoc.map((r) => r.matter?.id ?? null));
      const issuedOn = needDoc.map((r) => r.closingOn)
        .filter((d): d is string => !!d).sort().at(-1) ?? null;
      try {
        const draft = await this.issues.createDraft({
          templateKey: documentFor(head.kind).templateKey,
          conditionIds,
          matterId: matters.size === 1 ? head.matter?.id ?? null : null
        }, actor);
        const issued = await this.issues.issue(draft.id, actor, { issuedOn, eventIds });
        // 実績は条件ごとに結ぶ（結ぶ側は条件の系列の中しか見ない）。
        for (const conditionId of conditionIds) {
          const own = needDoc.filter((r) => r.conditionId === conditionId)
            .map((r) => out.get(r.scheduleId!)!.eventId!);
          await this.events.linkDocument(conditionId, own, draft.id, actor);
        }
        for (const r of needDoc) {
          const o = out.get(r.scheduleId!)!;
          o.documentId = draft.id; o.documentNo = issued.documentNo; o.reached = "document";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const r of needDoc) out.get(r.scheduleId!)!.error = message;
      }
    }

    // ③ 支払。文書1枚につき1件。額も源泉も文書に結ばれた実績から出す。
    const byDocument = new Map<number, PeriodRow[]>();
    for (const r of live) {
      const o = out.get(r.scheduleId!)!;
      if (o.error || o.documentId === null || o.paymentId !== null) continue;
      const list = byDocument.get(o.documentId) ?? [];
      list.push(r);
      byDocument.set(o.documentId, list);
    }
    for (const [documentId, list] of byDocument) {
      // 期日は回の見立てと同じものを渡す。画面で見て決めた日と、立った支払の
      // 期日が違うと、見て決めた意味がなくなる。
      const dueOn = list.map((r) => r.due.on).filter((d): d is string => !!d).sort()[0] ?? null;
      try {
        // 計算書（料率）の支払は計算書から（実績の額は報告売上で、料率が掛かっていない）。
        const paid = list.some((r) => isStatementRow(r))
          ? await this.payments.createFromStatementDocument(documentId, actor, { dueOn })
          : await this.payments.createFromInspection(documentId, actor, { dueOn });
        for (const r of list) {
          const o = out.get(r.scheduleId!)!;
          o.paymentId = paid.paymentId; o.paymentNo = paid.paymentNo;
          o.reached = "payment"; o.ok = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const r of list) out.get(r.scheduleId!)!.error = message;
      }
    }
    // すでに支払まであった回は、この回で新しく作るものが無い＝済み。
    for (const o of out.values()) if (!o.error && o.paymentId !== null) o.ok = true;
    return [...out.values()];
  }

  /** 選んだ回を、月の表と同じ形で読み直す。判定を2か所に置かない。 */
  private async rowsFor(scheduleIds: number[]): Promise<PeriodRow[]> {
    const ids = [...new Set(scheduleIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "締める回を選んでください");
    if (ids.length > 200) throw new DomainError("VALIDATION", "一度に締められるのは200回までです");

    const conditionIds = await this.database.query(
      "SELECT DISTINCT condition_id FROM condition_schedules WHERE id = ANY($1::bigint[])", [ids]);
    const rows: PeriodRow[] = [];
    for (const row of conditionIds.rows as Array<{ condition_id: number }>) {
      const view = await this.reads.periods(Number(row.condition_id));
      rows.push(...view.rows.filter((r) => r.scheduleId !== null && ids.includes(r.scheduleId)));
    }
    const found = new Set(rows.map((r) => r.scheduleId));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new DomainError("NOT_FOUND", `予定明細が見つかりません（${missing.join("・")}）`);
    }
    return rows;
  }

  /**
   * 使うことになる番号の見込み。確定ではない（間に誰かが1枚出せばずれる）。
   * それでも決定まで一気に流す前に、消費する番号の見当が付くのは大きい。
   */
  private async peekNumbers(plans: CloseDocPlan[]) {
    const out: ClosePreview["numbers"] = [];
    const byTemplate = new Map<string, CloseDocPlan[]>();
    for (const plan of plans) {
      const list = byTemplate.get(plan.templateKey) ?? [];
      list.push(plan);
      byTemplate.set(plan.templateKey, list);
    }
    for (const [templateKey, list] of byTemplate) {
      const prefixRow = await this.database.query(
        "SELECT number_prefix FROM document_templates WHERE template_key = $1", [templateKey]);
      const prefix = String((prefixRow.rows[0] as { number_prefix?: string } | undefined)?.number_prefix ?? "")
        .trim().toUpperCase().replace(/^ARC-/, "");
      if (!prefix) continue;
      // 年ごとに数える。締め日が年をまたぐと連番も分かれる。
      const byYear = new Map<number, number>();
      for (const plan of list) {
        const year = Number((plan.issuedOn ?? "").slice(0, 4)) || new Date().getFullYear();
        byYear.set(year, (byYear.get(year) ?? 0) + 1);
      }
      for (const [year, count] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
        const seq = await this.database.query(
          "SELECT current_value FROM document_sequences WHERE prefix = $1 AND year = $2",
          [prefix, year]);
        const current = Number((seq.rows[0] as { current_value?: number } | undefined)?.current_value ?? 0);
        const fmt = (n: number) => `ARC-${prefix}-${year}-${String(n).padStart(4, "0")}`;
        out.push({ templateKey, label: list[0]!.documentLabel, prefix, year, count,
                   from: fmt(current + 1), to: fmt(current + count) });
      }
    }
    return out;
  }
}
