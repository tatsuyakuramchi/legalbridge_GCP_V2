import type { ConditionSettlement } from "../conditions/settlement.js";
import { hasDrift } from "./drift.js";
import type { SignState } from "../documents/sign-state.js";

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
  /** CloudSign の状態（未送信／送信済／締結済／取下げ）。手で直せる。 */
  sign: SignState;
  /**
   * 決定したときに焼き付いた税抜額。下書きは持たない（決定時に条件から引く）。
   * 条件の金額とのずれを見るのはこの値（drift.ts）。
   */
  amountExTax: number | null;
  /** その文書に載っている条件の本数。2本以上は1本ぶんと比べられない。 */
  conditionCount: number;
  /**
   * 同じ条件の系列に、その段の文書が何枚あるか。
   *
   * 追加発注のように何枚にも分かれていると、1枚の総額が条件の総額と合わなくて
   * 当たり前になる。金額はそのとき比べない（日付は足し算でないので比べる）。
   */
  siblingCount: number;
  /**
   * 焼き付いた日付。発注書は納品予定日と支払期日、検収書は実納品日と検収日。
   *
   * 回ごとに日付が違う発注書は「2026-10-31 〜 2026-11-30 (明細参照)」のような
   * まとめ書きが入る。素のまま持って、日付として読めるかは drift.ts が判じる
   * （ここで落とすと「まとめ書きだから比べない」と言えなくなる）。
   */
  deliveryOn: string | null;
  inspectionOn: string | null;
  paymentOn: string | null;
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
  /**
   * 予定の回と、日付。
   *
   * 発注書の納品予定日・支払期日はここから出る（orderLinesFrom）。回ごとに
   * 違えば発注書はまとめ書きになるので、そのときは比べない。
   */
  schedules: {
    total: number; done: number;
    dueOn: string | null; payOn: string | null;
    dueVaries: boolean; payVaries: boolean;
  };
  order: GridDocument | null;
  /**
   * latestId は「まとめて直す」の下敷き。直すのは直近の1件だけ。
   * latestOn は納品日、latestInspectedOn は検収日（無ければ納品日）。
   * 検収書の実納品日・検収日はこの2つから出る。
   */
  events: {
    count: number; latestOn: string | null; latestId: number | null;
    latestInspectedOn: string | null;
  };
  settlementDoc: GridDocument | null;
  payment: {
    id: number; paymentNo: string | null; status: string;
    /** まとめて直す欄の初期値。 */
    dueOn: string | null; note: string | null;
    /** 束の見出しの合計に使う。 */
    amount: number | null; paidOn: string | null;
  } | null;
}

/** 束の見出しに出す取引先。契約の有無をここで引く（契約なしは赤で出す）。 */
export interface GridParty {
  id: number;
  name: string;
  partyCode: string | null;
  /** 締結済みで解除されていない基本契約か単体契約。無ければ null。domain は service／license／空（移行分）。 */
  agreement: { id: number; agreementNo: string | null; kind: string; domain: string | null } | null;
  /**
   * 契約の状態。
   *   agreement … 登録された契約がある
   *   spot      … 契約は無いが、発注書を「基本契約なし（約款）」で出している。正常
   *   claimed   … 発注書は基本契約ありと言っているのに、契約が登録されていない。要登録
   *   none      … 契約も発注書も無い。要登録（または発注書を出す）
   */
  contract: "agreement" | "spot" | "claimed" | "none";
  /** 決定済みの発注書の枚数。 */
  orders: number;
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

export type GridFilter =
  | "all" | "order" | "event" | "settlementDoc" | "payment" | "settled" | "drift";

export const GRID_FILTER_LABEL: Record<GridFilter, string> = {
  all: "すべて",
  order: "発注書がまだ",
  event: "実績がまだ",
  settlementDoc: "検収書がまだ",
  payment: "支払がまだ",
  settled: "払い切り",
  drift: "金額・日付が食い違い"
};

/** 段で絞る。払い切り（完了扱いを含む）だけは「済んだもの」を集める。 */
export function applyFilter(rows: GridRow[], filter: GridFilter): GridRow[] {
  if (filter === "all") return rows;
  if (filter === "settled") return rows.filter((r) => r.settlement.done);
  // 食い違いは段の進み具合と別の軸。払い切った条件でも、焼き付いた額と
  // 今の条件が違えば出す（むしろ払ったあとに気づくほうが困る）。
  if (filter === "drift") return rows.filter(hasDrift);
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
    settled: applyFilter(rows, "settled").length,
    drift: applyFilter(rows, "drift").length
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
