import test from "node:test";
import assert from "node:assert/strict";
import { printableText } from "./printable.js";

test("刷れないハイフンの仲間は ‐ に揃える。普通のハイフン・長音・全角マイナスはそのまま", () => {
  assert.equal(printableText("塚越2\u0096247⁃36"), "塚越2‐247‐36");
  assert.equal(printableText("1˗2﹘3"), "1‐2‐3");
  assert.equal(printableText("神田小川町１－２ 2-247 2‐247 2−247 ビー"), "神田小川町１－２ 2-247 2‐247 2−247 ビー");
});

test("制御文字は Windows-1252 の字に戻すか消す。改行とタブは残す", () => {
  assert.equal(printableText("\u0093引用\u0094\u0081"), "“引用”");
  assert.equal(printableText("a\u0007b\nc\td"), "ab\nc\td");
});
