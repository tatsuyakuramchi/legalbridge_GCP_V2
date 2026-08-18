import assert from "node:assert/strict";
import test from "node:test";
import {
  MATTER_SLACK_TEMPLATES, composeTemplateText, filterMentionCandidates, templateUsesDocument
} from "./matter-slack-message.js";
import { buildTemplateMessage } from "./server/integrations/slack-matter-channel.js";

// ── メンション候補の検索（一覧から目で探せない件数になるため）─────────────
const CANDIDATES = [
  { id: "U0AGW8GJD1T", name: "山田 太郎" },
  { id: "U0BHX9HKE2U", name: "山下 花子" },
  { id: "U0CJY1JLF3V", name: "鈴木 一郎" },
  { id: "U0DKZ2KMG4W", name: "Tanaka Jiro" }
];

test("空の検索語では全件返す", () => {
  assert.equal(filterMentionCandidates(CANDIDATES, "").length, 4);
  assert.equal(filterMentionCandidates(CANDIDATES, "   ").length, 4);
});

test("名前の一部で絞り込む", () => {
  assert.deepEqual(filterMentionCandidates(CANDIDATES, "山").map((c) => c.id), ["U0AGW8GJD1T", "U0BHX9HKE2U"]);
  assert.deepEqual(filterMentionCandidates(CANDIDATES, "花子").map((c) => c.id), ["U0BHX9HKE2U"]);
});

test("空白の有無で外さない", () => {
  // 「山田太郎」と打っても「山田 太郎」に当てる。全角空白も同じ。
  assert.deepEqual(filterMentionCandidates(CANDIDATES, "山田太郎").map((c) => c.id), ["U0AGW8GJD1T"]);
  assert.deepEqual(filterMentionCandidates(CANDIDATES, "山田　太郎").map((c) => c.id), ["U0AGW8GJD1T"]);
});

test("英字は大文字小文字を無視する", () => {
  assert.deepEqual(filterMentionCandidates(CANDIDATES, "tanaka").map((c) => c.id), ["U0DKZ2KMG4W"]);
});

test("Slack ID でも引ける（同姓が並ぶときの決め手）", () => {
  assert.deepEqual(filterMentionCandidates(CANDIDATES, "U0CJY1JLF3V").map((c) => c.id), ["U0CJY1JLF3V"]);
});

test("該当なしは空配列（元の配列を壊さない）", () => {
  assert.deepEqual(filterMentionCandidates(CANDIDATES, "佐藤"), []);
  assert.equal(CANDIDATES.length, 4);
});

// ── 定型文の本文 ─────────────────────────────────────────────────────
test("クラウドサイン送信済は宛先を「→」で結び相手方で終える", () => {
  assert.equal(
    composeTemplateText(1, { to: ["@山田 太郎", "@鈴木 一郎"] }),
    "クラウドサインで送信しました。 @山田 太郎 → @鈴木 一郎 → 相手方");
});

test("CC は末尾に付ける", () => {
  assert.match(composeTemplateText(1, { to: ["@山田 太郎"], cc: ["@鈴木 一郎"] }),
    /CC: @鈴木 一郎$/);
});

test("CC が無ければ CC の行を出さない", () => {
  assert.doesNotMatch(composeTemplateText(1, { to: ["@山田 太郎"], cc: [] }), /CC:/);
});

test("文書作成完了・評価完了は閲覧リンクを別行に置く", () => {
  const done = composeTemplateText(2, { to: ["@山田 太郎"], driveLink: "https://drive/x" });
  assert.equal(done, "文書作成が完了しました。 @山田 太郎\n閲覧リンク: https://drive/x");
  assert.match(composeTemplateText(3, { to: ["@山田 太郎"] }), /^評価が完了しました。/);
});

test("閲覧リンクが無ければリンク行を出さない", () => {
  assert.equal(composeTemplateText(2, { to: ["@山田 太郎"], driveLink: null }),
    "文書作成が完了しました。 @山田 太郎");
  assert.equal(composeTemplateText(2, { to: ["@山田 太郎"], driveLink: "  " }),
    "文書作成が完了しました。 @山田 太郎");
});

test("リンクを載せるのは 2 と 3 だけ", () => {
  assert.equal(templateUsesDocument(1), false);
  assert.equal(templateUsesDocument(2), true);
  assert.equal(templateUsesDocument(3), true);
});

test("定型文は3種類（画面のボタンと投稿先の対応）", () => {
  assert.deepEqual(MATTER_SLACK_TEMPLATES.map((t) => t.id), [1, 2, 3]);
});

// ── プレビューと実投稿が同じ組み立てを通ること ─────────────────────────
// 別実装だと、片方だけ直したときに「プレビューでは CC が見えるのに実際は付かない」
// のような食い違いが静かに起きる。
test("サーバの本文はプレビューと同じ形（ID か 氏名 かだけが違う）", () => {
  const posted = buildTemplateMessage(1, { toIds: ["U0AGW8GJD1T"], ccIds: ["U0BHX9HKE2U"] });
  const preview = composeTemplateText(1, { to: ["@山田 太郎"], cc: ["@山下 花子"] });
  assert.equal(posted,
    "クラウドサインで送信しました。 <@U0AGW8GJD1T> → 相手方  CC: <@U0BHX9HKE2U>");
  assert.equal(
    posted.replace("<@U0AGW8GJD1T>", "@山田 太郎").replace("<@U0BHX9HKE2U>", "@山下 花子"),
    preview);
});

test("サーバ側はSlack IDでない宛先を落とす（プレビューには出ていても投稿しない）", () => {
  assert.equal(buildTemplateMessage(2, { toIds: ["not-an-id"], driveLink: "https://drive/x" }),
    "文書作成が完了しました。\n閲覧リンク: https://drive/x");
});
