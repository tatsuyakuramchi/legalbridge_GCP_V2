/**
 * 自動更新の列（A-039）の読み方。利用許諾条件・出版作品の取込で同じにする。
 */

/**
 * 更新の単位（A-039）。「1年」「12か月」「6か月」のような書き方を月に直す。
 * 読めなければ null（行ごとに止める）。
 */
export function parseRenewMonths(text: unknown): number | null {
  const s = String(text ?? "").trim().replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(年|か月|ヶ月|ケ月|カ月|months?|month|m)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const months = /年/.test(m[2] ?? "") ? n * 12 : n;
  return Number.isInteger(months) && months >= 1 && months <= 120 ? months : null;
}

/** 自動更新の言い方（A-039）。 */
export const AUTO_RENEW: Record<string, boolean> = {
  する: true, 有: true, あり: true, 自動更新: true, true: true, yes: true,
  しない: false, 無: false, なし: false, false: false, no: false
};
