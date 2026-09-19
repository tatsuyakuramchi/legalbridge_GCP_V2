import test from "node:test";
import assert from "node:assert/strict";
import { filename, majorUnits, percent, toCsv, withBom } from "./csv.js";

const cols = [
  { header: "番号", value: (r: any) => r.no },
  { header: "名称", value: (r: any) => r.name }
];

test("見出しと本文を CRLF で繋ぐ", () => {
  const csv = toCsv(cols, [{ no: "CL-1", name: "配信許諾" }]);
  assert.equal(csv, "番号,名称\r\nCL-1,配信許諾");
});

test("0件でも見出しだけは出す", () => {
  assert.equal(toCsv(cols, []), "番号,名称");
});

test("区切り・引用符・改行を含む値を壊さない", () => {
  const csv = toCsv(cols, [{ no: 'A"B', name: "甲, 乙\n丙" }]);
  assert.equal(csv, '番号,名称\r\n"A""B","甲, 乙\n丙"');
});

test("空と 0 を取り違えない", () => {
  const csv = toCsv(cols, [{ no: null, name: 0 }]);
  assert.equal(csv, "番号,名称\r\n,0");
});

test("BOM を付ける。無いと日本語版 Excel が文字化けする", () => {
  assert.equal(withBom("x").charCodeAt(0), 0xfeff);
});

test("金額は主単位の数値にする。合計できないと意味がない", () => {
  assert.equal(majorUnits(330000, "JPY"), "330000", "円は最小単位＝主単位");
  assert.equal(majorUnits(133000, "USD"), "1330.00", "ドルはセント→ドル");
  assert.equal(majorUnits(null, "JPY"), "", "未設定は空。0 ではない");
  assert.equal(majorUnits(0, "JPY"), "0");
});

test("料率は % の数値にする", () => {
  assert.equal(percent(125000), "12.5");
  assert.equal(percent(null), "");
  assert.equal(percent(0), "0");
});

test("ファイル名に日付を入れ、危ない文字を落とす", () => {
  const name = filename("payments", new Date("2026-09-08T00:30:00Z"));
  assert.equal(name, "payments_2026-09-08.csv", "東京の日付で切る");
  assert.ok(!filename("../etc/passwd").includes("/"), "パス区切りを残さない");
  assert.match(filename("条件"), /^条件_\d{4}-\d{2}-\d{2}\.csv$/, "日本語は残す");
});
