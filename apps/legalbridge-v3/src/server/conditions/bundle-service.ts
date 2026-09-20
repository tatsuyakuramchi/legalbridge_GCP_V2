import type { Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import type { ConditionWriteService } from "./write-service.js";
import type { ConditionScheduleService, ScheduleLine } from "./schedule-service.js";
import type { ConditionEventService } from "./event-service.js";
import type { PaymentService } from "../payments/service.js";

/**
 * 条件1本を、段をまたいでまとめて直す（工程表の「まとめて直す」）。
 *
 * これまでは条件・予定・実績・支払がそれぞれ別の画面で、別々に保存していた。
 * 「納品数を減らしたので金額も予定も実績も支払も直す」が4画面4回の保存に
 * なり、どれかを直し忘れると数字が食い違ったまま残る。
 *
 * 段ごとの書き込みは、それぞれの持ち主（条件・予定・実績・支払のサービス）に
 * そのまま任せる。断る条件（決定済みの文書は直せない・支払が立っていると
 * 金額は直せない）を書き写すと、いつか本体とずれるため。
 *
 * ただし任せたままだと、途中で断られたときに前半だけ書けた状態になる。
 * 先に全部の段を下見して、断られると分かっているものがあれば何も書かずに
 * 止める。下見を抜けたあとに落ちたときは、どの段まで書けたかを返す
 * （黙って半分書けているより、どこで止まったかが分かるほうがよい）。
 */

export interface BundlePatch {
  /**
   * 条件そのもの（金額・期間など）。実績が無ければその場で上書き、あれば
   * 版が増える（条件の側の決まり。旧版に付いた実績と割当を壊さないため）。
   */
  condition?: Record<string, unknown>;
  /** 予定明細。全部の回を渡す（入れ替えになる）。 */
  schedules?: ScheduleLine[];
  /** 実績1件。直近のものを想定。 */
  event?: { id: number } & Record<string, unknown>;
  /** 支払1件。 */
  payment?: { id: number } & Record<string, unknown>;
}

export type BundleSection = "condition" | "schedules" | "event" | "payment";

export const SECTION_LABEL: Record<BundleSection, string> = {
  condition: "条件", schedules: "予定", event: "実績", payment: "支払"
};

export interface BundleResult {
  conditionId: number;
  /** 書けた段と、その中で変わった欄。 */
  applied: Array<{ section: BundleSection; changed: string[] }>;
  /** 途中で止まったとき、どの段でなぜ止まったか。 */
  stoppedAt: { section: BundleSection; message: string } | null;
  /**
   * 条件が改訂になったときの新しい条件ID。
   *
   * 実績のある条件の金額を直すと、V3 は上書きせず版を増やす（旧版に付いた
   * 実績や支払の割当を壊さないため）。打ち間違いを正したつもりで版が増えるのは
   * 驚くので、増えたことを黙らずに返す。
   */
  revisedTo: number | null;
}

/** 金額に関わる欄。実績はこれを直すときだけ支払の有無を見る。 */
const EVENT_MONEY = ["amount", "grossAmount", "deductions", "unitAmount", "quantity"];

export class ConditionBundleService {
  constructor(
    private readonly database: Transactable,
    private readonly parts: {
      conditions: ConditionWriteService;
      schedules: ConditionScheduleService;
      events: ConditionEventService;
      payments: PaymentService;
    }
  ) {}

  /**
   * 下見。書く前に、断られると分かっているものを見つける。
   * ここで見るのは「状態のせいで必ず断られるもの」だけで、値の検査は
   * それぞれのサービスに任せる（二重に書くと、いつかずれる）。
   */
  private async preflight(conditionId: number, patch: BundlePatch): Promise<void> {
    const cond = await this.database.query(
      "SELECT status FROM conditions WHERE id = $1", [conditionId]);
    const status = (cond.rows[0] as { status?: string } | undefined)?.status;
    if (!status) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
    if (status === "void") {
      throw new DomainError("CONFLICT", "無効にした条件はまとめて直せません");
    }

    if (patch.event) {
      const ev = await this.database.query(
        `SELECT e.status,
                (SELECT p.payment_no FROM payment_allocations a
                   JOIN payments p ON p.id = a.payment_id
                  WHERE a.event_id = e.id AND p.status <> 'canceled' LIMIT 1) AS blocking_no
           FROM condition_events e WHERE e.id = $1 AND e.condition_id = $2`,
        [patch.event.id, conditionId]);
      const row = ev.rows[0] as { status?: string; blocking_no?: string | null } | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `実績 ${patch.event.id} が見つかりません`);
      if (row.status === "void") {
        throw new DomainError("CONFLICT", "無効にした実績は直せません。実績の欄を空にしてください");
      }
      const touchesMoney = EVENT_MONEY.some((k) => patch.event![k] !== undefined);
      if (touchesMoney && row.blocking_no !== null && row.blocking_no !== undefined) {
        throw new DomainError("CONFLICT",
          `この実績には支払 ${row.blocking_no} が立っています。`
          + "金額・数量を直すには、先にその支払を取り消してください");
      }
    }

    if (patch.payment) {
      const pay = await this.database.query(
        "SELECT status FROM payments WHERE id = $1", [patch.payment.id]);
      const st = (pay.rows[0] as { status?: string } | undefined)?.status;
      if (!st) throw new DomainError("NOT_FOUND", `支払 ${patch.payment.id} が見つかりません`);
      if (st === "canceled") {
        throw new DomainError("CONFLICT", "取り消した支払は直せません。支払の欄を空にしてください");
      }
    }
  }

  async apply(
    conditionId: number, patch: BundlePatch, reason: string, actor: string
  ): Promise<BundleResult> {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "直す理由は必須です");

    try {
      await this.preflight(conditionId, patch);
    } catch (error) { throw translate(error); }

    const applied: BundleResult["applied"] = [];
    let stoppedAt: BundleResult["stoppedAt"] = null;
    let revisedTo: number | null = null;

    // 上の段から順に。手前が止まったら、その先は書かない（数字が半端に進む）。
    const steps: Array<{ section: BundleSection; run: () => Promise<string[]> }> = [];
    if (patch.condition && Object.keys(patch.condition).length) {
      steps.push({
        section: "condition",
        run: async () => {
          // 適用日は渡さない（予約の改訂にはしない）。実績が無ければその場の
          // 上書き、あれば版が増える。どちらになるかは条件の側の決まりに従う。
          const r = await this.parts.conditions.updateEconomics(
            conditionId, patch.condition as never, actor, null);
          // 実績があると、上書きではなく版が増える（write-service の決まり）。
          revisedTo = r.revisedTo ?? null;
          return Object.keys(patch.condition!);
        }
      });
    }
    if (patch.schedules) {
      steps.push({
        section: "schedules",
        run: async () => {
          await this.parts.schedules.replace(conditionId, patch.schedules!, actor);
          return [`${patch.schedules!.length} 行`];
        }
      });
    }
    if (patch.event) {
      steps.push({
        section: "event",
        run: async () => {
          const { id, ...fields } = patch.event!;
          const r = await this.parts.events.amend(conditionId, id, fields, why, actor);
          return r.changed;
        }
      });
    }
    if (patch.payment) {
      steps.push({
        section: "payment",
        run: async () => {
          const { id, ...fields } = patch.payment!;
          const r = await this.parts.payments.amend(id, fields, why, actor);
          return r.changed;
        }
      });
    }
    if (!steps.length) throw new DomainError("VALIDATION", "直す欄がありません");

    for (const step of steps) {
      try {
        applied.push({ section: step.section, changed: await step.run() });
      } catch (error) {
        stoppedAt = { section: step.section, message: (error as Error).message };
        break;
      }
    }

    return { conditionId, applied, stoppedAt, revisedTo };
  }
}
