import test from "node:test";
import assert from "node:assert/strict";
import { uploadPageHtml } from "./upload-page.js";

// ページのスクリプトはテンプレート文字列の中に書いてあるので、\ の書き方を誤ると
// ブラウザで構文エラーになり、ファイルを選ぶことも上げることもできなくなる（2026-09-27 に実際そうなった）。
test("アップロードのページのスクリプトは構文として正しい", () => {
  const html = uploadPageHtml({ token: "r.1.2.x", label: "REQ-2026-00001", title: "NDA <確認>" });
  const js = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  assert.doesNotThrow(() => new Function(js));
  assert.match(js, /\/file"\+q/, "送り先は同じパスの /file");
});

test("ファイルを選ぶ欄はブラウザ標準の部品（スクリプトが止まっても開ける）。見出しはエスケープする", () => {
  const html = uploadPageHtml({ token: "t", label: "REQ-1", title: "NDA <確認>" });
  assert.match(html, /<label id="drop" for="file"/);
  assert.match(html, /NDA &lt;確認&gt;/);
});
