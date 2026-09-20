import { targetAmountOf } from "../conditions/settlement.js";
import type { GridRow } from "./grid.js";

/**
 * 条件・文書・実績・支払の金額の食い違い。
 *
 * 発注書と検収書を出したあとで条件の金額を直すと、直るのは条件だけになる。
 * 文書は決定した時点の値を焼き付けて持つ（出した紙の記録なので書き換えない）
 * ので、条件が ¥95,000 になっても発注書は ¥120,000 のまま残る。どちらが本当か
 * は画面のどこにも出ず、支払を立てる段になって初めて気づく。
 *
 * ここは見つけるだけを持つ。直すのは bundle-service（条件・実績・支払を直し、
 * 決定済みの文書は訂正版の下書きを作る）。
 *
 * 大事なのは**段ごとに比べる相手が違う**こと。
 *
 *   発注書 … 条件の金額（発注書は条件を紙にしたもの。実績はまだ無い）
 *   実績　 … 比べない（減額納品はふつうにある。検収書はその差を変更履歴に
 *            出して署名欄まで付ける作りなので、食い違いではない）
 *   検収書 … 実績の合計（検収書は実績を紙にしたもの）
 *   支払　 … 実績の合計（支払は実績から起こす）
 *
 * ここを全部「条件の金額」と比べると、減額納品の案件が軒並み食い違いになる。
 * 実際のデータで 36 本中 3 本が鳴って、3 本とも減額納品だった。
 *
 * 見るのは税抜。文書は AMOUNT_EX_TAX（どのひな形も持つ）、実績は amount の
 * 合計、支払は割当の合計で、条件の定額と同じ土俵に乗る。税込で比べると
 * 区分ごとの端数処理の違いが毎回ずれとして出る。
 */

export type DriftPart = "order" | "settlementDoc" | "event" | "payment";

export const DRIFT_LABEL: Record<DriftPart, string> = {
  order: "発注書", settlementDoc: "検収書", event: "実績", payment: "支払"
};

export interface DriftEntry {
  part: DriftPart;
  /** 文書番号・支払番号。番号なしは null。 */
  ref: string | null;
  amount: number;
  /** 比べた相手の額と名前。段ごとに相手が違うので、画面にも出す。 */
  basis: number;
  basisLabel: string;
  /** 相手との差。＋は相手より多い。 */
  diff: number;
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

export interface Drift {
  /** 今の条件の金額（税抜）。 */
  conditionAmount: number;
  /** 実績の合計。検収書と支払はこちらと比べる。実績が無ければ null。 */
  deliveredAmount: number | null;
  /** 比べたもの全部。画面の一覧はこれを並べる。 */
  entries: DriftEntry[];
  /** そのうち鳴らすもの。 */
  flagged: DriftEntry[];
}

/**
 * 1行の食い違い。比べられないときは null。
 *
 * 比べられないのは、定額でない条件（料率・単価×数量で総額が決まらないもの）。
 * 「いくらであるべきか」が無いので、食い違いも定義できない。
 */
export function driftOf(row: GridRow): Drift | null {
  const conditionAmount = targetAmountOf(row);
  if (conditionAmount === null) return null;

  const delivered = row.events.count > 0 ? row.settlement.deliveredAmount : null;
  // 分納（予定が2回以上）は、途中の実績も途中の支払も正しい額。
  const split = row.schedules.total > 1;
  const entries: DriftEntry[] = [];
  const add = (
    part: DriftPart, ref: string | null, amount: number,
    basis: number, basisLabel: string, note: string | null
  ) => {
    const diff = amount - basis;
    entries.push({ part, ref, amount, basis, basisLabel, diff, flagged: diff !== 0 && note === null, note });
  };

  // 発注書は条件を紙にしたもの。条件を直すと取り残されるのがここ。
  if (row.order && row.order.phase !== "draft" && row.order.amountExTax !== null) {
    add("order", row.order.documentNo, row.order.amountExTax, conditionAmount, "条件",
      // 条件を何本も載せた1枚は、総額がどの条件のぶんか分けられない。
      row.order.conditionCount > 1
        ? `条件 ${row.order.conditionCount} 本をまとめた発注書なので、1本ぶんとは比べられません`
        : null);
  }

  // 実績は条件と違ってよい（減額納品）。並べるが鳴らさない。
  if (delivered !== null) {
    const diff = delivered - conditionAmount;
    add("event", null, delivered, conditionAmount, "条件",
      diff === 0 ? null
        : split ? "分納なので、途中まででこの額です"
          : "納品額は条件と違うことがあります（減額納品など）。検収書が変更履歴に出します");
  }

  // 検収書は実績を紙にしたもの。実績を直すと取り残されるのがここ。
  const settleBasis = delivered ?? conditionAmount;
  const settleLabel = delivered !== null ? "実績" : "条件";
  if (row.settlementDoc && row.settlementDoc.phase !== "draft"
      && row.settlementDoc.amountExTax !== null) {
    add("settlementDoc", row.settlementDoc.documentNo, row.settlementDoc.amountExTax,
      settleBasis, settleLabel,
      row.settlementDoc.conditionCount > 1
        ? `条件 ${row.settlementDoc.conditionCount} 本をまとめた検収書なので、1本ぶんとは比べられません`
        : split ? "分納なので、回ごとの検収書は合計と合いません" : null);
  }

  // 支払は実績から起こす。割当の合計で見る。
  const allocated = row.settlement.plannedAmount + row.settlement.paidAmount;
  if (row.payment && allocated > 0) {
    add("payment", row.payment.paymentNo, allocated, settleBasis, settleLabel,
      split ? "分納なので、途中の支払はこの額で合っています" : null);
  }

  return { conditionAmount, deliveredAmount: delivered, entries, flagged: entries.filter((e) => e.flagged) };
}

/** 鳴らす食い違いがあるか。一覧の札と絞り込みに使う。 */
export const hasDrift = (row: GridRow): boolean => (driftOf(row)?.flagged.length ?? 0) > 0;
