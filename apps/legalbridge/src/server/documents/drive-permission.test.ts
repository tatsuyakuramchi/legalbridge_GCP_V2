import assert from "node:assert/strict";
import test from "node:test";
import { extractDriveFileId, MemoryDrivePermissionGranter } from "./drive-permission.js";

test("extractDriveFileId は /file/d/{id}/view 形式を抽出", () => {
  assert.equal(extractDriveFileId("https://drive.google.com/file/d/1Abc_def-GHI23456789/view"), "1Abc_def-GHI23456789");
});
test("extractDriveFileId は ?id= 形式を抽出", () => {
  assert.equal(extractDriveFileId("https://drive.google.com/open?id=1Abc_def-GHI23456789"), "1Abc_def-GHI23456789");
});
test("extractDriveFileId は非リンクで null", () => {
  assert.equal(extractDriveFileId(""), null);
  assert.equal(extractDriveFileId("not a link"), null);
});
test("MemoryDrivePermissionGranter は付与を記録し、指定メールは失敗させる", async () => {
  const g = new MemoryDrivePermissionGranter(new Set(["bad@example.com"]));
  await g.grantView("file1", "ok@example.com");
  assert.deepEqual(g.grants, [{ fileId: "file1", email: "ok@example.com" }]);
  await assert.rejects(() => g.grantView("file1", "bad@example.com"));
});
