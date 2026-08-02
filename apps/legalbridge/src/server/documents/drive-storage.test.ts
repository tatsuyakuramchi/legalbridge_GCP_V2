import assert from "node:assert/strict";
import test from "node:test";
import { driveViewLink, GoogleDriveStorage } from "./drive-storage.js";

test("webViewLinkがあればそのまま使う", () => {
  assert.equal(
    driveViewLink("abc", "https://drive.google.com/open?id=abc"),
    "https://drive.google.com/open?id=abc"
  );
});

test("webViewLinkが空ならfile idから閲覧リンクを合成する", () => {
  assert.equal(
    driveViewLink("abc", ""),
    "https://drive.google.com/file/d/abc/view"
  );
  assert.equal(
    driveViewLink("abc", undefined),
    "https://drive.google.com/file/d/abc/view"
  );
});

test("idもリンクも無ければ空文字を返す", () => {
  assert.equal(driveViewLink(undefined, ""), "");
});

test("フォルダID未指定のGoogleDriveStorageは初期化を拒否する", () => {
  assert.throws(() => new GoogleDriveStorage(""));
});
