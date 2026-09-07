import assert from "node:assert/strict";
import test from "node:test";
import { buildZip, crc32 } from "./zip-writer.js";
import { buildXlsx, columnLetter, sanitizeSheetName } from "./xlsx-writer.js";

// STORE 方式なので、ローカルヘッダを順に読めば中身を取り出せる（簡易リーダ）。
function readZip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, buffer.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

test("crc32 は標準値（'123456789' → CBF43926）", () => {
  assert.equal(crc32(Buffer.from("123456789")).toString(16), "cbf43926");
});

test("buildZip: UTF-8 名の複数エントリを STORE で束ね、中央ディレクトリと終端が整合する", () => {
  const zip = buildZip([
    { name: "検収書_個人_2026-09-20.xlsx", data: Buffer.from("abc") },
    { name: "ARC-INS-2026-0059.pdf", data: Buffer.from("%PDF-1.4") }
  ], new Date(2026, 8, 7, 12, 0, 0));
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()], ["検収書_個人_2026-09-20.xlsx", "ARC-INS-2026-0059.pdf"]);
  assert.equal(entries.get("ARC-INS-2026-0059.pdf")!.toString(), "%PDF-1.4");
  // 終端レコード: エントリ数 2
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2);
  // 中央ディレクトリの先頭にローカルヘッダのオフセット 0 が入る
  const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
  assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
  assert.equal(zip.readUInt32LE(centralOffset + 42), 0);
});

test("buildXlsx: V1 と同じ素の xlsx（シート名・見出し・数値セル・空セル省略）", () => {
  const xlsx = buildXlsx([{
    name: "検収書(個人)",
    rows: [["件名", "単価（1）", "数量（1）"], ["分析レポート作成業務（第5期）", 35000, 1], ["空あり", null, "a<b&\"c\""]]
  }]);
  const parts = readZip(xlsx);
  assert.ok(parts.has("[Content_Types].xml"));
  assert.ok(parts.has("xl/workbook.xml"));
  assert.ok(parts.has("xl/worksheets/sheet1.xml"));
  assert.match(parts.get("xl/workbook.xml")!.toString(), /<sheet name="検収書\(個人\)" sheetId="1"/);
  const sheet = parts.get("xl/worksheets/sheet1.xml")!.toString();
  assert.match(sheet, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">件名<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B2"><v>35000<\/v><\/c>/);
  assert.match(sheet, /<c r="C2"><v>1<\/v><\/c>/);
  assert.doesNotMatch(sheet, /r="B3"/);                       // null は出力しない
  assert.match(sheet, /a&lt;b&amp;&quot;c&quot;/);               // XML エスケープ
});

test("columnLetter / sanitizeSheetName", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(52), "BA");                        // 53 列目
  assert.equal(sanitizeSheetName("検収書(個人)"), "検収書(個人)");
  assert.equal(sanitizeSheetName("a/b:c"), "a_b_c");
});
