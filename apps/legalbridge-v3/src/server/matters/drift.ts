import { targetAmountOf } from "../conditions/settlement.js";
import type { GridRow } from "./grid.js";

/**
 * 条件・文書・実績・支払の食い違い（金額と日付）。
 *
 * 発注書と検収書を出したあとで条件の金額や納品日を直すと、直るのは条件の側
 * だけになる。文書は決定した時点の値を焼き付けて持つ（出した紙の記録なので
 * 書き換えない）ので、条件が ¥95,000 になっても発注書は ¥120,000 のまま、
 * 納品日を延ばしても発注書は元の日のまま残る。どちらが本当かは画面のどこにも
 * 出ず、支払を立てる段になって初めて気づく。
 *
 * ここは見つけるだけを持つ。直すのは bundle-service（条件・予定・実績・支払を
 * 直し、決定済みの文書は訂正版の下書きを作って中身を引き直す）。
 *
 * 大事なのは**段ごとに比べる相手が違う**こと。
 *
 *   発注書 金額 … 条件の金額（発注書は条件を紙にしたもの。実績はまだ無い）
 *   発注書 納品日・支払期日 … 予定明細の期日・支払日（本文はここから出る）
 *   実績   金額 … 比べない（減額納品はふつうにある。検収書はその差を変更履歴に
 *                  出して署名欄まで付ける作りなので、食い違いではない）
 *   検収書 金額 … 実績の合計（検収書は実績を紙にしたもの）
 *   検収書 納品日・検収日 … 実績の納品日・検収日
 *   支払   金額 … 実績の合計（支払は実績から起こす）
 *   支払   期日 … 検収書の支払期日。無ければ予定明細の支払日
 *
 * 金額を全部「条件の金額」と比べると、減額納品の案件が軒並み食い違いになる。
 * 実際のデータで 36 本中 3 本が鳴って、3 本とも減額納品だった。
 *
 * 金額は税抜で見る。文書は AMOUNT_EX_TAX（どのひな形も持つ）、実績は amount の
 * 合計、支払は割当の合計で、条件の定額と同じ土俵に乗る。税込で比べると
 * 区分ごとの端数処理の違いが毎回ずれとして出る。
 */

export type DriftPart = "order" | "settlementDoc" | "event" | "payment";

export const DRIFT_LABEL: Record<DriftPart, string> = {
  order: "発注書", settlementDoc: "検収書", event: "実績", payment: "支払"
};

/** 見る欄。金額と日付で直し方が違うので、行に持たせる。 */
export type DriftField = "amount" | "delivery" | "inspection" | "payment";

export const FIELD_LABEL: Record<DriftField, string> = {
  amount: "金額", delivery: "納品日", inspection: "検収日", payment: "支払期日"
};

/** 日付として読めるか。発注書のまとめ書き（「A 〜 B (明細参照)」）は読めない。 */
const isDate = (v: string | null): v is string => Boolean(v) && /^\d{4}-\d{2}-\d{2}$/.test(v!);

export interface DriftEntry {
  part: DriftPart;
  field: DriftField;
  /** 文書番号・支払番号。番号なしは null。 */
  ref: string | null;
  /** 焼き付いた値。金額は数、日付は YYYY-MM-DD。 */
  value: number | string;
  /** 比べた相手の値と名前。段ごとに相手が違うので、画面にも出す。 */
  basis: number | string;
  basisLabel: string;
  /** 金額の差。日付は null（何日ずれたかより、どちらが正かが要る）。 */
  diff: number | null;
  /**
   * 食い違いとして鳴らすか。
   *
   * 分納の途中や、減額納品のように「違っていて正しい」ものは鳴らさない。
   * 鳴らさないものも行としては出す（全体を見ないと、どれが本当かは決め
   * られない）。
   */
  flagged: boolean;
  /** 鳴らさない理由。画面にそのまま出す。 */
  note: string | null;
}

/** 画面の上に出す基準。どの段が何と比べられているかを先に見せる。 */
export interface DriftBasis {
  key: string;
  label: string;
  value: number | string;
  /** 「発注書はこれと比べます」。 */
  hint: string;
}

export interface Drift {
  bases: DriftBasis[];
  /** 比べたもの全部。画面の一覧はこれを並べる。 */
  entries: DriftEntry[];
  /** そのうち鳴らすもの。 */
  flagged: DriftEntry[];
  /**
   * そろえるときの目標。画面の「全部そろえる」がこれを欄に入れる。
   * null は「目標が決まらない（比べられない）」。
   */
  targets: {
    amount: number | null;
    /** 実績の納品日・検収日。検収書がこれと比べる。 */
    deliveredOn: string | null;
    inspectedOn: string | null;
    /** 予定明細の期日・支払日。発注書がこれと比べる。 */
    scheduleDueOn: string | null;
    schedulePayOn: string | null;
    /** 支払の期日。 */
    paymentDueOn: string | null;
  };
}

/**
 * 1行の食い違い。比べられないときは null。
 *
 * 比べられないのは、定額でない条件（料率・単価×数量で総額が決まらないもの）。
 * 「いくらであるべきか」が無いので、食い違いも定義できない。日付だけは定額で
 * なくても比べられるが、総額の決まらない条件は分納・継続が前提で、日付も
 * 回ごとに動く。無理に鳴らすと出どころの分からない指摘になるので見送る。
 */
export function driftOf(row: GridRow): Drift | null {
  const conditionAmount = targetAmountOf(row);
  if (conditionAmount === null) return null;

  const delivered = row.events.count > 0 ? row.settlement.deliveredAmount : null;
  // 分納（予定が2回以上）は、途中の実績も途中の支払も正しい額。
  const split = row.schedules.total > 1;
  const entries: DriftEntry[] = [];

  const add = (
    part: DriftPart, field: DriftField, ref: string | null,
    value: number | string, basis: number | string, basisLabel: string, note: string | null
  ) => {
    const diff = typeof value === "number" && typeof basis === "number" ? value - basis : null;
    const same = value === basis;
    entries.push({ part, field, ref, value, basis, basisLabel, diff, flagged: !same && note === null, note });
  };

  // ---- 発注書。条件と予定明細を紙にしたもの。条件の側を直すと取り残される。
  const order = row.order;
  const orderLive = Boolean(order && order.phase !== "draft");
  const manyConditions = (n: number, what: string) =>
    n > 1 ? `条件 ${n} 本をまとめた${what}なので、1本ぶんとは比べられません` : null;
  /**
   * 金額を比べられない理由。
   *
   * 1枚に条件が何本も載っているときと、同じ条件に文書が何枚もあるとき
   * （追加発注・分割発注）。どちらも1枚の総額は条件の総額と合わなくて当たり前。
   * 日付は足し算ではないので、こちらの制限はかからない。
   */
  const amountNote = (d: { conditionCount: number; siblingCount: number }, what: string) =>
    manyConditions(d.conditionCount, what)
      ?? (d.siblingCount > 1
        ? `この条件には${what}が ${d.siblingCount} 枚あります。1枚ぶんの総額とは比べられません` : null);

  if (orderLive && order!.amountExTax !== null) {
    add("order", "amount", order!.documentNo, order!.amountExTax, conditionAmount, "条件",
      amountNote(order!, "発注書"));
  }
  if (orderLive) {
    for (const [field, frozen, live, varies] of [
      ["delivery", order!.deliveryOn, row.schedules.dueOn, row.schedules.dueVaries],
      ["payment", order!.paymentOn, row.schedules.payOn, row.schedules.payVaries]
    ] as const) {
      if (!isDate(live)) continue;
      // 回ごとに日付が違う発注書は「A 〜 B (明細参照)」とまとめ書きになる。
      if (!isDate(frozen)) {
        if (frozen) {
          add("order", field, order!.documentNo, frozen, live, "予定",
            "回ごとに日付が違うので、まとめてはこの1日と比べられません");
        }
        continue;
      }
      add("order", field, order!.documentNo, frozen, live, "予定",
        varies ? "予定の回ごとに日付が違います" : manyConditions(order!.conditionCount, "発注書"));
    }
  }

  // ---- 実績。金額は条件と違ってよい（減額納品）。並べるが鳴らさない。
  if (delivered !== null) {
    add("event", "amount", null, delivered, conditionAmount, "条件",
      delivered === conditionAmount ? null
        : split ? "分納なので、途中まででこの額です"
          : "納品額は条件と違うことがあります（減額納品など）。検収書が変更履歴に出します");
  }

  // ---- 検収書。実績を紙にしたもの。実績を直すと取り残される。
  const settleBasis = delivered ?? conditionAmount;
  const settleLabel = delivered !== null ? "実績" : "条件";
  const doc = row.settlementDoc;
  const docLive = Boolean(doc && doc.phase !== "draft");
  if (docLive && doc!.amountExTax !== null) {
    add("settlementDoc", "amount", doc!.documentNo, doc!.amountExTax, settleBasis, settleLabel,
      amountNote(doc!, "検収書")
        ?? (split ? "分納なので、回ごとの検収書は合計と合いません" : null));
  }
  if (docLive) {
    for (const [field, frozen, live] of [
      ["delivery", doc!.deliveryOn, row.events.latestOn],
      ["inspection", doc!.inspectionOn, row.events.latestInspectedOn]
    ] as const) {
      if (!isDate(live) || !isDate(frozen)) continue;
      add("settlementDoc", field, doc!.documentNo, frozen, live, "実績",
        manyConditions(doc!.conditionCount, "検収書")
          ?? (row.events.count > 1 ? `実績 ${row.events.count} 件のうち最も遅い日と比べています` : null));
    }
  }

  // ---- 支払。実績から起こす。期日は検収書に書いた支払期日から来る。
  const allocated = row.settlement.plannedAmount + row.settlement.paidAmount;
  if (row.payment && allocated > 0) {
    add("payment", "amount", row.payment.paymentNo, allocated, settleBasis, settleLabel,
      split ? "分納なので、途中の支払はこの額で合っています" : null);
  }
  const payBasis = isDate(doc?.paymentOn ?? null) ? doc!.paymentOn! : row.schedules.payOn;
  const payLabel = isDate(doc?.paymentOn ?? null) ? "検収書" : "予定";
  if (row.payment && isDate(row.payment.dueOn) && isDate(payBasis)) {
    add("payment", "payment", row.payment.paymentNo, row.payment.dueOn, payBasis, payLabel,
      split ? "分納なので、回ごとの支払は予定の1日と合いません" : null);
  }

  const bases: DriftBasis[] = [
    { key: "condition", label: "いまの条件", value: conditionAmount, hint: "発注書の金額はこれと比べます" }
  ];
  if (delivered !== null) {
    bases.push({ key: "delivered", label: "実績の合計", value: delivered,
      hint: "検収書と支払の金額はこれと比べます" });
  }
  if (isDate(row.schedules.dueOn)) {
    bases.push({ key: "scheduleDue", label: "予定の期日", value: row.schedules.dueOn,
      hint: "発注書の納品日はこれと比べます" });
  }
  if (isDate(row.schedules.payOn)) {
    bases.push({ key: "schedulePay", label: "予定の支払日", value: row.schedules.payOn,
      hint: "発注書の支払期日はこれと比べます" });
  }
  if (isDate(row.events.latestOn)) {
    bases.push({ key: "delivered_on", label: "実績の納品日", value: row.events.latestOn,
      hint: "検収書の納品日はこれと比べます" });
  }
  if (isDate(row.events.latestInspectedOn) && row.events.latestInspectedOn !== row.events.latestOn) {
    bases.push({ key: "inspected_on", label: "実績の検収日", value: row.events.latestInspectedOn,
      hint: "検収書の検収日はこれと比べます" });
  }

  return {
    bases, entries, flagged: entries.filter((e) => e.flagged),
    targets: {
      amount: conditionAmount,
      deliveredOn: isDate(row.events.latestOn) ? row.events.latestOn : null,
      inspectedOn: isDate(row.events.latestInspectedOn) ? row.events.latestInspectedOn : null,
      scheduleDueOn: isDate(row.schedules.dueOn) ? row.schedules.dueOn : null,
      schedulePayOn: isDate(row.schedules.payOn) ? row.schedules.payOn : null,
      paymentDueOn: isDate(payBasis) ? payBasis : null
    }
  };
}

/** 鳴らす食い違いがあるか。一覧の札と絞り込みに使う。 */
export const hasDrift = (row: GridRow): boolean => (driftOf(row)?.flagged.length ?? 0) > 0;

/**
 * 何が食い違っているか（「金額」「日付」「金額と日付」）。
 * 語尾は呼ぶ側が付ける（札は「〜が食い違い」、見出しは「〜が食い違っています」）。
 */
export function driftSummary(flagged: DriftEntry[]): string {
  const money = flagged.some((e) => e.field === "amount");
  const dates = flagged.some((e) => e.field !== "amount");
  return money && dates ? "金額と日付" : dates ? "日付" : "金額";
}

/** 日付の食い違いがあるか。どちらが正かは機械には決められないので、画面が断る。 */
export const hasDateDrift = (flagged: DriftEntry[]): boolean =>
  flagged.some((e) => e.field !== "amount");
