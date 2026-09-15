/**
 * Excel（.xls）の組み立て。
 *
 * V2 と同じ「HTML テーブル方式」にしてある。SheetJS などの依存を入れずに
 * Excel が開ける形。経理が受け取るファイルの見た目と扱いを V1・V2 から
 * 変えないことを優先した（提出先の運用を変えさせない）。
 *
 * V2 との違いは作る場所だけ。V2 はブラウザで作っていたが、V3 は他の出力
 * （CSV）と同じくサーバで作る。画面を開かなくても同じものが出せる。
 */

export interface XlsColumn<T> {
  header: string;
  /** 数値を返すと Excel で数値として入る。合計が取れるように文字列にしない。 */
  value: (row: T) => string | number | null | undefined;
}

const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const cell = (v: string | number | null | undefined): { text: string; numeric: boolean } => {
  if (v === null || v === undefined || v === "") return { text: "", numeric: false };
  if (typeof v === "number") return { text: String(v), numeric: Number.isFinite(v) };
  return { text: String(v), numeric: false };
};

/**
 * シート1枚。
 *
 * 文字列の升には `mso-number-format:'\@'` を付ける。付けないと Excel が
 * 「2026-10-31」を日付に、取引先コードの「0012」を 12 に変える。
 */
export function toXls<T>(sheetName: string, columns: Array<XlsColumn<T>>, rows: T[]): string {
  const head = columns.map((c) => `<th>${esc(c.header)}</th>`).join("");
  const body = rows.map((row) =>
    `<tr>${columns.map((c) => {
      const { text, numeric } = cell(c.value(row));
      return numeric
        ? `<td>${esc(text)}</td>`
        : `<td style="mso-number-format:'\\@'">${esc(text)}</td>`;
    }).join("")}</tr>`).join("");

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${esc(sheetName)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
<body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export const XLS_MIME = "application/vnd.ms-excel";

/** BOM を付ける。付けないと日本語版 Excel が Shift_JIS と誤認する。 */
export const withXlsBom = (content: string): string => `\uFEFF${content}`;

/** ダウンロード名。Excel が拒む文字を落とす。 */
export function xlsFilename(parts: Array<string | null | undefined>): string {
  const name = parts.filter((p) => p && String(p).trim()).join("_")
    .replace(/[^\w.\-一-龥ぁ-んァ-ヶー]/g, "_")
    .replace(/_{2,}/g, "_");
  return `${name || "export"}.xls`;
}
