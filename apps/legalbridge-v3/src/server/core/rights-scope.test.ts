import test from "node:test";
import assert from "node:assert/strict";
import {
  displayScope, parseLanguages, parseRegions, regionName, scopeAllows
} from "./rights-scope.js";

test("表示名から選択へ戻せる（保存した文字列を画面で開き直す）", () => {
  assert.deepEqual(parseRegions("日本、台湾"), [
    { code: "JP", name: "日本" },
    { code: "TW", name: "台湾" }
  ]);
});

test("ISO コードで書かれていても引き当てる", () => {
  assert.deepEqual(parseRegions("JP, tw"), [
    { code: "JP", name: "日本" },
    { code: "TW", name: "台湾" }
  ]);
});

test("表に無い語は自由記載として残す（移行したデータを捨てない）", () => {
  assert.deepEqual(parseRegions("日本国内"), [{ code: "", name: "日本国内" }]);
});

test("全世界・全言語は専用のコードになる", () => {
  assert.equal(parseRegions("全世界")[0].code, "WORLD");
  assert.equal(parseLanguages("全言語")[0].code, "ALL");
});

test("選択から文字列へ戻すと、元の書き方に関わらず同じ形になる", () => {
  assert.equal(displayScope(parseRegions("JP、台湾")), "日本、台湾");
});

test("名前が違ってもコードが同じなら範囲内", () => {
  const allowed = [{ code: "US", name: regionName("US") }];
  assert.equal(scopeAllows(allowed, [{ code: "US", name: "アメリカ" }], "WORLD").ok, true);
});

test("コードの無い行は名前で当てる", () => {
  const allowed = [{ code: "TW", name: "台湾" }];
  assert.equal(scopeAllows(allowed, [{ code: "", name: "台湾" }], "WORLD").ok, true);
  assert.equal(scopeAllows(allowed, [{ code: "", name: "台湾地区" }], "WORLD").ok, false);
});

test("上限が全世界ならどの国でも出せる", () => {
  const allowed = [{ code: "WORLD", name: "全世界" }];
  assert.equal(scopeAllows(allowed, [{ code: "JP", name: "日本" }], "WORLD").ok, true);
});

test("上限が国ごとの指定なら、全世界では出せない", () => {
  const allowed = [{ code: "JP", name: "日本" }];
  const r = scopeAllows(allowed, [{ code: "WORLD", name: "全世界" }], "WORLD");
  assert.equal(r.ok, false);
  assert.deepEqual(r.outside.map((o) => o.name), ["全世界"]);
});

test("言語のコードは大文字小文字を揃えて比べる", () => {
  const allowed = [{ code: "ja", name: "日本語" }];
  assert.equal(scopeAllows(allowed, [{ code: "JA", name: "日本語" }], "ALL").ok, true);
});

test("何も求めていなければ、上限が何であれ範囲内", () => {
  assert.equal(scopeAllows([{ code: "JP", name: "日本" }], [], "WORLD").ok, true);
});

test("繁体字と簡体字を選べる（ISO 639-1 には無いが、台帳はこれで書き分けている）", () => {
  assert.deepEqual(parseLanguages("繁体中国語"), [{ code: "zh-Hant", name: "繁体中国語" }]);
  assert.deepEqual(parseLanguages("簡体中国語"), [{ code: "zh-Hans", name: "簡体中国語" }]);
  assert.notEqual(
    scopeAllows(parseLanguages("繁体中国語"), parseLanguages("簡体中国語"), "ALL").ok, true,
    "繁体字で取ったものを簡体字では出せない");
});

test("日本を除く全世界：名前・別の書き方・コードのどれからでも 1 つの選択に戻る", async () => {
  const { WORLD_EX_JP_REGION, isBroadRegionLabel, isWorldExJp } = await import("./rights-scope.js");
  for (const text of ["日本を除く全世界", "全世界（日本を除く）", "日本以外の全世界", "WORLD_EX_JP"]) {
    assert.deepEqual(parseRegions(text), [WORLD_EX_JP_REGION], text);
  }
  assert.equal(displayScope(parseRegions("全世界（日本を除く）")), "日本を除く全世界");
  assert.equal(regionName("WORLD_EX_JP"), "日本を除く全世界");
  assert.equal(isWorldExJp({ code: null, label: "日本を除く全世界" }), true);
  assert.equal(isWorldExJp({ code: "WORLD", name: "全世界" }), false);
  // 国を特定しない地域の名前（報告の地域の候補から外す）。
  assert.equal(isBroadRegionLabel("全世界"), true);
  assert.equal(isBroadRegionLabel("日本を除く全世界"), true);
  assert.equal(isBroadRegionLabel("アメリカ合衆国"), false);
});

test("日本を除く全世界で取ったものは、日本以外の国へ出せる。日本と全世界へは出せない", async () => {
  const { WORLD_EX_JP_REGION } = await import("./rights-scope.js");
  const allowed = [WORLD_EX_JP_REGION];
  assert.equal(scopeAllows(allowed, parseRegions("アメリカ合衆国、フランス"), "WORLD").ok, true);
  assert.equal(scopeAllows(allowed, [WORLD_EX_JP_REGION], "WORLD").ok, true);
  // コードの無い行（移行した行）でも、日本以外なら範囲内。
  assert.equal(scopeAllows(allowed, [{ code: "", name: "北米" }], "WORLD").ok, true);
  const jp = scopeAllows(allowed, parseRegions("日本、台湾"), "WORLD");
  assert.equal(jp.ok, false);
  assert.deepEqual(jp.outside.map((o) => o.name), ["日本"]);
  assert.equal(scopeAllows(allowed, parseRegions("全世界"), "WORLD").ok, false);
  // 上限が国ごとなら、日本を除く全世界では出せない。上限が全世界なら出せる。
  assert.equal(scopeAllows(parseRegions("アメリカ合衆国"), [WORLD_EX_JP_REGION], "WORLD").ok, false);
  assert.equal(scopeAllows(parseRegions("全世界"), [WORLD_EX_JP_REGION], "WORLD").ok, true);
  // 言語の次元には効かない。
  assert.equal(scopeAllows([{ code: "", name: "日本を除く全世界" }], parseLanguages("英語"), "ALL").ok, false);
});
