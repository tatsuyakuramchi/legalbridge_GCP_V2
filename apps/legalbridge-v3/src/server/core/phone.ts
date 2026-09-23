/**
 * 電話番号の国際表記（海外版の書類）。
 *
 * 担当者・自社の電話は「03-6811-0730」のような国内表記で登録してある。海外版の
 * 発注書にそのまま出すと相手が掛けられないので、紙にするときだけ
 * 「+81-3-6811-0730」に直す。登録し直させない（国内版は国内表記のまま）。
 *
 *   ・全角の数字・記号は半角に寄せる。区切りは「-」に揃える
 *   ・「+」か「00」で始まる番号は国際表記とみなし、そのまま（区切りだけ揃える）
 *   ・「0」で始まる番号は国番号（既定 +81）を付け、先頭の 0 を落とす
 *   ・それ以外（先頭が 0 でも + でもない）は何も決めつけず、そのまま返す
 */
export function toInternationalPhone(value: unknown, countryCode = "+81"): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const half = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[（(]/g, "-").replace(/[）)]/g, "-")
    // 全角ハイフン・各種ダッシュ・マイナス記号・長音記号を「-」に寄せる。
    .replace(/[\u2010-\u2015\u2212\uFF0D\uFE63\u30FC]/g, "-")
    .replace(/[\s.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // 内線や注記（「内線 12」「(代表)」）が混じるものは触らない。
  if (!/^[+\d-]+$/.test(half)) return raw;
  if (half.startsWith("+")) return half;
  if (half.startsWith("00")) return `+${half.slice(2).replace(/^-/, "")}`;
  if (half.startsWith("0")) {
    const rest = half.slice(1).replace(/^-/, "");
    return rest ? `${countryCode}-${rest}` : raw;
  }
  return raw;
}
