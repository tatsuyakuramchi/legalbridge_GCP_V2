/**
 * 支払文書処理の見立て。
 *
 * 条件・予定・実績・決済文書・支払は、定期払いも料率も同じ4手で進む。
 *   予定を立てる → 実績（料率は売上報告）を入れる → 決済文書を出す → 支払を立てる
 * 違うのは列の中身だけで、並べ方は同じ。だから画面も表も1つにする。
 *
 * ここは判定だけを持つ（どの段にいるか・支払期日がどこから来たか）。
 * 値を引くのは service.ts。
 */

import { payDateFromTerms } from "../conditions/payment-terms.js";
import { dueLimitFrom } from "../payments/compliance.js";
import { settlementDocFor } from "../documents/settlement-docs.js";

/** 料率は売上報告が来ないと金額が出ない。実績を「予定どおり」で埋められない。 */
export const needsReport = (pricingModel: string | null | undefined): boolean =>
  String(pricingModel ?? "") === "revenue_rate";

/** 決済文書の呼び名とひな形。条件の種類で決まる（既存の規則をそのまま使う）。 */
export const documentFor = settlementDocFor;

/** いまどの段にいるか。前の段が済んでいなければ次は出さない。 */
export type Step = "event" | "document" | "payment" | "done";

export function stepOf(row: {
  hasEvent: boolean; hasDocument: boolean; hasPayment: boolean;
}): Step {
  if (!row.hasEvent) return "event";
  if (!row.hasDocument) return "document";
  if (!row.hasPayment) return "payment";
  return "done";
}

/**
 * 画面に出す状態の名前。
 *
 * 料率の「実績待ち」は実際には「報告待ち」。こちらの手が止まっているのではなく、
 * 相手からの売上報告を待っている。同じ言葉にすると、催促する先を間違える。
 */
export function stateLabel(row: {
  step: Step; pricingModel: string | null | undefined; kind: string | null | undefined;
}): string {
  switch (row.step) {
    case "event": return needsReport(row.pricingModel) ? "報告待ち" : "実績待ち";
    case "document": return `${documentFor(row.kind).label}待ち`;
    case "payment": return "支払待ち";
    default: return "締め済";
  }
}

// ---------------------------------------------------------------------------
// 支払期日
// ---------------------------------------------------------------------------

/**
 * 期日の出どころ。画面に添えて出す。
 *
 * limit は「下請法の上限」であって約束の日ではない。どれも無いときの落ち先
 * なので、そのまま出すと「60日後に払う約束がある」と読み違える。画面は
 * これだけ色を変え、条件に支払条件を入れる合図として扱う。
 */
export type DueSource = "schedule" | "printed" | "terms" | "limit" | "none";

export const DUE_SOURCE_LABEL: Record<DueSource, string> = {
  schedule: "予定明細の支払日",
  printed: "紙に刷られた支払期日",
  terms: "条件の支払条件",
  limit: "上限60日（約束の日ではない）",
  none: "決められない"
};

export interface DueInput {
  /** 予定明細の支払日。回ごとに決めてある日。いちばん確か。 */
  schedulePayOn?: string | null;
  /** 決済文書の本文に刷られた支払期日。 */
  printedDueOn?: string | null;
  /** 条件の支払条件（「月末締め翌月末払い」など）。 */
  paymentTerms?: string | null;
  /** 起算日。締め日（無ければ納品日）。支払条件と上限はここから数える。 */
  basisOn?: string | null;
}

export interface Due { on: string | null; source: DueSource; label: string }

/**
 * 支払期日と、それがどこから来たか。
 *
 * 順番は支払を立てる側（payments の createFromInspection）と同じにしてある。
 * 画面と実際に立つ支払で期日が違うと、見て決めた意味がなくなる。
 */
export function dueOf(input: DueInput): Due {
  const made = (on: string | null, source: DueSource): Due =>
    ({ on, source, label: DUE_SOURCE_LABEL[source] });

  const sched = trim(input.schedulePayOn);
  if (sched) return made(sched, "schedule");
  const printed = trim(input.printedDueOn);
  if (printed) return made(printed, "printed");

  const basis = trim(input.basisOn);
  if (basis) {
    const byTerms = payDateFromTerms(basis, input.paymentTerms ?? null);
    if (byTerms) return made(byTerms, "terms");
    const limit = dueLimitFrom(basis);
    if (limit) return made(limit, "limit");
  }
  return made(null, "none");
}

const trim = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

// ---------------------------------------------------------------------------
// 月の区切り
// ---------------------------------------------------------------------------

/**
 * どの月のものとして数えるか。**締め日**で切る。
 *
 * 納品日でも発行日でもない。定期払いは月末締め、料率は算定期間の締め日。
 * どちらも「この日までの分」を決める日なので、そこで切るのが実務に合う。
 */
export const monthKeyOf = (closingOn: string | null | undefined): string | null => {
  const s = trim(closingOn);
  return s && /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
};

/** その月の始まりと、次の月の始まり。SQL の範囲に渡す。 */
export function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new RangeError(`月は YYYY-MM で指定してください：${month}`);
  }
  const year = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  const next = m === 12 ? { y: year + 1, m: 1 } : { y: year, m: m + 1 };
  return { from: `${year}-${pad(m)}-01`, to: `${next.y}-${pad(next.m)}-01` };
}

/** 締め日から何日過ぎているか。過ぎていなければ 0。 */
export function lateDays(closingOn: string | null | undefined, today: string): number {
  const s = trim(closingOn);
  if (!s) return 0;
  const a = Date.parse(`${s}T00:00:00Z`), b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.floor((b - a) / 86400000);
}
