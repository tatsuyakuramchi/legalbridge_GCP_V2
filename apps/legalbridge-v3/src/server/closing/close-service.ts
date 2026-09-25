import { type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ConditionScheduleService } from "../conditions/schedule-service.js";
import { ConditionEventService } from "../conditions/event-service.js";
import { DocumentIssueService } from "../documents/issue-service.js";
import { PaymentService } from "../payments/service.js";
import { ClosingService, type PeriodRow } from "./service.js";
import { documentFor, needsReport, notYet } from "./state.js";

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
 */

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
  documentLabel: string;
  dueOn: string | null;
  dueSource: string;
  dueLabel: string;
}

export interface CloseSkip { scheduleId: number; conditionName: string; seq: number | null;
                             reason: Refusal; label: string }

export interface CloseDocPlan {
  conditionId: number;
  conditionName: string;
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
export function refusalFor(row: PeriodRow, today: string): Refusal | null {
  if (row.step === "done") return "done";
  if (row.scheduleId === null) return "unplanned";
  if (!row.closingOn) return "no_closing_date";
  // 締め日の前に締めると、決済文書の決定日が先の日付になる。紙に刷った日と
  // 台帳の決定日が食い違うので、issue 側でも弾かれる。
  if (notYet(row.closingOn, today)) return "not_yet";
  if (row.step === "event") {
    // 料率は売上報告からしか金額が出ない。予定額で埋めてはいけない。
    if (needsReport(row.pricingModel)) return "needs_report";
    if (!row.plannedAmount) return "no_planned_amount";
  }
  return null;
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

  /**
   * 何が起きるかを先に出す。枚数・番号・合計・支払期日の根拠まで。
   * 押したあとに「思っていたのと違う」が起きないようにする。
   */
  async preview(scheduleIds: number[]): Promise<ClosePreview> {
    try {
      const rows = await this.rowsFor(scheduleIds);
      const today = this.today().toISOString().slice(0, 10);
      const targets: CloseTarget[] = [];
      const skipped: CloseSkip[] = [];

      for (const row of rows) {
        const refusal = refusalFor(row, today);
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
          amount: row.eventAmount ?? row.plannedAmount,
          documentLabel: row.documentLabel,
          dueOn: row.due.on, dueSource: row.due.source, dueLabel: row.due.label
        });
      }

      // 決済文書は条件ごとに1枚。同じ条件の回を1枚にまとめる。
      // すでに文書のある回は枚数に数えない（その回は支払だけが残っている）。
      const byCondition = new Map<number, PeriodRow[]>();
      for (const row of rows) {
        if (refusalFor(row, today) || row.documentId !== null) continue;
        const list = byCondition.get(row.conditionId) ?? [];
        list.push(row);
        byCondition.set(row.conditionId, list);
      }
      const documents: CloseDocPlan[] = [...byCondition.entries()].map(([conditionId, list]) => {
        const head = list[0]!;
        return {
          conditionId, conditionName: head.conditionName,
          templateKey: documentFor(head.kind).templateKey,
          documentLabel: head.documentLabel,
          scheduleIds: list.map((r) => r.scheduleId!),
          // 1枚に数回を載せるときは、いちばん遅い締め日で決定する。
          issuedOn: list.map((r) => r.closingOn).filter((d): d is string => !!d).sort().at(-1) ?? null,
          amount: list.reduce((a, r) => a + (r.eventAmount ?? r.plannedAmount ?? 0), 0),
          willCreatePayment: true
        };
      });

      const payingRows = rows.filter((r) => !refusalFor(r, today) && r.paymentId === null);
      return {
        targets, skipped, documents,
        numbers: await this.peekNumbers(documents),
        summary: {
          rows: targets.length,
          parties: new Set(targets.map((t) => t.party?.id ?? 0)).size,
          events: targets.filter((t) => t.willRecordEvent).length,
          documents: documents.length,
          payments: new Set(payingRows.map((r) => r.conditionId)).size,
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
  async run(scheduleIds: number[], actor: string): Promise<CloseResult> {
    const plan = await this.preview(scheduleIds);
    const outcomes: CloseOutcome[] = [];

    // 条件ごとに進める。決済文書は条件で1枚にまとめるので、回を1つずつ
    // 進めると同じ条件に何枚も出てしまう。
    const byCondition = new Map<number, CloseTarget[]>();
    for (const t of plan.targets) {
      const list = byCondition.get(t.conditionId) ?? [];
      list.push(t);
      byCondition.set(t.conditionId, list);
    }

    for (const [conditionId, list] of byCondition) {
      try {
        outcomes.push(...await this.closeOne(conditionId, list, actor));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const t of list) {
          outcomes.push({
            scheduleId: t.scheduleId, conditionId, conditionName: t.conditionName, seq: t.seq,
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
      detail: { scheduleIds, ok: result.ok, failed: result.failed,
                skipped: plan.skipped.length }
    });
    return result;
  }

  /** 1つの条件の回をまとめて進める。 */
  private async closeOne(
    conditionId: number, targets: CloseTarget[], actor: string
  ): Promise<CloseOutcome[]> {
    const rows = await this.rowsFor(targets.map((t) => t.scheduleId));
    const base = (row: PeriodRow): CloseOutcome => ({
      scheduleId: row.scheduleId!, conditionId, conditionName: row.conditionName, seq: row.seq,
      ok: false, eventId: row.eventId, documentId: row.documentId, documentNo: row.documentNo,
      paymentId: row.paymentId, paymentNo: row.paymentNo, reached: "event", error: null
    });
    const out = new Map<number, CloseOutcome>(rows.map((r) => [r.scheduleId!, base(r)]));

    // ① 実績。予定どおりの額で記録する。差がある回はここへ来ない
    //    （予定額がそのまま実績になる。理由が要る回は個別のフォームへ）。
    for (const row of rows) {
      const o = out.get(row.scheduleId!)!;
      if (row.eventId !== null) continue;
      try {
        const made = await this.schedules.record(conditionId, row.scheduleId!, {}, actor);
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
      const issuedOn = needDoc.map((r) => r.closingOn)
        .filter((d): d is string => !!d).sort().at(-1) ?? null;
      try {
        const draft = await this.issues.createDraft({
          templateKey: documentFor(head.kind).templateKey,
          conditionIds: [conditionId],
          matterId: head.matter?.id ?? null
        }, actor);
        const issued = await this.issues.issue(draft.id, actor, { issuedOn, eventIds });
        await this.events.linkDocument(conditionId, eventIds, draft.id, actor);
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
        const paid = await this.payments.createFromInspection(documentId, actor, { dueOn });
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
