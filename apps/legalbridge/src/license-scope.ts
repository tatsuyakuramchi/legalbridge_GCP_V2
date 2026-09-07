// 利用許諾料計算書の「製品名」に使う許諾範囲（地域・言語）の出どころ（2026-09-07 の確認）。
//   製品名 = 取引モデル名（利用許諾条件書の取引形態＝イン条件の条件名）／許諾地域／許諾言語
//   地域・言語は、取引形態が「自社製造・自社販売」のときだけイン側（当社が受けた許諾条件）、
//   それ以外（再許諾・自社製造・他社販売 など）はアウト側（再許諾先・販売先との条件）を使う。
// サーバ（license-settlements/repository）・クライアント（かんたん受領入力・編集時の再補完・
// 精算画面）が同じ判定を使う。

export function usesInboundLicenseScope(transactionModelName: string): boolean {
  const name = String(transactionModelName ?? "").replace(/\s/g, "");
  return name.includes("自社製造") && name.includes("自社販売");
}
