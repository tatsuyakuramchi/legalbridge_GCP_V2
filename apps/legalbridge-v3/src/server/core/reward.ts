/**
 * 業績連動の報酬の呼び方。
 *
 * 紙（検収書・発注書の本文）と画面（実績を入れるところ）で同じ判定が要る。
 * 別々に書くと、画面は「利用許諾料」と言っているのに紙は固定額として出る、
 * という食い違いが起きる。1つだけ置いて両方から呼ぶ。
 *
 * 画面から読むので、ここはデータだけにする（DB にもテンプレートにも触らない）。
 */

/** 成果物の帰属先。条件は orderer/contractor で持ち、書類は日本語で印字する。 */
export const OWNERSHIP_LABEL: Record<string, string> = { orderer: "発注者", contractor: "受注者" };

export const ownershipLabelOf = (ownership: unknown): string | null =>
  OWNERSHIP_LABEL[String(ownership ?? "")] ?? null;

/**
 * 明細の支払方法。発注書・検収書の本文がこれで出し分ける。
 *
 * 条件の計算方式をそのまま大文字にしていたので、料率の条件は "REVENUE_RATE" に
 * なっていた。欄の選択肢は FIXED / ROYALTY / SUBSCRIPTION の3つなので、どれにも
 * 当たらず、業績連動の枝（確定報酬の名称・料率・計算式）が一度も開かなかった。
 *
 * 単価×数量は金額が先に決まるので固定額の側。業績連動は売上に料率を掛けるほう。
 */
export function calcMethodFor(pricingModel: unknown): string {
  switch (String(pricingModel ?? "")) {
    case "revenue_rate":  return "ROYALTY";
    case "subscription":  return "SUBSCRIPTION";
    case "fixed":
    case "unit_rate":     return "FIXED";
    default:              return "";      // 未選択は固定額として出る
  }
}

/**
 * 業績連動のときの報酬の名前。成果物の帰属先で変わる。
 *
 *   受注者（利用許諾型）… 成果物は相手のもの。当社は使う対価を払う → 利用許諾料
 *   発注者（譲渡型）  … 成果物は当社のもの。売れたぶんを還元する → インセンティブ報酬
 *
 * どちらでもない（帰属先が未入力）なら名前を決めない。決め打ちで書くと、
 * 譲渡なのか許諾なのか分からないまま紙に載る。
 *
 * 人が直せる。決まった言い方が別にある案件もある（執筆料など）。
 */
export function rewardLabelFor(pricingModel: unknown, ownership: unknown): string | null {
  if (calcMethodFor(pricingModel) !== "ROYALTY") return null;
  const owner = String(ownership ?? "");
  if (owner === "contractor") return "利用許諾料";
  if (owner === "orderer") return "インセンティブ報酬";
  return null;
}
