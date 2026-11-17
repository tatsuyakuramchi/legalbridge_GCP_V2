/**
 * 電子（出版）の算定の基礎。条件明細の price_basis に持つ。
 *
 *   list     … 配信価格（税抜）× ダウンロード数 × 料率（グロス）
 *   receipts … 受領額（税抜）× 料率（再許諾先・配信事業者から受け取った額）
 *
 * 条件書V5（出版）の第4条の電子の式と一覧の電子の欄はここから決まる。同じ料率でも基礎が違えば
 * 払う額が大きく変わる（受領額 × 42.5% のつもりが配信価格 × 42.5% になると大きな過払い）ので、
 * 入力では必ず選ばせ、料率がふつうと違う組み合わせなら確かめる。
 */
export type DigitalBasis = "list" | "receipts";

export const DIGITAL_BASIS_OPTIONS: Array<{ value: DigitalBasis; label: string }> = [
  { value: "list", label: "配信価格（税抜）× ダウンロード数 × 料率" },
  { value: "receipts", label: "受領額（税抜）× 料率（再許諾先・配信事業者から受け取った額）" }
];

/** 配信価格（グロス）にこれを超える料率は、受領額の契約の取り違えを疑う。 */
export const GROSS_RATE_CAUTION_PCT = 30;
/** 受領額にこれ未満の料率は、配信価格の契約の取り違えを疑う。 */
export const RECEIPTS_RATE_CAUTION_PCT = 15;

export const isDigitalBasis = (value: unknown): value is DigitalBasis => value === "list" || value === "receipts";

/**
 * 入力の確かめ。error は保存させない（未選択）、confirm は人に確かめてから保存する（料率が基礎に対して珍しい）。
 */
export function digitalBasisCheck(basis: unknown, ratePct: unknown): { error?: string; confirm?: string } {
  if (!isDigitalBasis(basis)) {
    return { error: "電子の算定の基礎（配信価格 × ダウンロード数／受領額）を選んでください" };
  }
  const rate = Number(String(ratePct ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(rate) || rate <= 0) return {};
  if (basis === "list" && rate > GROSS_RATE_CAUTION_PCT) {
    return { confirm: `電子の料率 ${rate}% を「配信価格（税抜）× ダウンロード数」に掛けます。`
      + `配信価格に ${GROSS_RATE_CAUTION_PCT}% を超える料率はまれです。受領額（再許諾先から受け取った額）に掛ける契約ではありませんか？\n\nこのまま保存するなら OK を押してください。` };
  }
  if (basis === "receipts" && rate < RECEIPTS_RATE_CAUTION_PCT) {
    return { confirm: `電子の料率 ${rate}% を「受領額」に掛けます。`
      + `受領額に ${RECEIPTS_RATE_CAUTION_PCT}% 未満の料率はまれです。配信価格 × ダウンロード数に掛ける契約ではありませんか？\n\nこのまま保存するなら OK を押してください。` };
  }
  return {};
}
