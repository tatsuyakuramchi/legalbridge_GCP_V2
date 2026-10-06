import test from "node:test";
import assert from "node:assert/strict";
import { parseLegalConsultSettings, readLegalConsultSettings, withMentions } from "./legal-consult-settings.js";

test("法務相談窓口：チャンネル ID の形を確かめる（名前を入れたら保存しない）", () => {
  assert.deepEqual(parseLegalConsultSettings({ channelId: " c09legal01 ", label: "#法務相談" }),
    { value: { channelId: "C09LEGAL01", label: "#法務相談" }, errors: [] });
  assert.equal(parseLegalConsultSettings({ channelId: "#法務相談" }).errors.length, 1);
  assert.equal(parseLegalConsultSettings({ channelId: "" }).errors.length, 0, "空は未設定として保存できる");
  assert.equal(readLegalConsultSettings({ channelId: "bad" }).channelId, "", "壊れた値は未設定扱い");
  assert.equal(readLegalConsultSettings(null).channelId, "");
});

test("メンションは本文の頭に <@U…>。重複と ID でないものは捨てる", () => {
  assert.equal(withMentions("確認お願いします", ["U07IKEDA1", "u07ikeda1", "bad", "W0ABCDEF1"]),
    "<@U07IKEDA1> <@W0ABCDEF1>\n確認お願いします");
  assert.equal(withMentions("本文", []), "本文");
  assert.equal(withMentions("本文", null), "本文");
});
