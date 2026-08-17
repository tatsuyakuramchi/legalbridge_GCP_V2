import assert from "node:assert/strict";
import test from "node:test";
import {
  contradictsEntityType, expectedHonorific, honorificWarnings,
  isIndividualEntity, masterEntityTypeFor, resolveHonorific
} from "./honorific.js";

test("区分の判定は文字列でも boolean でも通る", () => {
  // 取引先マスタからの自動入力は boolean、フォームの選択は文字列。
  assert.equal(isIndividualEntity("個人"), true);
  assert.equal(isIndividualEntity(false), true);
  assert.equal(isIndividualEntity("false"), true);
  assert.equal(isIndividualEntity("法人"), false);
  assert.equal(isIndividualEntity(true), false);
  // 未入力は個人と断定できないので法人扱い（テンプレートの既定も御中）。
  assert.equal(isIndividualEntity(""), false);
  assert.equal(isIndividualEntity(undefined), false);
});

test("敬称が空なら区分から導く", () => {
  assert.equal(resolveHonorific("個人", ""), "様");
  assert.equal(resolveHonorific("法人", ""), "御中");
  assert.equal(resolveHonorific("", ""), "御中");
  assert.equal(expectedHonorific("個人"), "様");
});

test("区分と逆の敬称は区分を優先する", () => {
  assert.equal(resolveHonorific("個人", "御中"), "様");
  assert.equal(resolveHonorific("法人", "様"), "御中");
  assert.equal(resolveHonorific(false, "御中"), "様");
  assert.equal(resolveHonorific(true, "様"), "御中");
});

test("「殿」は矛盾とみなさず尊重する", () => {
  assert.equal(resolveHonorific("個人", "殿"), "殿");
  assert.equal(resolveHonorific("法人", "殿"), "殿");
  assert.equal(contradictsEntityType("個人", "殿"), false);
});

test("区分が未入力なら手入力の敬称に従う", () => {
  assert.equal(resolveHonorific("", "御中"), "御中");
  assert.equal(resolveHonorific(undefined, "様"), "様");
  assert.equal(contradictsEntityType("", "御中"), false);
});

test("前後の空白は無視する", () => {
  assert.equal(resolveHonorific(" 個人 ", " 御中 "), "様");
  assert.equal(resolveHonorific("法人", "  "), "御中");
});

// ── フォーム側の警告 ─────────────────────────────────────────────────
test("食い違いを見つけたら、何がどう出るかまで伝える", () => {
  const warnings = honorificWarnings({
    VENDOR_NAME: "大神貴寛", VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "御中"
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].label, "取引先");
  assert.match(warnings[0].message, /個人/);
  assert.match(warnings[0].message, /御中/);
  // 「PDF ではこう出る」まで書かないと、直すべきか判断できない。
  assert.match(warnings[0].message, /「様」で出力/);
});

test("整合していれば警告しない", () => {
  assert.deepEqual(honorificWarnings({ VENDOR_IS_CORPORATION: "法人", VENDOR_SUFFIX: "御中" }), []);
  assert.deepEqual(honorificWarnings({ VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "様" }), []);
  // 敬称が空・区分が空・殿はいずれも警告の対象外。
  assert.deepEqual(honorificWarnings({ VENDOR_IS_CORPORATION: "個人" }), []);
  assert.deepEqual(honorificWarnings({ VENDOR_SUFFIX: "御中" }), []);
  assert.deepEqual(honorificWarnings({ VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "殿" }), []);
  assert.deepEqual(honorificWarnings({}), []);
  assert.deepEqual(honorificWarnings(undefined), []);
});

test("日本語キーの文書でも拾う", () => {
  const warnings = honorificWarnings({ 取引先種別: "法人", 取引先敬称: "様" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /「御中」で出力/);
});

test("取引先と許諾者は別々に警告する", () => {
  const warnings = honorificWarnings({
    VENDOR_IS_CORPORATION: "個人", VENDOR_SUFFIX: "御中",
    許諾者種別: "法人", LICENSOR_SUFFIX: "様"
  });
  assert.deepEqual(warnings.map((w) => w.label), ["取引先", "許諾者"]);
});

// ── 取引先マスタの区分を使えるか（宛名との突き合わせ）───────────────────
const INDIVIDUAL_MASTER = { entityType: "個人", names: ["大神貴寛", "オオガミ工房"] };

test("宛名がマスタの名称と一致すればマスタの区分を使う", () => {
  assert.equal(masterEntityTypeFor("大神貴寛", INDIVIDUAL_MASTER), "個人");
  // 屋号・筆名でも一致とみなす（vendor_id の解決も同じ3列を見ている）。
  assert.equal(masterEntityTypeFor("オオガミ工房", INDIVIDUAL_MASTER), "個人");
});

test("宛名が別人ならマスタの区分は使わない", () => {
  // vendor_id は確定時の宛名から引くので、あとで宛名を書き換えた文書では
  // マスタが別人を指す。ここで上書きすると逆に間違える。
  assert.equal(masterEntityTypeFor("株式会社ビー", INDIVIDUAL_MASTER), "");
});

test("空白の違いは同一視する", () => {
  assert.equal(masterEntityTypeFor(" 大神貴寛 ", INDIVIDUAL_MASTER), "個人");
  assert.equal(masterEntityTypeFor("大神貴寛", { entityType: "個人", names: ["大神　貴寛"] }), "");
  assert.equal(masterEntityTypeFor("大神 貴寛", { entityType: "個人", names: ["大神　貴寛"] }), "個人");
});

test("マスタが無い・区分が空・宛名が空なら何も返さない", () => {
  assert.equal(masterEntityTypeFor("大神貴寛", null), "");
  assert.equal(masterEntityTypeFor("大神貴寛", undefined), "");
  assert.equal(masterEntityTypeFor("大神貴寛", { entityType: "", names: ["大神貴寛"] }), "");
  assert.equal(masterEntityTypeFor("", INDIVIDUAL_MASTER), "");
  assert.equal(masterEntityTypeFor("大神貴寛", { entityType: "個人" }), "");
});
