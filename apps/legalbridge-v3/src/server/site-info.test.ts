import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { siteInfo } from "./app.js";

test("印のファイルが無ければ時点は null、あれば中身をそのまま返す。切り替えを使っていなければ DB は null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-stamp-"));
  const stamp = path.join(dir, "STAMP");
  const before = { label: config.siteLabel, path: config.dataStampPath };
  // 切り替えを使っていない（DB_TARGET も DB_TARGET_PATH も無い）前提。
  const db = { target: null, reachable: null, primaryReachable: null };
  try {
    config.siteLabel = "予備系";
    config.dataStampPath = stamp;
    assert.deepEqual(await siteInfo(null), { label: "予備系", dataAsOf: null, db });
    fs.writeFileSync(stamp, "2026-09-09 02:00\n");
    assert.deepEqual(await siteInfo(null), { label: "予備系", dataAsOf: "2026-09-09 02:00", db });
  } finally {
    config.siteLabel = before.label;
    config.dataStampPath = before.path;
  }
});
