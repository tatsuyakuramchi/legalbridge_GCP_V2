import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { buildZip, crc32 } from "../core/zip.js";
import { columnIndex, decodeXml, readWorkbook, serialToDate, unzip } from "./xlsx.js";
import { DomainError } from "../core/errors.js";

const enc = new TextEncoder();

/** deflate で詰めた ZIP（Excel が書く形）。core/zip.ts は保存だけなので、ここで組む。 */
function deflatedZip(entries: Array<{ name: string; text: string }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = enc.encode(e.text);
    const packed = new Uint8Array(deflateRawSync(raw));
    const crc = crc32(raw);
    const local = new Uint8Array([
      ...le32(0x04034b50), ...le16(20), ...le16(0x0800), ...le16(8), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(packed.length), ...le32(raw.length), ...le16(name.length), ...le16(0),
      ...name]);
    parts.push(local, packed);
    central.push(new Uint8Array([
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0x0800), ...le16(8), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(packed.length), ...le32(raw.length), ...le16(name.length), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name]));
    offset += local.length + packed.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array([
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length),
    ...le32(cdSize), ...le32(offset), ...le16(0)]);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="2026年3月" sheetId="1" r:id="rId1"/><sheet name="印税計上額" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`;
const STRINGS = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>販売月</t></si><si><t>タイトル名称</t></si><si><r><t>Role&amp;Roll</t></r><r><t xml:space="preserve"> Vol.200</t></r></si>
<si><t>売上合計</t><rPh sb="0" eb="4"><t>ウリアゲゴウケイ</t></rPh></si></sst>`;
const SHEET1 = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>DL数</t></is></c></row>
<row r="2"><c r="A2" s="3"><v>46113</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>3</v></c><c r="D2"><f>C2*2</f><v>6</v></c></row>
<row r="4"><c r="B4" t="s"><v>3</v></c><c r="C4" t="b"><v>1</v></c><c r="E4" t="str"><f>"x"</f><v>x</v></c></row>
</sheetData></worksheet>`;
const SHEET2 = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

const book = () => deflatedZip([
  { name: "xl/workbook.xml", text: WORKBOOK },
  { name: "xl/_rels/workbook.xml.rels", text: RELS },
  { name: "xl/sharedStrings.xml", text: STRINGS },
  { name: "xl/worksheets/sheet1.xml", text: SHEET1 },
  { name: "xl/worksheets/sheet2.xml", text: SHEET2 }
]);

test("deflate の ZIP を展開できる（保存だけの ZIP も）", () => {
  const files = unzip(book());
  assert.ok(files.has("xl/workbook.xml"));
  assert.match(new TextDecoder().decode(files.get("xl/sharedStrings.xml")!), /販売月/);
  const stored = buildZip([{ name: "a.txt", data: enc.encode("hello") }]);
  assert.equal(new TextDecoder().decode(unzip(stored).get("a.txt")!), "hello");
});

test("シートの並び・共有文字列・数式の結果・ふりがな抜きで値が読める", () => {
  const wb = readWorkbook(book());
  assert.deepEqual(wb.sheets.map((s) => s.name), ["2026年3月", "印税計上額"]);
  const rows = wb.sheets[0].rows;
  assert.deepEqual(rows[0], ["販売月", "タイトル名称", "DL数"]);
  assert.deepEqual(rows[1], [46113, "Role&Roll Vol.200", 3, 6], "数式は保存された結果を読む");
  assert.deepEqual(rows[2], [], "空の行は空");
  assert.deepEqual(rows[3], [null, "売上合計", true, null, "x"], "ふりがなは値に入れない");
  assert.deepEqual(wb.sheets[1].rows, []);
});

test("XLSX でないものは断る", () => {
  assert.throws(() => readWorkbook(enc.encode("販売月,タイトル\n")),
    (e: unknown) => e instanceof DomainError && /XLSX ではありません/.test(e.message));
});

test("列の番号とシリアル値の日付", () => {
  assert.equal(columnIndex("A"), 0);
  assert.equal(columnIndex("Z"), 25);
  assert.equal(columnIndex("AA"), 26);
  assert.equal(serialToDate(45839), "2025-07-01");
  assert.equal(serialToDate(46113), "2026-04-01");
  assert.equal(serialToDate(0), null);
  assert.equal(decodeXml("A&amp;B &#x3042; &#12356;"), "A&B あ い");
});
