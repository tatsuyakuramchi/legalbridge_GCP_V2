/**
 * 円未満の丸め。計算書に出る数字はすべてここを通す。
 *
 * 丸め方が場所ごとに違うと、同じ取引の同じ額が画面と紙とデータベースで
 * 1円ずれる。ずれた1円は相手からの問い合わせになり、月末の突き合わせで
 * 止まる。決め方は1か所に置き、呼ぶ側は「何の額か」だけを選ぶ。
 *
 * 決まり（2026-09 変更）:
 *
 *   利用許諾料  四捨五入  roundRoyalty
 *   消費税      切り捨て  floorTax
 *
 * それ以前は「消費税・その他の中間計算とも ceil で統一」だった。ceil は
 * 1円未満を必ず作者側に寄せるので支払いとしては安全だったが、相手の
 * 計算書（先方が電卓で出す額）とは合わない。合わせる側に変える。
 *
 * 源泉徴収は切り捨て（所得税法の定め）で、この決まりの外。tax.ts が持つ。
 */

/**
 * 利用許諾料の額。四捨五入。
 *
 * JavaScript の Math.round は 0.5 を大きいほうへ寄せる（-0.5 は -0）。
 * 許諾料は正の額しか出ないので、これで四捨五入になる。
 */
export const roundRoyalty = (value: number): number => Math.round(value);

/** 消費税額。切り捨て。 */
export const floorTax = (value: number): number => Math.floor(value);

/** 税抜額 × 税率 の消費税額。切り捨て。 */
export const taxOf = (amountExTax: number, taxRatePct: number): number =>
  floorTax((Number(amountExTax) || 0) * ((Number(taxRatePct) || 0) / 100));
