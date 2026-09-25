import type { Transactable } from "../core/db.js";
import { dateStr } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import type { ConditionWriteService } from "./write-service.js";
import type { ConditionScheduleService, ScheduleLine } from "./schedule-service.js";
import type { ConditionEventService } from "./event-service.js";
import type { PaymentService } from "../payments/service.js";
import type { DocumentIssueService } from "../documents/issue-service.js";
import { redraftManualInputs } from "../documents/reprice.js";
import { targetAmountOf } from "./settlement.js";

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
  /**
   * 訂正版を作る決定済みの文書（発注書・検収書）。
   *
   * 決定した文書は書き換えない（出した紙の記録なので）。直す道は訂正版だけで、
   * ここで作るのは**下書き**。決定も送信もしない。条件を直したあとに作るので、
   * 新しい金額で出せる状態の下書きになる。
   */
  reissue?: number[];
}

export type BundleSection = "condition" | "schedules" | "event" | "payment" | "reissue";

export const SECTION_LABEL: Record<BundleSection, string> = {
  condition: "条件", schedules: "予定", event: "実績", payment: "支払", reissue: "訂正版"
};

export interface ReissuedDraft {
  documentId: number;
  documentNo: string | null;
  /** 作った訂正版の下書き。 */
  draftId: number;
  /**
   * 引き継いだ手入力の明細を引き直した中身（「表紙イラスト ¥120,000 → ¥95,000」
   * 「納品日 2026-11-30 → 2026-12-15」）。画面にそのまま出す。
   */
  repriced: string[];
  /**
   * 引き直せなかった欄と、その理由。
   *
   * 手入力は条件・予定より強い（人が打った値が勝つ）ので、このままだと決定しても
   * 古い値で出る。明細が2本以上あるときなど、どの行が変わったのかは書いた人に
   * しか分からないので、画面で「開いて直して」と言う。
   */
  pending: string[];
}

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
  /** 作った訂正版の下書き。 */
  reissued: ReissuedDraft[];
}

/** 結果の文書。明細を実績から組むので、引き直す日付も実績から取る。 */
const SETTLEMENT_TEMPLATES = new Set(["inspection_certificate", "royalty_statement"]);

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
      documents: DocumentIssueService;
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

    for (const documentId of patch.reissue ?? []) {
      const d = await this.database.query(
        `SELECT d.status, d.document_no,
                (SELECT x.id FROM documents x
                  WHERE x.supersedes_id = d.id AND x.status = 'draft' LIMIT 1) AS open_draft
           FROM documents d WHERE d.id = $1`, [documentId]);
      const row = d.rows[0] as { status?: string; document_no?: string | null; open_draft?: number | null } | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
      const name = row.document_no ?? `#${documentId}`;
      if (row.status !== "issued") {
        throw new DomainError("CONFLICT",
          `${name} は決定済みではないので訂正版を作れません（いまは ${row.status}）`);
      }
      if (row.open_draft) {
        throw new DomainError("CONFLICT",
          `${name} にはもう訂正版の下書きがあります（#${row.open_draft}）。それを直してください`);
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
    const reissued: ReissuedDraft[] = [];

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
    if (patch.reissue?.length) {
      steps.push({
        section: "reissue",
        run: async () => {
          const made: string[] = [];
          for (const documentId of patch.reissue!) {
            made.push(await this.reissueOne(conditionId, documentId, why, actor, revisedTo, reissued));
          }
          return made;
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

    return { conditionId, applied, stoppedAt, revisedTo, reissued };
  }

  /**
   * 決定済みの文書1枚の訂正版（下書き）を作る。
   *
   * 条件が改訂になっていたら、下書きが指す条件を新しい版に張り替える。
   * 引き継いだままだと旧版（古い金額）を指すので、せっかく条件を直しても
   * 訂正版が元と同じ金額で出る。
   *
   * 引き継いだ手入力の明細も、引き直せるなら引き直す。手入力は条件より強いので、
   * 張り替えただけでは紙に古い金額が載ったまま出る。
   */
  private async reissueOne(
    conditionId: number, documentId: number, why: string, actor: string,
    revisedTo: number | null, out: ReissuedDraft[]
  ): Promise<string> {
    const head = await this.database.query(
      `SELECT d.document_no, d.manual_inputs, t.template_key,
              (SELECT array_agg(dc.condition_id ORDER BY dc.line_no, dc.condition_id)
                 FROM document_conditions dc WHERE dc.document_id = d.id) AS condition_ids
         FROM documents d
         LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
         LEFT JOIN document_templates t ON t.id = tv.template_id
        WHERE d.id = $1`, [documentId]);
    const row = head.rows[0] as {
      document_no?: string | null; manual_inputs?: unknown;
      template_key?: string | null; condition_ids?: number[] | null;
    };
    const linked = (row.condition_ids ?? []).map(Number);

    // この条件の系列（改訂の全版）と、いまの金額。
    const series = await this.database.query(
      `SELECT x.id, x.pricing_model, x.flat_amount FROM conditions x, conditions c
        WHERE c.id = $1 AND COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id)`,
      [conditionId]);
    const versions = series.rows as Array<{ id: number; pricing_model: string; flat_amount: number | null }>;
    const old = new Set(versions.map((r) => Number(r.id)));

    let relink: number[] | undefined;
    if (revisedTo) {
      // この条件の系列のぶんだけ、新しい版に差し替える。他の条件は触らない。
      const swapped = [...new Set(linked.map((id) => (old.has(id) ? revisedTo : id)))];
      if (swapped.join(",") !== linked.join(",")) relink = swapped;
    }

    const made = await this.parts.documents.reissue(documentId, why, actor, relink);

    // 手入力の明細を引き直す。この条件だけを載せた文書に限る（何本も載って
    // いると、総額のどこがこの条件のぶんか分けられない）。
    const only = linked.length > 0 && linked.every((id) => old.has(id) || id === revisedTo);
    const target = only
      ? await this.redraftTarget(revisedTo ?? conditionId, versions, row.template_key ?? null) : null;
    let repriced: string[] = [];
    let pending: string[] = [];
    if (target) {
      const next = redraftManualInputs(row.manual_inputs, target);
      if (next) {
        if (next.lines.length) {
          await this.database.query(
            "UPDATE documents SET manual_inputs = $2::jsonb WHERE id = $1",
            [made.id, JSON.stringify(next.manual)]);
        }
        repriced = next.lines;
        pending = next.pending;
      }
    } else if (hasManualAmounts(row.manual_inputs)) {
      pending = ["金額・日付（条件を何本も載せた文書なので、1本ぶんに分けられません）"];
    }

    out.push({ documentId, documentNo: row.document_no ?? null, draftId: made.id, repriced, pending });
    return row.document_no ?? `#${documentId}`;
  }

  /**
   * 引き直す先。発注書は条件と予定明細から、検収書は実績から出る
   * （本文がそこから組まれるので、手入力もそこに合わせる）。
   *
   * 日付は「ぜんぶ同じとき」だけ返す。回ごとにずれているなら、まとめた1日は
   * そもそも無い（本文も「A 〜 B（明細参照）」とまとめ書きになる）。
   */
  private async redraftTarget(
    conditionId: number,
    versions: Array<{ id: number; pricing_model: string; flat_amount: number | null }>,
    templateKey: string | null
  ) {
    const now = versions.find((r) => Number(r.id) === conditionId);
    const amountExTax = targetAmountOf({
      pricingModel: now?.pricing_model,
      flatAmount: now?.flat_amount === null || now?.flat_amount === undefined
        ? null : Number(now.flat_amount)
    });
    const ids = versions.map((r) => Number(r.id));
    // dateStr を通す。pg は date 列を Date で返すので、String() で切ると
    // 「Tue Dec 15」になって紙に載る。
    const one = (kinds: unknown, value: unknown) =>
      (Number(kinds ?? 0) === 1 ? dateStr(value) : null);

    // 結果の文書（検収書・計算書）の明細は実績から組む。日付も実績のもの。
    if (SETTLEMENT_TEMPLATES.has(templateKey ?? "")) {
      const ev = await this.database.query(
        `SELECT count(DISTINCT e.occurred_on)::int AS kinds, max(e.occurred_on) AS occurred_on
           FROM condition_events e
          WHERE e.condition_id = ANY($1::bigint[]) AND e.status = 'active'`, [ids]);
      const e = (ev.rows[0] ?? {}) as Record<string, unknown>;
      return { amountExTax, deliveryOn: one(e.kinds, e.occurred_on), paymentOn: null };
    }

    // 条件の文書（発注書）の明細は予定明細から組む（orderLinesFrom）。
    const sch = await this.database.query(
      `SELECT count(DISTINCT s.due_on)::int AS due_kinds, max(s.due_on) AS due_on,
              count(DISTINCT s.pay_on)::int AS pay_kinds, max(s.pay_on) AS pay_on
         FROM condition_schedules s WHERE s.condition_id = ANY($1::bigint[])`, [ids]);
    const r = (sch.rows[0] ?? {}) as Record<string, unknown>;
    return {
      amountExTax,
      deliveryOn: one(r.due_kinds, r.due_on),
      paymentOn: one(r.pay_kinds, r.pay_on)
    };
  }
}

/**
 * 手入力の明細に金額が入っているか。
 *
 * 手入力は条件より強い（打った額が勝つ）。訂正版に引き継がれるので、
 * 金額を直したつもりでも古い額のまま出る。画面で注意を出すために見る。
 */
const MANUAL_MONEY_KEYS = ["items", "delivery_line_items", "other_fees", "expenses"];

export function hasManualAmounts(manual: unknown): boolean {
  const values = (manual ?? {}) as Record<string, unknown>;
  return MANUAL_MONEY_KEYS.some((key) => {
    const rows = values[key];
    if (!Array.isArray(rows)) return false;
    return rows.some((r) => {
      if (!r || typeof r !== "object") return false;
      const cell = r as Record<string, unknown>;
      return Object.keys(cell).some((k) =>
        /amount|金額|単価|price/i.test(k) && String(cell[k] ?? "").trim() !== "");
    });
  });
}
