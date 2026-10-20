import { asIsoDate, asNumber, cellValue, readWorkbook, sheetByName, type Sheet, type Workbook } from "../core/xlsx.js";

/**
 * 月次業務報告書兼フィー精算書（Excel）の読み取り（A-073）。
 *
 * 受注者が毎月出す Excel から、役務提供完了通知書に要るものだけを拾う：
 *   対象月・提出日・実績時間・超過時間（月次報告書）、案件別の実績（案件別発注管理）、経費明細。
 * 基本枠・基本報酬・基準単価は Excel の設定値だが、正は条件明細（発注書）なので読み込まず、
 * 食い違いを警告するためだけに見る。
 *
 * 置き場は決まったセル（A4 対象月・F4 提出日・B7 基本枠・D7 実績時間・H7 超過時間・B8 基本報酬・D9 基準単価）。
 * 行や列が少しずれても読めるよう、見出しの文字（「対象月」「実績時間」…）の右隣の値も探す。
 */
export interface ReportMatter { code: string | null; name: string; category: string | null; hours: number | null; outcome: string | null }
export interface ReportExpense { date: string | null; category: string | null; description: string; amount: number }
export interface MonthlyReport {
  sheetNames: string[];
  /** 対象月。"2026-11"。 */
  targetMonth: string | null;
  submittedOn: string | null;
  actualHours: number | null;
  overtimeHours: number | null;
  /** Excel 側の設定値（条件明細と突き合わせるだけ）。 */
  baseHours: number | null;
  baseFee: number | null;
  unitRate: number | null;
  matters: ReportMatter[];
  expenses: ReportExpense[];
}

/** 見出しの照合用（全角半角をそろえる）。値そのものは raw で読む（相手の表記を変えない）。 */
const text = (v: unknown) => String(v ?? "").normalize("NFKC").trim();
const raw = (v: unknown) => String(v ?? "").trim();
const colOf = (ref: string) => ref.replace(/\d+/g, "");
const rowOf = (ref: string) => Number(ref.replace(/[A-Z]+/g, ""));
const colIndex = (col: string) => [...col].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const colName = (i: number) => { let s = ""; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

/** 見出しの文字を含むセルの右隣（同じ行で次に値のあるセル）。 */
function rightOfLabel(sheet: Sheet | null, label: string, maxRow = 80): string | number | boolean | null {
  if (!sheet) return null;
  for (const [ref, cell] of sheet.cells) {
    if (rowOf(ref) > maxRow || cell.t !== "s") continue;
    if (!text(cell.v).replace(/\s/g, "").includes(label)) continue;
    const row = rowOf(ref);
    const start = colIndex(colOf(ref));
    for (let c = start + 1; c <= start + 6; c++) {
      const v = sheet.cells.get(`${colName(c)}${row}`)?.v;
      if (v !== null && v !== undefined && text(v) !== "") return v;
    }
  }
  return null;
}

/** 決まったセルを先に見て、空か読めなければ見出しから探す。 */
function pick(sheet: Sheet | null, ref: string, label: string, read: (v: string | number | boolean | null) => string | number | null) {
  const fixed = read(cellValue(sheet, ref));
  if (fixed !== null) return fixed;
  return read(rightOfLabel(sheet, label));
}

/** 見出し行（複数の語を含む行）を探し、列名 → 列 の表にする。 */
function headerMap(sheet: Sheet | null, must: string[], from = 1, to = 200): { row: number; cols: Map<string, string> } | null {
  if (!sheet) return null;
  const byRow = new Map<number, Array<{ col: string; v: string }>>();
  for (const [ref, cell] of sheet.cells) {
    const r = rowOf(ref);
    if (r < from || r > to || cell.t !== "s") continue;
    byRow.set(r, [...(byRow.get(r) ?? []), { col: colOf(ref), v: text(cell.v).replace(/\s/g, "") }]);
  }
  for (const [row, cells] of [...byRow.entries()].sort(([a], [b]) => a - b)) {
    if (!must.every((m) => cells.some((c) => c.v.includes(m)))) continue;
    const cols = new Map<string, string>();
    for (const c of cells) if (c.v) cols.set(c.v, c.col);
    return { row, cols };
  }
  return null;
}
const colFor = (cols: Map<string, string>, ...names: string[]): string | null => {
  for (const n of names) for (const [k, col] of cols) if (k.includes(n)) return col;
  return null;
};

function readMatters(sheet: Sheet | null): ReportMatter[] {
  if (!sheet) return [];
  const head = headerMap(sheet, ["案件"]);
  const cols = head?.cols ?? new Map<string, string>();
  const cCode = colFor(cols, "案件ID", "案件番号", "案件コード", "ID") ?? "B";
  const cName = colFor(cols, "案件名", "件名", "業務名", "案件") ?? "C";
  const cCat = colFor(cols, "業務区分", "区分", "種別");
  const cHours = colFor(cols, "実績時間", "時間", "工数") ?? "E";
  const cOut = colFor(cols, "成果", "内容", "備考", "対応") ?? "I";
  const out: ReportMatter[] = [];
  const start = (head?.row ?? 3) + 1;
  for (let r = start; r <= start + 200; r++) {
    const code = raw(cellValue(sheet, `${cCode}${r}`));
    const name = raw(cellValue(sheet, `${cName}${r}`));
    const hours = asNumber(cellValue(sheet, `${cHours}${r}`));
    if (!code && !name) continue;
    if (/^(合計|小計|計)$/.test(code) || /^(合計|小計|計)$/.test(name)) continue;
    out.push({ code: code || null, name: name || code, category: cCat ? raw(cellValue(sheet, `${cCat}${r}`)) || null : null,
               hours, outcome: raw(cellValue(sheet, `${cOut}${r}`)) || null });
  }
  return out.filter((m) => m.hours !== null || m.outcome);
}

function readExpenses(sheet: Sheet | null): ReportExpense[] {
  if (!sheet) return [];
  // 経費明細の見出し（日付・金額）。本文の上のほうの「実績時間」の表と混ざらないよう 20 行目以降から探す。
  const head = headerMap(sheet, ["日付", "金額"], 20);
  const cols = head?.cols ?? new Map<string, string>();
  const cDate = colFor(cols, "日付") ?? "B";
  const cCat = colFor(cols, "区分", "種別", "費目") ?? "D";
  const cDesc = colFor(cols, "内容", "摘要", "説明") ?? "E";
  const cAmt = colFor(cols, "金額") ?? "G";
  const out: ReportExpense[] = [];
  const start = head ? head.row + 1 : 50;
  const end = head ? head.row + 40 : 64;
  for (let r = start; r <= end; r++) {
    const amount = asNumber(cellValue(sheet, `${cAmt}${r}`));
    const desc = raw(cellValue(sheet, `${cDesc}${r}`));
    const cat = raw(cellValue(sheet, `${cCat}${r}`));
    if (/合計|小計/.test(desc) || /合計|小計/.test(cat)) continue;
    if (amount === null || amount === 0 || (!desc && !cat)) continue;
    out.push({ date: asIsoDate(cellValue(sheet, `${cDate}${r}`)), category: cat || null, description: desc || cat, amount: Math.round(amount) });
  }
  return out;
}

export function parseMonthlyReport(buf: Buffer): MonthlyReport {
  const wb: Workbook = readWorkbook(buf);
  const main = sheetByName(wb, "月次報告書") ?? wb.sheets[0] ?? null;
  const matters = sheetByName(wb, "案件別発注管理") ?? sheetByName(wb, "案件別実績明細") ?? null;
  const asMonth = (v: string | number | boolean | null) => { const d = asIsoDate(v); return d ? d.slice(0, 7) : null; };
  const num = (v: string | number | boolean | null) => asNumber(v);
  const monthRaw = pick(main, "A4", "対象月", (v) => asMonth(v));
  return {
    sheetNames: wb.sheets.map((s) => s.name),
    targetMonth: monthRaw === null ? null : String(monthRaw),
    submittedOn: (pick(main, "F4", "提出日", (v) => asIsoDate(v)) as string | null),
    actualHours: pick(main, "D7", "実績時間", num) as number | null,
    overtimeHours: pick(main, "H7", "超過時間", num) as number | null,
    baseHours: pick(main, "B7", "基本枠", num) as number | null,
    baseFee: pick(main, "B8", "基本報酬", num) as number | null,
    unitRate: pick(main, "D9", "基準単価", num) as number | null,
    matters: readMatters(matters),
    expenses: readExpenses(main)
  };
}

/** 条件明細（正）と Excel の設定値の食い違い。Excel の値は使わない。 */
export function reportWarnings(
  report: MonthlyReport,
  condition: { hoursIncluded: number | null; flatAmount: number | null; overageUnitAmount: number | null; timeSettlement: boolean },
  round: { serviceFrom: string | null; serviceTo: string | null } | null = null
): string[] {
  const out: string[] = [];
  const yen = (n: number) => n.toLocaleString("ja-JP");
  if (!condition.timeSettlement) out.push("この条件は時間精算ではありません。実績時間は記録しますが金額には使いません");
  if (report.actualHours === null) out.push("実績時間が読めませんでした（月次報告書の D7 か「実績時間」の右）");
  if (report.baseHours !== null && condition.hoursIncluded !== null && report.baseHours !== condition.hoursIncluded) {
    out.push(`Excel の基本枠 ${report.baseHours} h は条件明細の包括枠 ${condition.hoursIncluded} h と違います（条件明細の値で計算します）`);
  }
  if (report.baseFee !== null && condition.flatAmount !== null && Math.round(report.baseFee) !== condition.flatAmount) {
    out.push(`Excel の基本報酬 ${yen(Math.round(report.baseFee))} 円は条件明細の月額 ${yen(condition.flatAmount)} 円と違います（条件明細の値で計算します）`);
  }
  if (report.unitRate !== null && condition.overageUnitAmount !== null && Math.round(report.unitRate) !== condition.overageUnitAmount) {
    out.push(`Excel の基準単価 ${yen(Math.round(report.unitRate))} 円は条件明細の超過単価 ${yen(condition.overageUnitAmount)} 円と違います（条件明細の値で計算します）`);
  }
  if (report.actualHours !== null && report.overtimeHours !== null && condition.hoursIncluded !== null) {
    const expected = Math.max(0, report.actualHours - condition.hoursIncluded);
    if (Math.abs(expected - report.overtimeHours) > 0.01) {
      out.push(`Excel の超過時間 ${report.overtimeHours} h は 実績 − 包括枠 ＝ ${expected} h と合いません（実績時間から計算します）`);
    }
  }
  if (round?.serviceFrom && report.targetMonth && report.targetMonth !== round.serviceFrom.slice(0, 7)) {
    out.push(`Excel の対象月 ${report.targetMonth} はこの回（${round.serviceFrom.slice(0, 7)}）と違います`);
  }
  const sum = report.matters.reduce((a, m) => a + (m.hours ?? 0), 0);
  if (report.matters.length && report.actualHours !== null && Math.abs(sum - report.actualHours) > 0.01) {
    out.push(`案件別の時間の合計 ${sum} h が実績時間 ${report.actualHours} h と合いません`);
  }
  return out;
}

/** 通知書の「業務内容」の行に写す文（案件 ID 件名 時間 を 1 行ずつ）。 */
export function matterLinesText(report: MonthlyReport): string {
  return report.matters
    .map((m) => [m.code, m.name !== m.code ? m.name : null, m.hours !== null ? `${m.hours} h` : null].filter(Boolean).join(" "))
    .join("\n");
}
