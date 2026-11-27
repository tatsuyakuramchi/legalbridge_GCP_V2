/**
 * 共著の取り分の計算（画面とサーバの両方から使う。ここは何も import しない）。
 * 取り分は百万分率（60% は 600000）。実質料率は 条件の料率 × 取り分。
 */

/**
 * 実質料率（条件の料率 × 取り分）から取り分（百万分率）を出す。
 * 例：料率 11% を 10% と 1% に分ける → 909091 と 90909（合計 1,000,000）。
 * 割り切れないぶんの端数で合計が 100% からずれるときは、端数の大きい行から 1 ずつ足し引きしてそろえる
 * （ずれが行の数より大きいときは入力の合計が違うので、そろえずに返す。合計の確かめで止まる）。
 */
export function sharePpmFromEffective(effectivePpm: number[], ratePpm: number): number[] {
  if (!(ratePpm > 0)) return effectivePpm.map(() => 0);
  const raw = effectivePpm.map((e) => (e / ratePpm) * 1_000_000);
  return roundToMillion(raw);
}

/** 百万分率の小数を整数にし、端数のずれだけなら合計を 1,000,000 にそろえる（大きい端数から）。 */
export function roundToMillion(raw: number[]): number[] {
  const out = raw.map((v) => Math.round(v));
  let diff = 1_000_000 - out.reduce((n, v) => n + v, 0);
  if (diff === 0 || Math.abs(diff) > raw.length) return out;
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => (diff > 0 ? b.frac - a.frac : a.frac - b.frac));
  for (const { i } of order) {
    if (diff === 0) break;
    out[i] = out[i]! + Math.sign(diff);
    diff -= Math.sign(diff);
  }
  return out;
}
