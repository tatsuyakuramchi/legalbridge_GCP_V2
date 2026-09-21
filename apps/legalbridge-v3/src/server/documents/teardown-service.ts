import { type Transactable, dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { DocumentIssueService } from "./issue-service.js";
import { ConditionEventService } from "../conditions/event-service.js";
import { ConditionWriteService } from "../conditions/write-service.js";
import { PaymentService } from "../payments/service.js";
import { settlesEvents } from "./settlement-docs.js";
import type {
  PlanCondition, PlanDocument, PlanEvent, PlanPayment,
  Step, TeardownInput, TeardownOutcome, TeardownPlan, TeardownResult
} from "./teardown-types.js";
import { groupRows, readRows } from "./settled-batch.js";

/**
 * 案件の決済済みの取引を、作り直しのために畳む。
 *
 * 「発注書と検収書は出してあるが金額が違う。作り直したい」ときの後半分。
 * 前半分（現物を CSV に書き出す）と対になる。
 *
 * 発行した文書は消せない。番号を振って相手に出した記録なので、無効として
 * 残るだけで、番号も戻らない。ここでやるのは「無効にする」であって
 * 「消す」ではない。畳んだぶんの紙はそのまま台帳に残る。
 *
 * ★ 条件は既定で残す
 *
 * 取り込みが既存の条件を当てにいく条件は `status = 'active'`（batch-service の
 * existingCondition）。条件まで無効にすると、入れ直したときに**新しい条件番号**で
 * 作られ、契約との繋がりも権利範囲も引き継がれない。畳むのは紙と金だけにして、
 * 条件はそのまま使い回す。
 *
 * ★ 順番がある
 *
 *   支払 → 決済文書（検収書・計算書）→ 発注書 → 実績 → （条件）
 *
 * 実績は決済文書に結ばれている間は取り消せない。文書を無効にすると実績が
 * 解放されるので、文書が先。支払は実績への割当を持つので、いちばん先。
 */







export class MatterTeardownService {
  constructor(
    private readonly database: Transactable,
    private readonly issues = new DocumentIssueService(database),
    private readonly events = new ConditionEventService(database),
    private readonly conditions = new ConditionWriteService(database),
    private readonly payments = new PaymentService(database)
  ) {}

  /** 何を無効にするかを先に全部出す。押したあとに驚かないように。 */
  async preview(matterId: number, input: TeardownInput): Promise<TeardownPlan> {
    try {
      const head = await this.database.query(
        "SELECT id, matter_no, title FROM matters WHERE id = $1", [matterId]);
      const matter = head.rows[0] as
        { id: number; matter_no: string | null; title: string } | undefined;
      if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      // CSV が来ていれば、そこから対象を決める。
      const fromCsv = input.csv ? await this.readCsv(input.csv) : null;
      const only = fromCsv
        ? fromCsv.foldIds
        : (input.conditionIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
      if (fromCsv && !only.length) {
        throw new DomainError("VALIDATION",
          "CSV の「旧分」が全部「残す」です。畳む条件に 畳む か 無効 を書いてください");
      }
      const conds = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, p.name AS party_name
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
          WHERE c.status <> 'void'
            AND EXISTS (SELECT 1 FROM matter_links ml
                         WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
                           AND ml.target_ref = c.id::text)
            AND ($2::bigint[] = '{}'::bigint[] OR c.id = ANY($2::bigint[]))
          ORDER BY p.name, c.id`, [matterId, only]);
      const conditions: PlanCondition[] = (conds.rows as any[]).map((row) => ({
        id: Number(row.id), conditionNo: str(row.condition_no),
        name: String(row.name ?? ""), partyName: str(row.party_name)
      }));
      const ids = conditions.map((c) => c.id);
      if (!ids.length) {
        throw new DomainError("VALIDATION", "畳む条件明細がありません");
      }

      // 支払。条件の実績への割当から辿る。
      const pays = await this.database.query(
        `SELECT DISTINCT y.id, y.payment_no, y.amount, y.status, y.paid_on
           FROM payments y
           JOIN payment_allocations al ON al.payment_id = y.id
           JOIN condition_events e ON e.id = al.event_id
          WHERE e.condition_id = ANY($1::bigint[]) AND y.status <> 'canceled'
          ORDER BY y.id`, [ids]);
      const payments: PlanPayment[] = (pays.rows as any[]).map((row) => ({
        id: Number(row.id), paymentNo: str(row.payment_no),
        amount: Number(row.amount ?? 0), status: String(row.status),
        paidOn: dateStr(row.paid_on),
        // 払った事実は銀行にしかない。台帳だけ取り消すと突き合わせが壊れる。
        blocked: String(row.status) === "paid"
          ? `${dateStr(row.paid_on) ?? ""} に支払済み。取り消せません（返金か次回相殺として別に記録）`
          : null
      }));

      // 文書。条件に繋がるものと、実績が結ばれているもの。
      const docs = await this.database.query(
        `SELECT d.id, d.document_no, d.status, t.template_key, t.label AS template_name
           FROM documents d
           LEFT JOIN document_template_versions v ON v.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = v.template_id
          WHERE d.status <> 'void'
            AND (EXISTS (SELECT 1 FROM document_conditions dc
                          WHERE dc.document_id = d.id AND dc.condition_id = ANY($1::bigint[]))
              OR EXISTS (SELECT 1 FROM condition_events e
                          WHERE e.document_id = d.id AND e.condition_id = ANY($1::bigint[])))
          ORDER BY d.id`, [ids]);
      const documents: PlanDocument[] = (docs.rows as any[]).map((row) => ({
        id: Number(row.id), documentNo: str(row.document_no),
        templateLabel: str(row.template_name),
        settlement: settlesEvents(str(row.template_key)),
        status: String(row.status), blocked: null
      }));

      const evs = await this.database.query(
        `SELECT e.id, e.condition_id, c.condition_no, e.occurred_on, e.amount,
                d.document_no
           FROM condition_events e
           JOIN conditions c ON c.id = e.condition_id
           LEFT JOIN documents d ON d.id = e.document_id
          WHERE e.condition_id = ANY($1::bigint[]) AND e.status = 'active'
          ORDER BY e.condition_id, e.occurred_on, e.id`, [ids]);
      const events: PlanEvent[] = (evs.rows as any[]).map((row) => ({
        id: Number(row.id), conditionId: Number(row.condition_id),
        conditionNo: str(row.condition_no), occurredOn: dateStr(row.occurred_on),
        amount: Number(row.amount ?? 0), documentNo: str(row.document_no)
      }));

      const voidConditions = fromCsv ? fromCsv.voidIds.length > 0 : input.voidConditions === true;
      const blocked = payments.filter((p) => p.blocked).length;
      return {
        matter: { id: Number(matter.id), matterNo: str(matter.matter_no),
                  title: String(matter.title ?? "") },
        payments, documents, events,
        // CSV なら「無効」と書いた条件だけを畳む。画面からなら全部か全部でないか。
        conditions: !voidConditions ? []
          : fromCsv ? conditions.filter((c) => fromCsv.voidIds.includes(c.id))
          : conditions,
        voidConditions,
        summary: {
          payments: payments.filter((p) => !p.blocked).length,
          documents: documents.length,
          events: events.length,
          conditions: voidConditions ? conditions.length : 0,
          blocked,
          amount: events.reduce((a, e) => a + e.amount, 0)
        },
        warnings: warningsFor({ payments, documents, voidConditions, blocked })
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * CSV の「旧分」を読む。条件番号で指しているものだけを見る。
   *
   * 番号の無い行（新しく作る行）は畳む相手がいないので見ない。読み取りの
   * 規則は取り込みと同じものを通す（見出しの揺れも同じに吸う）。
   */
  private async readCsv(csv: string): Promise<{ foldIds: number[]; voidIds: number[] }> {
    const groups = groupRows(readRows(csv))
      .filter((g) => g.oldHandling !== "keep" && g.conditionNo);
    if (!groups.length) return { foldIds: [], voidIds: [] };

    const found = await this.database.query(
      `SELECT id, condition_no FROM conditions
        WHERE btrim(condition_no) = ANY($1::text[])`,
      [groups.map((g) => String(g.conditionNo).trim())]);
    const byNo = new Map<string, number>(
      (found.rows as Array<{ id: number; condition_no: string }>)
        .map((r) => [String(r.condition_no).trim(), Number(r.id)]));

    const missing = groups.filter((g) => !byNo.has(String(g.conditionNo).trim()));
    if (missing.length) {
      throw new DomainError("NOT_FOUND",
        `条件番号が見つかりません：${missing.map((g) => g.conditionNo).join("・")}`);
    }
    const idOf = (g: typeof groups[number]) => byNo.get(String(g.conditionNo).trim())!;
    return {
      foldIds: groups.map(idOf),
      voidIds: groups.filter((g) => g.oldHandling === "void").map(idOf)
    };
  }

  /**
   * 畳む。順番に流して、落ちたものは理由を返す。
   *
   * 1件でも止まったら終わり、にはしない。ただし段は順に進める。文書が
   * 無効にならなかった実績は、そのあとの取り消しでも弾かれる（結ばれたまま
   * だから）。それは規則どおりの拒否なので、そのまま理由として返す。
   */
  async run(matterId: number, input: TeardownInput, actor: string): Promise<TeardownResult> {
    const why = String(input.reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "畳む理由を書いてください");
    const plan = await this.preview(matterId, input);
    const outcomes: TeardownOutcome[] = [];
    let skipped = 0;

    const attempt = async (step: Step, id: number, label: string, run: () => Promise<unknown>) => {
      try {
        await run();
        outcomes.push({ step, id, label, ok: true, error: null });
      } catch (error) {
        outcomes.push({ step, id, label, ok: false,
                        error: error instanceof Error ? error.message : String(error) });
      }
    };

    // ① 支払。払い済みは触らない。
    for (const pay of plan.payments) {
      if (pay.blocked) { skipped += 1; continue; }
      await attempt("payment", pay.id, pay.paymentNo ?? `#${pay.id}`,
        () => this.payments.cancel(pay.id, why, actor));
    }

    // ② 決済文書が先。無効にすると実績が解放される。
    const ordered = [...plan.documents].sort((a, b) =>
      Number(b.settlement) - Number(a.settlement) || a.id - b.id);
    for (const doc of ordered) {
      await attempt("document", doc.id, doc.documentNo ?? `#${doc.id}`,
        () => this.issues.void(doc.id, why, actor));
    }

    // ③ 実績。②が通っていれば結び先は外れている。
    for (const ev of plan.events) {
      await attempt("event", ev.id, `${ev.conditionNo ?? ev.conditionId} ${ev.occurredOn ?? ""}`,
        () => this.events.void(ev.conditionId, ev.id, why, actor));
    }

    // ④ 条件。既定では通らない（残すのが既定）。
    for (const cond of plan.conditions) {
      await attempt("condition", cond.id, cond.conditionNo ?? `#${cond.id}`,
        () => this.conditions.void(cond.id, why, actor));
    }

    const result: TeardownResult = {
      ok: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o) => !o.ok).length,
      skipped, outcomes
    };
    await recordAudit(this.database, {
      actor, action: "matter.teardown", targetType: "matter", targetId: matterId,
      detail: { reason: why, voidConditions: plan.voidConditions,
                conditionIds: plan.conditions.map((c) => c.id),
                ok: result.ok, failed: result.failed, skipped }
    });
    return result;
  }
}

// ---------------------------------------------------------------------------

/** 押す前に読んでほしいこと。 */
export function warningsFor(input: {
  payments: PlanPayment[]; documents: PlanDocument[];
  voidConditions: boolean; blocked: number;
}): string[] {
  const out: string[] = [];
  const numbered = input.documents.filter((d) => d.documentNo).length;
  if (numbered) {
    out.push(`番号を振って出した文書が ${numbered} 枚あります。`
      + "消えるのではなく無効として残り、番号も戻りません");
  }
  if (input.blocked) {
    out.push(`支払済みの支払が ${input.blocked} 件あります。`
      + "取り消さずに残します（払った事実は銀行にしかありません）");
  }
  if (input.voidConditions) {
    out.push("条件明細も無効にします。入れ直すと新しい条件番号で作られ、"
      + "契約との繋がりと権利範囲は引き継がれません。"
      + "同じ条件へ入れ直すなら、条件は残してください");
  } else {
    out.push("条件明細は残します。入れ直しは同じ条件に載ります"
      + "（取り込みは有効な条件だけを当てにいきます）");
  }
  return out;
}

export type {
  PlanCondition, PlanDocument, PlanEvent, PlanPayment,
  Step, TeardownInput, TeardownOutcome, TeardownPlan, TeardownResult
};
