import test from "node:test";
import assert from "node:assert/strict";
import { csvAmount, csvBoolean, parseCsv } from "./parse.js";

test("見出しを鍵にして行を組み立てる", () => {
  const r = parseCsv("名称,区分\n株式会社甲,法人\n山田太郎,個人");
  assert.deepEqual(r.headers, ["名称", "区分"]);
  assert.deepEqual(r.rows, [
    { 名称: "株式会社甲", 区分: "法人" },
    { 名称: "山田太郎", 区分: "個人" }
  ]);
});

test("BOM を落とす。残すと最初の列名が一致しなくなる", () => {
  const r = parseCsv("﻿名称,区分\n甲,法人");
  assert.deepEqual(r.headers, ["名称", "区分"]);
  assert.equal(r.rows[0]["名称"], "甲");
});

test("CRLF でも読む。表計算はこちらで出す", () => {
  const r = parseCsv("名称,区分\r\n甲,法人\r\n");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]["区分"], "法人");
});

test("引用符の中の区切り・改行・二重引用符を壊さない", () => {
  const r = parseCsv('名称,備考\n"株式会社甲, 乙","1行目\n2行目 ""引用"""');
  assert.equal(r.rows[0]["名称"], "株式会社甲, 乙");
  assert.equal(r.rows[0]["備考"], '1行目\n2行目 "引用"');
});

test("空行は捨てる。末尾の改行で空の行を作らない", () => {
  const r = parseCsv("名称\n甲\n\n\n乙\n");
  assert.deepEqual(r.rows.map((x) => x["名称"]), ["甲", "乙"]);
});

test("欄が足りない行は空文字で埋める", () => {
  const r = parseCsv("名称,区分,カナ\n甲,法人");
  assert.equal(r.rows[0]["カナ"], "");
});

test("引用符が閉じていなければ、黙って読まずに止める", () => {
  assert.throws(() => parseCsv('名称\n"閉じていない'), /引用符が閉じていません/);
});

test("見出しの重複は止める。どちらが入るか決められない", () => {
  assert.throws(() => parseCsv("名称,名称\n甲,乙"), /見出しが重複/);
});

test("中身が無ければ止める", () => {
  assert.throws(() => parseCsv("\n\n"), /中身がありません/);
});

test("多すぎる行は受け付けず、分けるよう伝える", () => {
  const csv = "名称\n" + Array.from({ length: 11 }, (_, i) => `行${i}`).join("\n");
  assert.throws(() => parseCsv(csv, { maxRows: 10 }), /11 行あります.*10 行まで/s);
});

test("真偽の書き方に幅を持たせる", () => {
  assert.equal(csvBoolean("対象"), true);
  assert.equal(csvBoolean("はい"), true);
  assert.equal(csvBoolean("1"), true);
  assert.equal(csvBoolean("×"), false);
  assert.equal(csvBoolean("いいえ"), false);
  assert.equal(csvBoolean(""), undefined, "空は「指定なし」であって false ではない");
  assert.equal(csvBoolean("たぶん"), undefined);
});

test("金額は桁区切りと通貨記号が入っていても読む", () => {
  assert.equal(csvAmount("330,000"), 330000);
  assert.equal(csvAmount("¥1,000"), 1000);
  assert.equal(csvAmount("  500 "), 500);
  assert.equal(csvAmount(""), undefined);
  assert.equal(csvAmount("なし"), undefined);
  assert.equal(csvAmount("0"), 0, "0 と未入力を取り違えない");
});
