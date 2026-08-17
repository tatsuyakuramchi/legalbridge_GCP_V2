import assert from "node:assert/strict";
import test from "node:test";

// 別タブで開くリンク（作成フォーム横の「定型文」など）が届く画面の一覧。
// App.tsx の deepLinkable と同じ内容を保つ。任意の view を通すと、未実装や
// 権限外の画面へ ?view= で飛べてしまうため列挙で絞る。
const DEEP_LINKABLE = ["home", "documents", "drafts", "snippets", "template-samples", "guide"];

function resolve(search: string): string | null {
  const requested = new URLSearchParams(search).get("view");
  return requested && DEEP_LINKABLE.includes(requested) ? requested : null;
}

test("定型文は別タブのリンクから開ける", () => {
  assert.equal(resolve("?view=snippets"), "snippets");
});

test("従来のリンク（下書き・文書・ホーム）は引き続き開ける", () => {
  assert.equal(resolve("?view=drafts"), "drafts");
  assert.equal(resolve("?view=documents"), "documents");
  assert.equal(resolve("?view=home"), "home");
});

test("ひな形・運用ガイドも開ける", () => {
  assert.equal(resolve("?view=template-samples"), "template-samples");
  assert.equal(resolve("?view=guide"), "guide");
});

test("列挙外の view は無視する（設定画面等へ飛ばさない）", () => {
  for (const view of ["settings", "admin", "staff", "vendor-merge", "matter-delete", ""]) {
    assert.equal(resolve(`?view=${view}`), null, `${view} は通さない`);
  }
});

test("view 指定が無ければ現在の画面を変えない", () => {
  assert.equal(resolve(""), null);
  assert.equal(resolve("?issue=LEGAL-1"), null);
});
