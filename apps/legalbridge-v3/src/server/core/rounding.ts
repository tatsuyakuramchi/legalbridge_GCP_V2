/**
 * 金額の端数処理。
 *
 * 数量は小数を取る（0.5人日・1.5枚）。単価を掛けると金額に端数が出るが、
 * 金額は最小通貨単位（円）の整数でしか持てない。条件明細の金額欄は bigint
 * なので、端数のまま渡すと
 *   invalid input syntax for type bigint: "157987.5"
 * で落ちる。一括作成が実際にこれで止まった。
 *
 * 丸めるのは行ごと。合計だけ丸めると、紙に並ぶ行の金額が端数のまま出て、
 * 足しても合計に一致しなくなる。行を丸めて足せば、明細の合計と総額が必ず合う。
 *
 * 数量と単価そのものは丸めない（0.5人日は 0.5人日のまま出す）。
 */

/** 四捨五入。Math.round は負の .5 を 0 側へ寄せるので、絶対値で丸める。 */
export function roundAmount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n));
}

/**
 * 検収書・役務提供完了通知書の消費税の端数処理。書類ごとに人が選ぶ。
 *
 * 発注書の消費税は相手方の計算（電卓・先方の請求書）で出ていることが多く、
 * 切り捨てで出した発注書に切り上げの検収書を返すと 1 円ずれる。どちらに
 * 合わせるかは書類を作る人にしか分からないので、選べるようにする。
 * 既定は切り上げ（V1 からの決まり。選ばなかった書類の額は変わらない）。
 *
 * 同じ選択で支払（payments.tax_amount）も計算する。紙と支払・経理の消費税が
 * 食い違わないように。値は手入力（manual_inputs.tax_rounding）に、画面の
 * 選択肢の文字のまま入る。英字の値も受ける。
 */
export type TaxRounding = "ceil" | "floor" | "round";

export const TAX_ROUNDING_INPUT = "tax_rounding";

export const TAX_ROUNDING_LABEL: Record<TaxRounding, string> =
  { ceil: "切り上げ", floor: "切り捨て", round: "四捨五入" };

export const DEFAULT_TAX_ROUNDING: TaxRounding = "ceil";

/** 手入力の値を丸め方にする。空・読めない値は既定（切り上げ）。 */
export function taxRoundingOf(value: unknown): TaxRounding {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "floor" || text === TAX_ROUNDING_LABEL.floor) return "floor";
  if (text === "round" || text === TAX_ROUNDING_LABEL.round) return "round";
  return DEFAULT_TAX_ROUNDING;
}

/**
 * 税抜額 × 税率 の消費税額を、選んだ丸め方で。
 * 税率は % の整数で掛けてから 100 で割る（0.08 を掛けると 1250 × 0.08 が
 * 100.00000000000001 になり、切り上げで 101 円になる）。
 */
export function taxWithRounding(amountExTax: number, taxRatePct: number, mode: TaxRounding): number {
  const raw = ((Number(amountExTax) || 0) * (Number(taxRatePct) || 0)) / 100;
  if (mode === "floor") return Math.floor(raw);
  if (mode === "round") return roundAmount(raw);
  return Math.ceil(raw);
}
