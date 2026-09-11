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
