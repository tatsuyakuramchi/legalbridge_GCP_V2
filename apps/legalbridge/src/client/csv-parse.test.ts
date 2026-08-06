import assert from "node:assert/strict";
import test from "node:test";
import { detectDelimiter, parseRecords, parseDelimited } from "./csv-parse.js";

const map: Record<string, string> = {
  "取引先名": "vendorName", "vendor_name": "vendorName",
  "メール": "email", "email": "email", "備考": "remarks"
};

test("detectDelimiter はタブ優先、なければカンマ", () => {
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
  assert.equal(detectDelimiter("a,b,c"), ",");
});

test("parseRecords は引用符内のカンマ・改行・二重引用符を保持する", () => {
  const rows = parseRecords('name,note\n"a,b","line1\nline2"\n"he said ""hi""",x', ",");
  assert.deepEqual(rows[0], ["name", "note"]);
  assert.deepEqual(rows[1], ["a,b", "line1\nline2"]);
  assert.deepEqual(rows[2], ['he said "hi"', "x"]);
});

test("parseDelimited: 引用符付きCSVを正しくマップ", () => {
  const { rows, unmapped } = parseDelimited('取引先名,メール\n"株式会社A, B",info@example.com', map);
  assert.equal(unmapped.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vendorName, "株式会社A, B");
  assert.equal(rows[0].email, "info@example.com");
});

test("parseDelimited: Excelコピペ（タブ区切り）を解釈", () => {
  const { rows } = parseDelimited("取引先名\tメール\n株式会社B\tb@example.com", map);
  assert.equal(rows[0].vendorName, "株式会社B");
  assert.equal(rows[0].email, "b@example.com");
});

test("parseDelimited: 未マップ列を報告し、空行を無視", () => {
  const { rows, unmapped } = parseDelimited("取引先名,不明列\n\n株式会社C,値\n", map);
  assert.deepEqual(unmapped, ["不明列"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vendorName, "株式会社C");
});

test("parseDelimited: 空入力は空", () => {
  assert.deepEqual(parseDelimited("   ", map), { rows: [], unmapped: [] });
});
