/**
 * 修正の残骸の片づけ。
 *
 * 直す作業は必ず途中の産物を残す。訂正版を作りかけて別の直し方にした下書き、
 * 打ち間違えて無効にした実績、作り直したので無効にした条件。どれも画面の
 * 一覧からは消えるが行としては残り続け、数えると合わない・選ぶときに紛れる。
 *
 * ただし「無効にしたもの」が全部ごみとは限らない。**出したものの記録は
 * 残す**のが V3 の立て付けで、そこを崩すと「何を相手に出したか」が追えなく
 * なる。捨ててよいのは、外に出ていないもの・誰も指していないものだけ。
 *
 * 捨てる
 *   ・一度も発行していない文書（下書き、番号の無いまま無効にしたもの）
 *   ・無効にした実績で、支払の割当も文書も付いていないもの
 *   ・無効にした条件で、何も指していないもの（既存の2段階削除と同じ判定）
 *
 * 残す
 *   ・発行した文書。無効にしてあっても、番号を振って出した事実は記録
 *   ・取り消した支払。経理へ出したかどうかの記録がぶら下がる
 *   ・旧版の条件。実績と割当が旧版の id に付いたまま残るので履歴そのもの
 *
 * ここは「何がいくつ、なぜ捨てられる／捨てられない」を組み立てるだけを持つ。
 * 消す手順はそれぞれの持ち主（文書・実績・条件のサービス）に任せる。
 */

export type LeftoverKind = "draft" | "event" | "condition";

export const LEFTOVER_LABEL: Record<LeftoverKind, string> = {
  draft: "出していない文書", event: "無効にした実績", condition: "無効にした条件"
};

/** その残骸を指しているもの。1つでもあれば捨てない。 */
export interface Holder { target: string; rows: number }

export interface Leftover {
  kind: LeftoverKind;
  id: number;
  /** 画面に出す名前（文書番号・条件番号・日付など）。 */
  label: string;
  /** どういう経緯で残ったか（「訂正版の作りかけ」など）。 */
  origin: string;
  /** いつのものか。古いものから片づけたい。 */
  createdAt: string | null;
  /** 関わりの分かる手がかり（条件名・取引先・案件）。 */
  context: string | null;
  /** 捨てられるか。 */
  disposable: boolean;
  /**
   * 捨てられるが、捨てる前に見てほしいこと。
   *
   * 訂正版の下書きは「金額の直し」が作った直しかけで、捨てると元の文書が
   * 直っていないまま残る。引き止めはしないが、黙って並べると片づけのつもりで
   * 直しを取り消すことになる。
   */
  caution: string | null;
  /** 捨てられないとき、何が指しているか。 */
  holders: Holder[];
}

/**
 * 捨てられるかを決める。
 *
 * holders が空なら捨てられる。ここを「空なら消す」だけにしてあるのは、
 * 何が引き止めているかを画面にそのまま出すため（消せない理由が分からないと、
 * 人は同じものを何度も選び直す）。
 */
export const disposable = (holders: Holder[]): boolean => holders.length === 0;

/** 0 件のものは落とす。画面に「0 件」の行が並ぶと、本当の引き止めが埋もれる。 */
export const heldBy = (counts: Array<[string, number]>): Holder[] =>
  counts.filter(([, rows]) => rows > 0).map(([target, rows]) => ({ target, rows }));

export interface LeftoverTally {
  kind: LeftoverKind;
  label: string;
  total: number;
  /** そのうち捨てられるもの。 */
  disposable: number;
}

/** 種別ごとの件数。画面の見出しと、押す前の見当に使う。 */
export function tally(items: Leftover[]): LeftoverTally[] {
  return (["draft", "event", "condition"] as const).map((kind) => {
    const mine = items.filter((i) => i.kind === kind);
    return {
      kind, label: LEFTOVER_LABEL[kind], total: mine.length,
      disposable: mine.filter((i) => i.disposable).length
    };
  }).filter((t) => t.total > 0);
}

/**
 * 捨てる順番。実績 → 条件 の順でないと、条件が実績に引き止められる。
 *
 * 文書はどちらとも関わらないので先でも後でもよいが、画面の並びと合わせて
 * 先に置く。選んだものを1回で片づけるとき、この順で流す。
 */
export const DISPOSE_ORDER: LeftoverKind[] = ["draft", "event", "condition"];

export interface DisposeResult {
  kind: LeftoverKind;
  id: number;
  label: string;
  /** 捨てられたか。断られたときは理由を返す。 */
  removed: boolean;
  message: string | null;
}
