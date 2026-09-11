import { DomainError } from "../core/errors.js";

/**
 * CSV の解析。
 *
 * 出力側（exports/csv.ts）と対になる。RFC 4180 の引用規則に従い、
 * 引用符の中の区切り・改行・二重引用符を壊さない。
 *
 * 表計算から出てきたファイルを想定するので、BOM と CRLF は黙って落とす。
 * これを取りこぼすと最初の列名が「﻿条件番号」になり、
 * 「列が無い」という分かりにくい失敗になる。
 */

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/** 1行を欄に割る。引用符の中では区切りも改行も文字として扱う。 */
function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }  // "" は引用符1つ
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { record.push(field); field = ""; continue; }
    if (ch === "\r") continue;                                // CRLF の CR は捨てる
    if (ch === "\n") { record.push(field); records.push(record); record = []; field = ""; continue; }
    field += ch;
  }

  if (quoted) throw new DomainError("VALIDATION", "引用符が閉じていません。ファイルが壊れています");
  if (field !== "" || record.length) { record.push(field); records.push(record); }
  return records;
}

export function parseCsv(text: string, options: { maxRows?: number } = {}): ParsedCsv {
  const body = text.replace(/^﻿/, "");
  const records = splitRecords(body).filter((r) => r.some((c) => c.trim() !== ""));
  if (!records.length) throw new DomainError("VALIDATION", "中身がありません");

  const headers = records[0].map((h) => h.replace(/^﻿/, "").trim());
  const duplicated = headers.filter((h, i) => h !== "" && headers.indexOf(h) !== i);
  if (duplicated.length) {
    throw new DomainError("VALIDATION", `見出しが重複しています: ${[...new Set(duplicated)].join(", ")}`);
  }

  const max = options.maxRows ?? 2000;
  const dataRows = records.slice(1);
  if (dataRows.length > max) {
    throw new DomainError("VALIDATION",
      `${dataRows.length} 行あります。一度に取り込めるのは ${max} 行までです。分けて取り込んでください`);
  }

  const rows = dataRows.map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      if (header) row[header] = (record[i] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}

/** 「対象」「はい」「1」などを真偽へ。表計算の書き方に幅があるので広めに拾う。 */
export function csvBoolean(value: string | undefined): boolean | undefined {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  if (["true", "1", "yes", "y", "はい", "対象", "○", "o", "有"].includes(s)) return true;
  if (["false", "0", "no", "n", "いいえ", "対象外", "×", "x", "無"].includes(s)) return false;
  return undefined;
}

/** 金額の欄。桁区切りと通貨記号が入っていても読む（表計算からよく来る）。 */
export function csvAmount(value: string | undefined): number | undefined {
  const s = String(value ?? "").replace(/[,¥￥$\s]/g, "").trim();
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
