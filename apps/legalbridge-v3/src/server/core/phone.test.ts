import test from "node:test";
import assert from "node:assert/strict";
import { toInternationalPhone } from "./phone.js";

test("国内表記を +81 に直す（先頭の 0 を落とす）", () => {
  assert.equal(toInternationalPhone("03-6811-0730"), "+81-3-6811-0730");
  assert.equal(toInternationalPhone("090-1234-5678"), "+81-90-1234-5678");
  assert.equal(toInternationalPhone("03(6811)0730"), "+81-3-6811-0730");
  assert.equal(toInternationalPhone("０３−６８１１−０７３０"), "+81-3-6811-0730");
  assert.equal(toInternationalPhone("0368110730"), "+81-368110730");
});

test("すでに国際表記なら区切りを揃えるだけ。00 始まりは + に", () => {
  assert.equal(toInternationalPhone("+81 3 6811 0730"), "+81-3-6811-0730");
  assert.equal(toInternationalPhone("+1-212-555-0100"), "+1-212-555-0100");
  assert.equal(toInternationalPhone("0081-3-6811-0730"), "+81-3-6811-0730");
});

test("決めつけない：0 でも + でも始まらない番号や注記付きはそのまま", () => {
  assert.equal(toInternationalPhone("212-555-0100"), "212-555-0100");
  assert.equal(toInternationalPhone("03-6811-0730（代表）"), "03-6811-0730（代表）");
  assert.equal(toInternationalPhone(""), "");
  assert.equal(toInternationalPhone(null), "");
});
