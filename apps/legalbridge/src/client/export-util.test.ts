import assert from "node:assert/strict";
import test from "node:test";
import { toCsv, toExcelHtml, type ExportColumn } from "./export-util.js";

type Row = { name: string; amount: number | null; note: string | null };
const columns: ExportColumn<Row>[] = [
  { header: "名称", value: (r) => r.name },
  { header: "金額", value: (r) => (r.amount == null ? "" : r.amount) },
  { header: "備考", value: (r) => r.note }
];
const rows: Row[] = [
  { name: "株式会社A, B", amount: 1000, note: "行1\n行2" },
  { name: 'クオート"入り"', amount: null, note: null }
];

test("toCsv はヘッダ行＋RFC-4180エスケープ", () => {
  const csv = toCsv(columns, rows);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "名称,金額,備考");
  // カンマ・改行・クオートを含む値は囲む／"" にエスケープ。
  assert.equal(lines[1], '"株式会社A, B",1000,"行1\n行2"');
  assert.equal(lines[2], '"クオート""入り""",,');
});

test("toCsv は空配列でヘッダのみ", () => {
  assert.equal(toCsv(columns, []), "名称,金額,備考");
});

test("toExcelHtml はHTMLテーブル・エスケープ・シート名を含む", () => {
  const html = toExcelHtml("テスト表", columns, rows);
  assert.match(html, /<x:Name>テスト表<\/x:Name>/);
  assert.match(html, /<th>名称<\/th>/);
  assert.match(html, /<td>株式会社A, B<\/td>/);
  // null は空セル。
  assert.match(html, /<td><\/td>/);
});
