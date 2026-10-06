import { inflateRawSync } from "node:zlib";
import { DomainError } from "../core/errors.js";

/**
 * 最小の XLSX 読み取り（値だけ）。
 *
 * 事業部から来る電子書籍の売上は Excel（月ごとのシート）で、CSV に直してもらう
 * 手間を毎月かけたくない。XLSX は ZIP の中に XML が入っているだけなので、
 * 共有文字列と各シートのセルの値を読む分には、ライブラリを足さずに済む
 * （依存を増やすと本番のビルドと予備系の両方に効く。core/zip.ts と同じ考え）。
 *
 * 読むのは「セルに入っている値」だけ。数式は Excel が保存した計算結果（<v>）を
 * 使う。書式（日付かどうか）は読まないので、日付はシリアル値の数で返る。
 * 列の意味が分かっている側（電子書籍の取込）で日付に直す。
 */

export type CellValue = string | number | boolean | null;
export interface Sheet { name: string; rows: CellValue[][] }
export interface Workbook { sheets: Sheet[] }

/** ZIP の中身を名前 → バイト列に展開する（保存と deflate だけ。Excel はこの 2 つしか使わない）。 */
export function unzip(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // 終端レコード（EOCD）を後ろから探す。コメント付きでも 64KB 以内にある。
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DomainError("VALIDATION", "XLSX として読めません（ZIP の終端がありません）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder("utf-8");
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) {
      throw new DomainError("VALIDATION", "XLSX として読めません（ZIP の目次が壊れています）");
    }
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const uncompressed = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (view.getUint32(local, true) !== 0x04034b50) {
      throw new DomainError("VALIDATION", `XLSX として読めません（${name} の見出しが壊れています）`);
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = data.subarray(start, start + compressed);
    if (method === 0) out.set(name, body);
    else if (method === 8) {
      const raw = inflateRawSync(body);
      out.set(name, new Uint8Array(raw.buffer, raw.byteOffset, uncompressed || raw.byteLength));
    } else throw new DomainError("VALIDATION", `XLSX として読めません（${name} の圧縮方式 ${method} は扱えません）`);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? m;
  });
}

/** <t> の中身を繋ぐ（書式付き文字列は <r><t>…</t></r> が並ぶ）。 */
function textOf(xml: string): string {
  let out = "";
  // ふりがな（<rPh>）は値ではない。残すと「売上合計ウリアゲゴウケイ」のように繋がる。
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]));
  return out;
}

/** "AB" → 27（0 始まりなら 27 - 1）。 */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseSheet(xml: string, strings: string[]): CellValue[][] {
  const rows: CellValue[][] = [];
  const sheetData = xml.match(/<sheetData[^>]*>([\s\S]*?)<\/sheetData>/)?.[1] ?? "";
  for (const rowMatch of sheetData.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNo = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1);
    const cells: CellValue[] = [];
    for (const c of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const col = ref ? columnIndex(ref) : cells.length;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "n";
      let value: CellValue = null;
      if (type === "inlineStr") value = textOf(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? inner);
      else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (v !== undefined) {
          const raw = decodeXml(v);
          if (type === "s") value = strings[Number(raw)] ?? "";
          else if (type === "b") value = raw === "1";
          else if (type === "str" || type === "e") value = raw;
          else { const num = Number(raw); value = Number.isFinite(num) ? num : raw; }
        }
      }
      while (cells.length < col) cells.push(null);
      cells[col] = value;
    }
    while (rows.length < rowNo - 1) rows.push([]);
    rows[rowNo - 1] = cells;
  }
  return rows;
}

/** XLSX を読む。シートはブックの並び順。 */
export function readWorkbook(data: Uint8Array | Buffer): Workbook {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new DomainError("VALIDATION", "XLSX ではありません（Excel の「名前を付けて保存」で .xlsx にしてください）");
  }
  const files = unzip(bytes);
  const decoder = new TextDecoder("utf-8");
  const text = (name: string): string | null => {
    const f = files.get(name) ?? files.get(name.replace(/^\//, ""));
    return f ? decoder.decode(f) : null;
  };
  const workbookXml = text("xl/workbook.xml");
  if (!workbookXml) throw new DomainError("VALIDATION", "XLSX として読めません（xl/workbook.xml がありません）");
  const relsXml = text("xl/_rels/workbook.xml.rels") ?? "";
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = m[1].match(/\bId="([^"]+)"/)?.[1];
    const target = m[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const strings = sharedStrings(text("xl/sharedStrings.xml"));
  const sheets: Sheet[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(m[1].match(/\bname="([^"]*)"/)?.[1] ?? `Sheet${sheets.length + 1}`);
    const rid = m[1].match(/\br:id="([^"]+)"/)?.[1] ?? m[1].match(/\bid="([^"]+)"/)?.[1];
    const path = (rid && rels.get(rid)) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = text(path);
    sheets.push({ name, rows: xml ? parseSheet(xml, strings) : [] });
  }
  return { sheets };
}

/** Excel のシリアル値（1900 年基準）→ YYYY-MM-DD。 */
export function serialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  // 1899-12-30 を 0 とする（Excel の 1900 年うるう年バグ込みの基準）。
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
