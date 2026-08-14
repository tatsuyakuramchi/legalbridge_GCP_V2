import assert from "node:assert/strict";
import test from "node:test";
import { hasSlackUserMention, hasUnresolvedSlackId, resolveSlackMentions, slackDisplayName } from "./slack-mentions.js";

const staff = [{ id: "U0ABC123", name: "田中 太郎" }, { id: "U0DEF456", name: "鈴木 花子" }];

test("V1がBacklog本文へ書いた依頼者メンションを氏名へ置換する", () => {
  const body = ["依頼タイプ: nda", "希望納期: 2026-09-01", "依頼者: <@U0ABC123>"].join("\n");
  assert.ok(resolveSlackMentions(body, staff).includes("依頼者: @田中 太郎"));
});

test("担当者マスタに無いIDは情報を落とさず @U… で残す", () => {
  assert.equal(resolveSlackMentions("依頼者: <@U0ZZZ999>", staff), "依頼者: @U0ZZZ999");
});

test("表示名付き記法はマスタを優先し、無ければ表示名を使う", () => {
  assert.equal(resolveSlackMentions("<@U0ABC123|tanaka>", staff), "@田中 太郎");
  assert.equal(resolveSlackMentions("<@U0ZZZ999|@yamada>", staff), "@yamada");
});

test("チャンネル・特殊メンション・エスケープリンクも読める形にする", () => {
  assert.equal(resolveSlackMentions("<#C0AAA111|legal> <!here>", staff), "#legal @here");
  assert.equal(resolveSlackMentions("<https://example.com/x|課題>", staff), "課題");
  assert.equal(resolveSlackMentions("<mailto:a@example.com|a@example.com>", staff), "a@example.com");
});

test("複数メンションと Map/Record/関数のルックアップを扱える", () => {
  const text = "<@U0ABC123> と <@U0DEF456> が担当";
  const expected = "@田中 太郎 と @鈴木 花子 が担当";
  assert.equal(resolveSlackMentions(text, staff), expected);
  assert.equal(resolveSlackMentions(text, new Map(staff.map((s) => [s.id, s.name]))), expected);
  assert.equal(resolveSlackMentions(text, { U0ABC123: "田中 太郎", U0DEF456: "鈴木 花子" }), expected);
  assert.equal(resolveSlackMentions(text, (id) => staff.find((s) => s.id === id)?.name), expected);
});

test("記法を含まない本文・空値はそのまま返す", () => {
  assert.equal(resolveSlackMentions("依頼者: 田中 太郎", staff), "依頼者: 田中 太郎");
  assert.equal(resolveSlackMentions(null, staff), "");
  assert.equal(resolveSlackMentions(undefined, staff), "");
});

test("生のユーザーIDを氏名へ、未解決ならIDのまま返す", () => {
  assert.equal(slackDisplayName("U0ABC123", staff), "田中 太郎");
  assert.equal(slackDisplayName("U0ZZZ999", staff), "U0ZZZ999");
  assert.equal(slackDisplayName(null, staff), "");
});

test("メンション判定はグローバル正規表現の状態を持ち越さない", () => {
  assert.equal(hasSlackUserMention("依頼者: <@U0ABC123>"), true);
  assert.equal(hasSlackUserMention("依頼者: <@U0ABC123>"), true);
  assert.equal(hasSlackUserMention("依頼者: 田中 太郎"), false);
});

test("解決後に残ったSlackユーザーIDを検出する（担当者マスタ登録の案内用）", () => {
  assert.equal(hasUnresolvedSlackId("依頼者: @U0ZZZ999"), true);
  assert.equal(hasUnresolvedSlackId("依頼者: @田中 太郎"), false);
  assert.equal(hasUnresolvedSlackId("メール: a@example.com"), false);
  assert.equal(hasUnresolvedSlackId(null), false);
});
