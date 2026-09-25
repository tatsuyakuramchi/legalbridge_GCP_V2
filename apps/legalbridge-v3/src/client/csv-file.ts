/**
 * 選んだ CSV ファイルを読む。
 *
 * 取り込み口が画面ごとに増えて、同じ関数が3つに増えていた。
 * 文字コードの判定は1か所にしておかないと、片方だけ直して片方が化ける。
 */

/** ブラウザで文字コードを判定して読む。UTF-8 で化けたら Shift_JIS で読み直す。 */
export async function readCsv(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("�")) return utf8;
  try { return new TextDecoder("shift_jis").decode(buf); } catch { return utf8; }
}
