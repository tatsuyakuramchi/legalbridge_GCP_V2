import test from "node:test";
import assert from "node:assert/strict";
import { driveFileIdFromLink, driveViewLink } from "./drive-storage.js";

// documents.storage_url は webViewLink をそのまま持つ。形式が数種類あるため
// ID の取り出しを固定しておく（再保存で既存ファイルを見つけるのに使う）。
test("閲覧リンクからファイルIDを取り出す", () => {
  assert.equal(driveFileIdFromLink("https://drive.google.com/file/d/1AbcDefGhiJkl/view?usp=drivesdk"), "1AbcDefGhiJkl");
  assert.equal(driveFileIdFromLink("https://docs.google.com/document/d/1AbcDefGhiJkl/edit"), "1AbcDefGhiJkl");
  assert.equal(driveFileIdFromLink("https://drive.google.com/open?id=1AbcDefGhiJkl"), "1AbcDefGhiJkl");
  assert.equal(driveFileIdFromLink("1AbcDefGhiJkl"), "1AbcDefGhiJkl", "IDが直接入っている場合");
  assert.equal(driveFileIdFromLink(""), null);
  assert.equal(driveFileIdFromLink(null), null);
  assert.equal(driveFileIdFromLink("short"), null);
});

test("共有ドライブで webViewLink が空でも閲覧リンクを組み立てる", () => {
  assert.equal(driveViewLink("abc123def456"), "https://drive.google.com/file/d/abc123def456/view");
  assert.equal(driveViewLink("abc123def456", "  "), "https://drive.google.com/file/d/abc123def456/view");
  assert.equal(driveViewLink("abc", "https://example.test/x"), "https://example.test/x");
});
