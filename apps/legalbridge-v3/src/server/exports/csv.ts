/**
 * CSV の組み立て。
 *
 * Excel で開かれる前提なので、RFC 4180 のエスケープに加えて
 * BOM と CRLF を付ける。日本語版 Excel は BOM が無いと UTF-8 を
 * Shift_JIS と誤認して文字化けする。
 */

export interface Column<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

const cell = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "" : String(v);

const escape = (v: string): string =>
  /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

export function toCsv<T>(columns: Array<Column<T>>, rows: T[]): string {
  const header = columns.map((c) => escape(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => escape(cell(c.value(row)))).join(","));
  return [header, ...body].join("\r\n");
}

/** BOM 付きの本文。Excel が UTF-8 と認識するために要る。 */
export const withBom = (csv: string): string => `﻿${csv}`;

/**
 * 最小通貨単位の整数を、表計算で合計できる数値へ。
 * 通貨記号や桁区切りは付けない（付けると文字列になって合計できない）。
 */
export function majorUnits(amount: unknown, currency: unknown): string {
  if (amount === null || amount === undefined) return "";
  const minor = ["JPY", "KRW", "VND"].includes(String(currency ?? "JPY")) ? 1 : 100;
  const value = Number(amount) / minor;
  return minor === 1 ? String(value) : value.toFixed(2);
}

/** 料率（ppm）を % の数値へ。12.5% は 12.5。 */
export function percent(ppm: unknown): string {
  return ppm === null || ppm === undefined ? "" : String(Number(ppm) / 10_000);
}

/**
 * ダウンロード名。日付を含めて、いつ出したものか分かるようにする。
 * 制御文字とパス区切りは落とす（ヘッダに入れるため）。
 */
export function filename(base: string, now = new Date()): string {
  const jst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
  const safe = base.replace(/[^\p{L}\p{N}_-]/gu, "_");
  return `${safe}_${jst}.csv`;
}
