import { inflateRawSync } from "node:zlib";

/**
 * 最小の xlsx 読み取り（依存を足さない）。
 *
 * 月次業務報告書（Excel）の決まったセルを読むためのもの。式の値・共有文字列・インライン文字列・
 * 真偽値・数値を読む。書式（日付かどうか）は読まないので、日付は読む側が「セルの意味」で
 * 変換する（serialToIso）。書き込みは要らない。
 *
 * xlsx は zip。中央ディレクトリを辿って各エントリを取り出す（deflate か無圧縮）。
 */
export interface Cell { v: string | number | boolean | null; t: "s" | "n" | "b" | "e" | null }
export interface Sheet { name: string; cells: Map<string, Cell> }
export interface Workbook { sheets: Sheet[] }

function entries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // 中央ディレクトリの終端（EOCD）を後ろから探す。
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx ではありません（zip の終端が見つかりません）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip の中央ディレクトリが壊れています");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    // ローカルヘッダ側の名前・拡張の長さで本体の位置を出す。
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : Buffer.alloc(0));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unescape = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

/** <si> の中の <t> を全部つなぐ（リッチテキストは <r><t> に分かれる）。 */
function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join(""));
  }
  return out;
}

function parseSheet(xml: string, strings: string[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const c of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = c[1];
    const attrs = c[2] ?? "";
    const body = c[3] ?? "";
    const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null;
    if (!body) { cells.set(ref, { v: null, t: null }); continue; }
    if (t === "inlineStr") {
      cells.set(ref, { v: [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join(""), t: "s" });
      continue;
    }
    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    if (v === undefined) { cells.set(ref, { v: null, t: null }); continue; }
    if (t === "s") cells.set(ref, { v: strings[Number(v)] ?? "", t: "s" });
    else if (t === "str") cells.set(ref, { v: unescape(v), t: "s" });
    else if (t === "b") cells.set(ref, { v: v === "1", t: "b" });
    else if (t === "e") cells.set(ref, { v: unescape(v), t: "e" });
    else cells.set(ref, { v: Number(v), t: "n" });
  }
  return cells;
}

export function readWorkbook(buf: Buffer): Workbook {
  const files = entries(buf);
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) throw new Error("xlsx ではありません（xl/workbook.xml がありません）");
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const targetOf = new Map<string, string>();
  for (const r of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(r[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(r[1])?.[1];
    if (id && target) targetOf.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const strings = sharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8"));
  const sheets: Sheet[] = [];
  for (const s of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unescape(/\bname="([^"]+)"/.exec(s[1])?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(s[1])?.[1] ?? "";
    const path = targetOf.get(rid);
    const xml = path ? files.get(path)?.toString("utf8") : undefined;
    sheets.push({ name, cells: xml ? parseSheet(xml, strings) : new Map() });
  }
  return { sheets };
}

export function sheetByName(wb: Workbook, name: string): Sheet | null {
  const want = name.normalize("NFKC").replace(/\s+/g, "");
  return wb.sheets.find((s) => s.name.normalize("NFKC").replace(/\s+/g, "") === want) ?? null;
}

export function cellValue(sheet: Sheet | null, ref: string): string | number | boolean | null {
  return sheet?.cells.get(ref)?.v ?? null;
}

/** Excel の日付シリアル（1900 系）を ISO の日付に。1899-12-30 起点。 */
export function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/** 日付として読む：シリアル・「2026/11/30」「2026-11-30」「2026年11月30日」。月だけ（「2026/11」「2026年11月」）は 1 日。 */
export function asIsoDate(v: string | number | boolean | null): string | null {
  if (typeof v === "number") return serialToIso(v);
  const s = String(v ?? "").normalize("NFKC").trim();
  if (!s) return null;
  const full = /^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/.exec(s);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  const month = /^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*月?$/.exec(s);
  if (month) return `${month[1]}-${month[2].padStart(2, "0")}-01`;
  return null;
}

/** 数として読む：数値、または「1,234」「64h」「¥3,125」のような文字。 */
export function asNumber(v: string | number | boolean | null): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return null;
  const s = String(v ?? "").normalize("NFKC").replace(/[,¥￥\s]/g, "").replace(/[^0-9.-]+$/g, "");
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
