// 取込用の区切りテキスト・パーサ（Phase 4-5・依存ゼロ）。
// - 区切りは自動判定：ヘッダ行にタブがあれば TSV（Excelのセル範囲コピペ）、なければ CSV。
// - 引用符対応：Excelの「CSVとして保存」はカンマ/改行を含む値を "..." で囲み、"" で
//   リテラルのダブルクオートを表す。これを正しく復元する。
// React 非依存の純関数。ユニットテスト対象。

export function detectDelimiter(headerLine: string): "\t" | "," {
  return headerLine.includes("\t") ? "\t" : ",";
}

// 引用符を考慮してレコード（行×セル）へ分解する。改行/区切りは引用内ではリテラル。
export function parseRecords(text: string, delimiter: string): string[][] {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      record.push(field); field = "";
    } else if (c === "\n") {
      record.push(field); records.push(record); field = ""; record = [];
    } else {
      field += c;
    }
  }
  record.push(field);
  records.push(record);
  return records;
}

export function parseDelimited(
  text: string,
  headerMap: Record<string, string>
): { rows: Record<string, string>[]; unmapped: string[] } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return { rows: [], unmapped: [] };
  const delimiter = detectDelimiter(normalized.split("\n")[0]);
  const records = parseRecords(normalized, delimiter)
    .filter((cells) => cells.some((cell) => cell.trim() !== ""));
  if (!records.length) return { rows: [], unmapped: [] };
  const rawHeaders = records[0].map((header) => header.trim());
  const fields = rawHeaders.map((header) => headerMap[header] ?? headerMap[header.toLowerCase()] ?? "");
  const unmapped = rawHeaders.filter((_, index) => !fields[index]);
  const rows = records.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    fields.forEach((field, index) => { if (field) row[field] = (cells[index] ?? "").trim(); });
    return row;
  });
  return { rows, unmapped };
}
