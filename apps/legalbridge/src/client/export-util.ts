// 一覧のエクスポート共通ユーティリティ（Phase 6・依存ゼロ）。
// CSV（RFC-4180エスケープ・BOM付き）と軽量Excel(.xls＝HTMLテーブル方式・SheetJS非依存)。
// PaymentReport のローカル実装を汎用化し、各一覧から再利用する。React 非依存の純関数。

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

const cell = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "" : String(v);

export function toCsv<T>(columns: ExportColumn<T>[], rows: T[]): string {
  const escape = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = columns.map((c) => escape(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => escape(cell(c.value(row)))).join(",")).join("\r\n");
  return rows.length ? `${header}\r\n${body}` : header;
}

export function toExcelHtml<T>(sheetName: string, columns: ExportColumn<T>[], rows: T[]): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const head = columns.map((c) => `<th>${esc(c.header)}</th>`).join("");
  const body = rows.map((row) =>
    `<tr>${columns.map((c) => `<td>${esc(cell(c.value(row)))}</td>`).join("")}</tr>`).join("");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${esc(sheetName)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
<body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function download(content: string, filename: string, mime: string): void {
  const blob = new Blob(["﻿" + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportCsv<T>(filename: string, columns: ExportColumn<T>[], rows: T[]): void {
  download(toCsv(columns, rows), `${filename}.csv`, "text/csv;charset=utf-8");
}

export function exportExcel<T>(filename: string, sheetName: string, columns: ExportColumn<T>[], rows: T[]): void {
  download(toExcelHtml(sheetName, columns, rows), `${filename}.xls`, "application/vnd.ms-excel");
}
