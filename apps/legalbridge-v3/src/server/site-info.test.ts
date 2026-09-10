import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { siteInfo } from "./app.js";

test("印のファイルが無ければ時点は null、あれば中身をそのまま返す", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-stamp-"));
  const stamp = path.join(dir, "STAMP");
  const before = { label: config.siteLabel, path: config.dataStampPath };
  try {
    config.siteLabel = "予備系";
    config.dataStampPath = stamp;
    assert.deepEqual(siteInfo(), { label: "予備系", dataAsOf: null });
    fs.writeFileSync(stamp, "2026-09-09 02:00\n");
    assert.deepEqual(siteInfo(), { label: "予備系", dataAsOf: "2026-09-09 02:00" });
  } finally {
    config.siteLabel = before.label;
    config.dataStampPath = before.path;
  }
});
