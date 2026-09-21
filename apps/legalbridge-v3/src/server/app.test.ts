import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientStamp } from "./app.js";

/**
 * 「入れ替えたのに画面が古い」を切り分けるための印。コンテナが配っている
 * 資材の名前が出る。ブラウザが読んだ名前と違えばブラウザ側の持ち越し。
 */
test("配っている画面の版は index.html の資材名から出る", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-client-"));
  fs.writeFileSync(path.join(dir, "index.html"),
    '<!doctype html><script type="module" src="/assets/index-DIJdFkdu.js"></script>');
  const stamp = clientStamp(dir);
  assert.equal(stamp.asset, "index-DIJdFkdu.js");
  assert.match(String(stamp.builtAt), /^\d{4}-\d{2}-\d{2}T/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("画面が置かれていなければ空で返す（/health は落とさない）", () => {
  assert.deepEqual(clientStamp(path.join(os.tmpdir(), "lb-client-missing")),
    { asset: null, builtAt: null });
});
