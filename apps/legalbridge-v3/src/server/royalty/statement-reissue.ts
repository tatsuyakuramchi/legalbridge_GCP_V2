import type { Queryable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { roundPeriodLabel } from "./annual-closes.js";
import { INDIVIDUAL_PAY_DAY } from "../conditions/payment-terms.js";
import { PUB_STATEMENT_KEY, STATEMENT_KEY, type StatementIssuer } from "./statement-issue.js";

/**
 * 出した計算書を訂正版で出し直す（一括）。直す理由は 3 つで、1 つでも当たれば出し直す。
 *
 *   対象期間 … 回の期間に揃える（下の経緯）
 *   担当者   … 選んだ担当者を「担当」に入れる。担当が違う計算書と、担当の行の無い古いひな形で
 *              出した計算書が対象（infra/v3/166 の r4 で担当の行が入る）
 *   支払日   … 個人宛ての計算書の支払日を 20 日にする（payment-terms.ts の forPartyKind）。
 *              出し直す前に回の支払日（月の末日・まだ来ていない）を同じ月の 20 日にし、紙の支払期日が
 *              20 日で刷られるようにする。出し直したら、元の計算書から立っている未払いの支払
 *              （planned・approved）の期日も同じく直す。支払済みの計算書は支払日を直さない。
 *              出し直しに失敗したら回の支払日は元に戻す
 *
 * 対象期間の経緯：
 *
 * まとめて締めるの計算書は、対象期間を載った実績の月の範囲で出していた。売上の無い月が
 * 端にある作品・受取人だけ期間が短くなり、同じ回で締めた計算書の間で表記がばらついた。
 * 今は回の期間で出すので、出済みの分もそれに揃えたい。
 *
 *   - 発行済みの文書は書き換えない（出したものの記録）。訂正版を出して元を退かせる
 *     （StatementIssuer.issue の supersedes。実績は訂正版に移る）。番号は改訂の番号になる。
 *   - 条件・受取人・実績は元の計算書のまま。決定日も元のまま。
 *   - 額は変えない。いま計算し直して元の額と違えば出し直さない（支払は元の額で立っている）。
 *   - 支払は作り直さない。支払は条件・実績に割り当てているので、訂正版でもそのまま。
 *
 * 必ず試算（preview）を見てから出す。試算は何も書かない。
 */

export type ReissueUsage = "pub_digital" | "pub_print";

export type ReissueStatus =
  | "change"     // 直す理由がある。出し直す
  | "same"       // 直す理由が無い
  | "no_round"   // 実績が回に付いていない（回の期間が決まらない）
  | "amount"     // いま計算し直すと額が違う。出し直さない
  | "draft"      // 訂正版の下書きがもうある
  | "error";     // 試算できない

export interface ReissueTarget {
  documentId: number;
  documentNo: string | null;
  issuedOn: string | null;
  templateKey: string;
  partyName: string | null;
  conditionCount: number;
  /** いま紙に出ている対象期間。 */
  currentLabel: string | null;
  /** 出し直したときの対象期間（回の期間）。 */
  newLabel: string | null;
  /** 直す理由（対象期間・担当者・支払日）。 */
  reasons: ReissueReason[];
  /** いま紙に出ている支払期日と、出し直したあとの支払期日（支払日を直すときだけ）。 */
  currentPayOn: string | null;
  newPayOn: string | null;
  status: ReissueStatus;
  message: string | null;
}

export type ReissueReason = "period" | "staff" | "payday";
export const REISSUE_REASON_LABEL: Record<ReissueReason, string> = { period: "対象期間", staff: "担当者", payday: "支払日" };

export interface ReissueOptions {
  usageType: ReissueUsage;
  /** 担当者を入れる（訂正版の担当）。担当が違う計算書・担当の行の無い古いひな形の計算書が対象になる。 */
  ownerStaffId?: number | null;
  /** 個人宛ての計算書の支払日を 20 日にする。 */
  individualPayDay?: boolean;
}

interface DocPlan {
  target: ReissueTarget;
  /** 支払日を直す回（いまの支払日）。 */
  payRounds: Array<{ id: number; payOn: string }>;
  /** 支払を探す鍵（実績と支払先）。 */
  eventIds: number[];
  partyId: number | null;
  matterId: number | null;
  agreementId: number | null;
  manualInputs: Record<string, unknown>;
  netMinor: number;
  entries: Array<{ conditionId: number; payeePartyId: number | null; eventIds: number[]; period: string | null }>;
}

export const DEFAULT_REISSUE_REASON = "対象期間の表記を回の期間に揃える";
const reasonText = (reasons: ReissueReason[]) => {
  const parts = reasons.map((r) => r === "period" ? "対象期間の表記を回の期間に揃える"
    : r === "staff" ? "担当者を記載する" : "支払日を 20 日に改める");
  return parts.join("・") || DEFAULT_REISSUE_REASON;
};
/** 月の末日なら同じ月の 20 日（payment-terms.ts の forPartyKind と同じ）。 */
const individualPayOn = (day: string): string =>
  isMonthEnd(day) ? `${day.slice(0, 8)}${String(INDIVIDUAL_PAY_DAY).padStart(2, "0")}` : day;
function isMonthEnd(day: string): boolean {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getUTCDate() === 1;
}

/** 訂正版に引き継がない手入力（焼き付けた行・税・期間は発行で作り直す）。 */
const carriedInputs = (manual: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries((manual ?? {}) as Record<string, unknown>)
    .filter(([k]) => !k.startsWith("rs_") && !["statementMode", "_payeePartyId", "_supersedesExtra"].includes(k)));

export class StatementPeriodReissueService {
  constructor(
    private readonly database: Queryable,
    private readonly issuer: Pick<StatementIssuer, "previewBundle" | "issue">,
    private readonly today = () => new Date().toISOString().slice(0, 10)
  ) {}

  async preview(input: ReissueOptions): Promise<{ targets: ReissueTarget[]; changing: number }> {
    try {
      const plans = await this.plans(input, null);
      const targets = plans.map((p) => p.target);
      return { targets, changing: targets.filter((t) => t.status === "change").length };
    } catch (error) { throw translate(error); }
  }

  async run(
    input: ReissueOptions & { documentIds: number[]; reason?: string | null }, actor: string
  ): Promise<{ results: Array<ReissueTarget & { newDocumentId: number | null; newDocumentNo: string | null; paymentsUpdated?: number }>; reissued: number }> {
    const ids = [...new Set(input.documentIds.map(Number))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "出し直す計算書を選んでください");
    const typed = String(input.reason ?? "").trim();
    try {
      const plans = await this.plans(input, ids);
      const results: Array<ReissueTarget & { newDocumentId: number | null; newDocumentNo: string | null; paymentsUpdated?: number }> = [];
      for (const id of ids) {
        const plan = plans.find((p) => p.target.documentId === id);
        if (!plan) {
          results.push({ documentId: id, documentNo: null, issuedOn: null, templateKey: "", partyName: null,
            conditionCount: 0, currentLabel: null, newLabel: null, reasons: [], currentPayOn: null, newPayOn: null, status: "error",
            message: "発行済みの計算書（この媒体）に見つかりません", newDocumentId: null, newDocumentNo: null });
          continue;
        }
        if (plan.target.status !== "change") {
          results.push({ ...plan.target, newDocumentId: null, newDocumentNo: null });
          continue;
        }
        const reason = typed || reasonText(plan.target.reasons);
        const payday = plan.target.reasons.includes("payday");
        // 紙の支払期日は回の支払日から刷る。出し直す前に回を 20 日にする（失敗したら戻す）。
        if (payday) await this.setPayOn(plan.payRounds.map((r) => ({ id: r.id, payOn: individualPayOn(r.payOn) })));
        // 1 枚が落ちても他は進める。
        try {
          const made = await this.issuer.issue({
            templateKey: plan.target.templateKey,
            entries: plan.entries,
            periodLabel: plan.target.newLabel,
            matterId: plan.matterId, agreementId: plan.agreementId,
            manualInputs: input.ownerStaffId ? { ...plan.manualInputs, _ownerStaffId: input.ownerStaffId } : plan.manualInputs,
            supersedes: [plan.target.documentId], reason,
            issuedOn: plan.target.issuedOn
          }, actor);
          const paymentsUpdated = payday ? await this.movePaymentsDue(plan) : 0;
          results.push({ ...plan.target, newDocumentId: made.document.id, newDocumentNo: made.document.documentNo ?? null,
                         ...(payday ? { paymentsUpdated } : {}) });
        } catch (error) {
          if (payday) await this.setPayOn(plan.payRounds).catch(() => undefined);
          results.push({ ...plan.target, status: "error", message: error instanceof Error ? error.message : String(error),
                         newDocumentId: null, newDocumentNo: null });
        }
      }
      const reissued = results.filter((r) => r.newDocumentId !== null);
      await recordAudit(this.database, {
        actor, action: "royalty.statement_period_reissue", targetType: "document", targetId: 0,
        detail: { usageType: input.usageType, reason: typed || null, ownerStaffId: input.ownerStaffId ?? null,
                  individualPayDay: Boolean(input.individualPayDay),
                  reissued: reissued.map((r) => ({ from: r.documentId, to: r.newDocumentId, reasons: r.reasons,
                                                   ...(r.paymentsUpdated !== undefined ? { paymentsUpdated: r.paymentsUpdated } : {}) })),
                  failed: results.filter((r) => r.status === "error").map((r) => ({ id: r.documentId, message: r.message })) }
      });
      return { results, reissued: reissued.length };
    } catch (error) { throw translate(error); }
  }

  private async setPayOn(rounds: Array<{ id: number; payOn: string }>): Promise<void> {
    for (const r of rounds) {
      await this.database.query("UPDATE condition_schedules SET pay_on = $2::date WHERE id = $1", [r.id, r.payOn]);
    }
  }

  /** 元の計算書から立っている未払いの支払（planned・approved）の期日を、末日なら同じ月の 20 日に。 */
  private async movePaymentsDue(plan: DocPlan): Promise<number> {
    if (!plan.eventIds.length || plan.partyId === null) return 0;
    const r = await this.database.query(
      `UPDATE payments p SET due_on = (date_trunc('month', p.due_on) + interval '19 days')::date
        WHERE p.status IN ('planned', 'approved') AND p.party_id = $2
          AND p.due_on IS NOT NULL AND (p.due_on + 1) = date_trunc('month', p.due_on + 1)::date
          AND EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id AND a.event_id = ANY($1::bigint[]))
        RETURNING p.id`, [plan.eventIds, plan.partyId]);
    return r.rows.length;
  }

  /** 発行済みの計算書（媒体で絞る）と、出し直したときの姿。onlyIds があればその文書だけ。 */
  private async plans(options: ReissueOptions, onlyIds: number[] | null): Promise<DocPlan[]> {
    const usageType = options.usageType;
    const head = await this.database.query(
      `SELECT d.id, d.document_no, d.matter_id, d.agreement_id, d.manual_inputs,
              to_char(d.issued_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS issued_on,
              d.rendered_values ->> 'pubPeriodLabel' AS printed_label,
              COALESCE(d.rendered_values ->> 'PAYMENT_DATE', d.rendered_values ->> 'paymentDueDate') AS printed_pay_on,
              NULLIF(d.manual_inputs ->> '_ownerStaffId', '') AS owner_staff_id,
              (d.template_version_id IS DISTINCT FROM t.current_version_id) AS old_template,
              t.template_key,
              EXISTS (SELECT 1 FROM documents x WHERE x.supersedes_id = d.id AND x.status = 'draft') AS has_draft,
              s.id AS statement_id, s.condition_id, s.payee_party_id, s.period, s.net_amount,
              c.usage_type, COALESCE(pp.name, cp.name) AS party_name,
              COALESCE(pp.kind, cp.kind) AS party_kind, COALESCE(s.payee_party_id, c.counterparty_id) AS pay_party_id
         FROM documents d
         JOIN document_template_versions tv ON tv.id = d.template_version_id
         JOIN document_templates t ON t.id = tv.template_id
         JOIN statements s ON s.document_id = d.id
         JOIN conditions c ON c.id = s.condition_id
         LEFT JOIN parties pp ON pp.id = s.payee_party_id
         LEFT JOIN parties cp ON cp.id = c.counterparty_id
        WHERE d.status = 'issued' AND t.template_key = ANY($1::text[])
          AND ($2::bigint[] IS NULL OR d.id = ANY($2::bigint[]))
        ORDER BY d.issued_at, d.id, s.id`,
      [[STATEMENT_KEY, PUB_STATEMENT_KEY], onlyIds]);
    const rows = head.rows as Array<Record<string, any>>;
    // 媒体の条件が載っている文書だけ。
    const docIds = [...new Set(rows.filter((r) => r.usage_type === usageType).map((r) => Number(r.id)))];
    if (!docIds.length) return [];
    const statementIds = rows.filter((r) => docIds.includes(Number(r.id))).map((r) => Number(r.statement_id));

    // 計算書に載った実績と、その回。明細の行から引く（受取人ごとの 2 枚目以降は実績が文書を指さない）。
    const ev = await this.database.query(
      `SELECT s.id AS statement_id, e.id AS event_id, sc.id AS schedule_id,
              sc.service_from, sc.service_to, sc.label, sc.pay_on
         FROM statements s
         JOIN condition_events e ON e.status = 'active'
          AND (e.id IN (SELECT l.event_id FROM statement_lines l WHERE l.statement_id = s.id)
               OR (e.document_id = s.document_id AND e.condition_id = s.condition_id))
         LEFT JOIN condition_schedules sc ON sc.id = e.schedule_id
        WHERE s.id = ANY($1::bigint[])
        ORDER BY s.id, e.id`, [statementIds]);
    type Round = { id: number | null; serviceFrom: string | null; serviceTo: string | null; label: string | null; payOn: string | null };
    const eventsOf = new Map<number, { ids: number[]; rounds: Round[] }>();
    for (const e of ev.rows as Array<Record<string, any>>) {
      const key = Number(e.statement_id);
      const hit = eventsOf.get(key) ?? { ids: [], rounds: [] };
      if (!hit.ids.includes(Number(e.event_id))) hit.ids.push(Number(e.event_id));
      const sid = e.schedule_id === null || e.schedule_id === undefined ? null : Number(e.schedule_id);
      if (!hit.rounds.some((r) => r.id === sid)) {
        hit.rounds.push({ id: sid, serviceFrom: dateStr(e.service_from), serviceTo: dateStr(e.service_to), label: str(e.label),
                          payOn: dateStr(e.pay_on) });
      }
      eventsOf.set(key, hit);
    }
    const labelOf = (rounds: Round[]) => rounds.some((r) => r.id === null) ? null : roundPeriodLabel(rounds);
    // 支払済みの実績（支払日を直さない）。
    const allEvents = [...new Set([...eventsOf.values()].flatMap((x) => x.ids))];
    const paidEvents = new Set(options.individualPayDay && allEvents.length ? ((await this.database.query(
      `SELECT DISTINCT a.event_id FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
        WHERE a.event_id = ANY($1::bigint[]) AND p.status = 'paid'`, [allEvents])).rows as Array<{ event_id: number }>)
      .map((x) => Number(x.event_id)) : []);
    const today = this.today();

    const plans: DocPlan[] = [];
    for (const documentId of docIds) {
      const mine = rows.filter((r) => Number(r.id) === documentId);
      const first = mine[0]!;
      const entries = mine.map((r) => {
        const e = eventsOf.get(Number(r.statement_id)) ?? { ids: [], rounds: [] };
        return { conditionId: Number(r.condition_id), payeePartyId: r.payee_party_id ? Number(r.payee_party_id) : null,
                 eventIds: e.ids, period: labelOf(e.rounds) };
      });
      const allRounds = mine.flatMap((r) => eventsOf.get(Number(r.statement_id))?.rounds ?? []);
      const newLabel = entries.some((e) => !e.eventIds.length || !e.period) ? null : labelOf(allRounds);
      const currentLabel = str(first.printed_label)
        ?? ([...new Set(mine.map((r) => String(r.period ?? "")))].length === 1 ? str(first.period) : null);
      const netMinor = mine.reduce((a, r) => a + Number(r.net_amount ?? 0), 0);
      const periodsMatch = mine.every((r, i) => String(r.period ?? "") === String(entries[i]!.period ?? ""));
      const eventIds = [...new Set(entries.flatMap((e) => e.eventIds))];
      // 支払日：個人宛て・回の支払日が月の末日でまだ来ていない・支払済みでない。
      const payRounds = [...new Map(allRounds.filter((r): r is Round & { id: number; payOn: string } =>
        r.id !== null && Boolean(r.payOn) && isMonthEnd(r.payOn!) && r.payOn! >= today).map((r) => [r.id, r])).values()]
        .map((r) => ({ id: r.id, payOn: r.payOn }));
      const paid = eventIds.some((id) => paidEvents.has(id));
      const reasons: ReissueReason[] = [];
      if (newLabel && !(currentLabel === newLabel && periodsMatch)) reasons.push("period");
      if (options.ownerStaffId && (Number(first.owner_staff_id ?? 0) !== Number(options.ownerStaffId) || first.old_template === true)) {
        reasons.push("staff");
      }
      const paydayWanted = Boolean(options.individualPayDay) && String(first.party_kind ?? "") === "individual" && payRounds.length > 0;
      if (paydayWanted && !paid) reasons.push("payday");
      const printedPay = str(first.printed_pay_on);
      const target: ReissueTarget = {
        documentId, documentNo: str(first.document_no), issuedOn: str(first.issued_on),
        templateKey: String(first.template_key), partyName: str(first.party_name),
        conditionCount: entries.length, currentLabel, newLabel, reasons,
        currentPayOn: printedPay && /^\d{4}-\d{2}-\d{2}$/.test(printedPay) ? printedPay : null,
        newPayOn: reasons.includes("payday") ? individualPayOn(payRounds.map((r) => r.payOn).sort().at(-1)!) : null,
        status: "change", message: paydayWanted && paid ? "支払済みなので支払日は直しません" : null
      };
      if (first.has_draft === true) {
        Object.assign(target, { status: "draft", message: "訂正版の下書きがもうあります。その下書きを決定するか捨ててください" });
      } else if (!newLabel) {
        Object.assign(target, { status: "no_round", message: "回に付いていない実績が載っています（回の期間が決まりません）" });
      } else if (!reasons.length) {
        Object.assign(target, { status: "same" });
      } else {
        // 額は変えない。いま計算し直して元と違えば出し直さない（支払は元の額で立っている）。
        try {
          const previews = await this.issuer.previewBundle(entries, [documentId]);
          const now = previews.reduce((a, p) => a + p.amounts.netMinor, 0);
          if (now !== netMinor) {
            Object.assign(target, { status: "amount",
              message: `いま計算し直すと額が変わります（${netMinor.toLocaleString("ja-JP")} → ${now.toLocaleString("ja-JP")}）。個別に訂正してください` });
          }
        } catch (error) {
          Object.assign(target, { status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
      plans.push({
        target, payRounds, eventIds, partyId: first.pay_party_id ? Number(first.pay_party_id) : null,
        matterId: first.matter_id ? Number(first.matter_id) : null,
        agreementId: first.agreement_id ? Number(first.agreement_id) : null,
        manualInputs: carriedInputs(first.manual_inputs), netMinor, entries
      });
    }
    return plans;
  }
}
