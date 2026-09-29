import test from "node:test";
import assert from "node:assert/strict";
import { conditionNameFor, outConditionNameFor, parseUsageType } from "./naming.js";

test("条件名は 作品名｜取引モデル。出版は「紙出版」「電子出版」", () => {
  assert.equal(conditionNameFor({ workTitle: "ito", usageType: "in_house" }), "ito｜自社製造・自社販売");
  assert.equal(conditionNameFor({ workTitle: "ito", usageType: "oem" }), "ito｜自社製造・他社販売");
  assert.equal(conditionNameFor({ workTitle: "星降る夜のはなし", usageType: "pub_print" }), "星降る夜のはなし｜紙出版");
  assert.equal(conditionNameFor({ workTitle: "星降る夜のはなし", usageType: "pub_digital" }), "星降る夜のはなし｜電子出版");
});

test("再許諾は 再許諾先／目的 を名前に含める。再許諾先が無ければ 作品名｜再許諾（一律。A-063）", () => {
  assert.equal(conditionNameFor({ workTitle: "ito", usageType: "sublicense", sublicensee: "Alpha Games", purpose: "英語版の製造販売" }),
    "ito｜再許諾（Alpha Games／英語版の製造販売）");
  assert.equal(conditionNameFor({ workTitle: "ito", usageType: "sublicense", sublicensee: "Alpha Games" }),
    "ito｜再許諾（Alpha Games）");
  assert.equal(conditionNameFor({ workTitle: "ito", usageType: "sublicense" }), "ito｜再許諾");
  assert.equal(conditionNameFor({ workTitle: " ", usageType: "in_house" }), null);
});

test("取引モデルの文字列は表記ゆれごと利用形態に戻す", () => {
  assert.equal(parseUsageType("自社製造・自社販売"), "in_house");
  assert.equal(parseUsageType("自社製造 ・ 他社販売"), "oem");
  assert.equal(parseUsageType("再許諾"), "sublicense");
  assert.equal(parseUsageType("紙出版"), "pub_print");
  assert.equal(parseUsageType("出版（紙）"), "pub_print");
  assert.equal(parseUsageType("電子"), "pub_digital");
  assert.equal(parseUsageType("pub_digital"), "pub_digital");
  assert.equal(parseUsageType("配信"), null);
  assert.equal(parseUsageType(""), null);
});

test("OUT の条件名は 作品名｜許諾言語｜許諾地域｜相手先名。空は飛ばし、複数は・で繋ぐ", () => {
  assert.equal(outConditionNameFor({ workTitle: "ito", languages: "英語", regions: "アメリカ合衆国、カナダ", partyName: "Alpha Games" }),
    "ito｜英語｜アメリカ合衆国・カナダ｜Alpha Games");
  assert.equal(outConditionNameFor({ workTitle: "ito", languages: ["英語", "フランス語"], partyName: "Alpha Games" }),
    "ito｜英語・フランス語｜Alpha Games");
  assert.equal(outConditionNameFor({ workTitle: "ito", partyName: " " }), "ito");
  assert.equal(outConditionNameFor({ workTitle: "" }), "");
});
