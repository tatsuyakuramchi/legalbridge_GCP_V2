import type { ConditionSettlement } from "../conditions/settlement.js";

/**
 * 工程表の1行（条件1本）。
 *
 * 条件・予定・発注書・実績・検収書・支払は別々の画面に散っている。1本ずつは
 * 追えても、取引先が20社を超える案件では「どの社のどれが止まっているか」を
 * 目で拾うしかなかった。1本を1行に畳んで、段ごとの状態を横に並べる。
 *
 * ここは読む側の組み立てだけを持つ（段の判定と絞り込み）。行に出す値は
 * grid-service.ts が引く。
 */

/** 工程の段。並び順がそのまま画面の列の順になる。 */
export type Stage = "condition" | "schedule" | "order" | "event" | "settlementDoc" | "payment";

export interface GridDocument {
  id: number;
  documentNo: string | null;
  /** 画面に出す段階（下書き／決定済み／送信済み／訂正版あり）。 */
  phase: string;
}

export interface GridRow {
  conditionId: number;
  conditionNo: string | null;
  name: string;
  kind: string;
  counterparty: { id: number; name: string } | null;
  /**
   * 金額の材料。見出しの作り方（定額／単価／料率）は画面の
   * conditionAmountLabel と同じものを使うので、ここでは素の値を渡す。
   */
  pricingModel: string;
  currency: string;
  flatAmount: number | null;
  unitAmount: number | null;
  ratePpm: number | null;
  /** 条件の版（有効・適用待ちなど）。決着とは別の軸。 */
  status: string;
  settlement: ConditionSettlement;
  schedules: { total: number; done: number };
  order: GridDocument | null;
  events: { count: number; latestOn: string | null };
  settlementDoc: GridDocument | null;
  payment: { id: number; paymentNo: string | null; status: string } | null;
}

/**
 * まだ手が付いていない段。段で絞るときの判定に使う。
 *
 * 「まだ」の意味は段で違う。発注書は下書きでも「ある」（作り直すのは訂正版の
 * 話で、この画面の仕事ではない）。支払は取り消したものを持っていても「無い」。
 */
export function isPending(row: GridRow, stage: Stage): boolean {
  switch (stage) {
    case "condition": return false;
    case "schedule": return row.schedules.total === 0 || row.schedules.done < row.schedules.total;
    case "order": return row.order === null;
    case "event": return row.events.count === 0;
    case "settlementDoc": return row.settlementDoc === null;
    case "payment": return row.payment === null;
  }
}

export type GridFilter = "all" | "order" | "event" | "settlementDoc" | "payment" | "settled";

export const GRID_FILTER_LABEL: Record<GridFilter, string> = {
  all: "すべて",
  order: "発注書がまだ",
  event: "実績がまだ",
  settlementDoc: "検収書がまだ",
  payment: "支払がまだ",
  settled: "払い切り"
};

/** 段で絞る。払い切り（完了扱いを含む）だけは「済んだもの」を集める。 */
export function applyFilter(rows: GridRow[], filter: GridFilter): GridRow[] {
  if (filter === "all") return rows;
  if (filter === "settled") return rows.filter((r) => r.settlement.done);
  // 払い切った条件は、どの段が空でも「まだ」には数えない（もう作らない）。
  return rows.filter((r) => !r.settlement.done && isPending(r, filter));
}

/** 絞り込みの札に出す件数。押す前にどこに何件あるかを見せる。 */
export function filterCounts(rows: GridRow[]): Record<GridFilter, number> {
  return {
    all: rows.length,
    order: applyFilter(rows, "order").length,
    event: applyFilter(rows, "event").length,
    settlementDoc: applyFilter(rows, "settlementDoc").length,
    payment: applyFilter(rows, "payment").length,
    settled: applyFilter(rows, "settled").length
  };
}

export interface PartyGroup {
  id: number | null;
  name: string;
  rows: GridRow[];
  /** 社ごとの小計。見出しだけで「この社はどこまで」が読めるように。 */
  tally: { conditions: number; orders: number; settlementDocs: number; payments: number };
}

/**
 * 取引先でまとめる。並びは元のまま（先に来た社が先）なので、
 * 並び替えを変えても塊の順が予想できる。
 */
export function groupByParty(rows: GridRow[]): PartyGroup[] {
  const groups = new Map<string, PartyGroup>();
  for (const row of rows) {
    const id = row.counterparty?.id ?? null;
    const key = String(id ?? "none");
    const got = groups.get(key) ?? {
      id, name: row.counterparty?.name ?? "（相手先なし）", rows: [],
      tally: { conditions: 0, orders: 0, settlementDocs: 0, payments: 0 }
    };
    got.rows.push(row);
    got.tally.conditions += 1;
    if (row.order) got.tally.orders += 1;
    if (row.settlementDoc) got.tally.settlementDocs += 1;
    if (row.payment) got.tally.payments += 1;
    groups.set(key, got);
  }
  return [...groups.values()];
}
