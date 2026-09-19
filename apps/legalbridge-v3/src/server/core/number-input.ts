/**
 * 人が打った数字を読む。
 *
 * 画面の数字欄は文字列で持っている。読み方が2か所にあると、片方だけが
 * 桁区切りのカンマを落として、もう片方が落とさない、ということが起きる。
 * 実際に起きた：試算は「810,479」を 810479 として計算して許諾料を出すのに、
 * 保存は Number("810,479") → NaN → JSON で null になり、サーバは受領額の
 * 入っていない実績として読んで、入れた覚えのない
 * 「受領価格（1個あたり）を入れてください」で止まっていた。
 * 画面が試算に使う値と、サーバへ送る値は、同じここから出す。
 *
 * 数字として読めないものは null を返す。0 として通すと、金額の入っていない
 * 実績が黙って保存される。呼ぶ側が「空欄」と「読めない字」を区別できるよう、
 * 空欄かどうかは呼ぶ側で先に見る。
 */
export function readNumberInput(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const cleaned = text
    // 全角の数字。コピーして貼ると混ざる。
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // 桁区切り。画面の表示をそのまま貼ると入ってくる。
    .replace(/[,，、\s]/g, "")
    .replace(/^[¥￥]/, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}
