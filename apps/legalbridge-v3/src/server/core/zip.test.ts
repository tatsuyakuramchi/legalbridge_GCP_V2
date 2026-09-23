import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip, safeFileName } from "./zip.js";

test("ZIP は unzip で開けて、日本語名と中身がそのまま戻る", () => {
  const zip = buildZip([
    { name: "合同会社アトリエ蒼/ARC-PO-2026-0080.pdf", data: Buffer.from("%PDF-1.4 dummy") },
    { name: "読めなかった文書.txt", data: Buffer.from("ARC-IN-2026-0001：Drive から読めない\n", "utf8") }
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  writeFileSync(join(dir, "a.zip"), zip);
  let listed: string;
  try {
    listed = execFileSync("unzip", ["-o", "-q", "a.zip", "-d", "out"], { cwd: dir }).toString();
    listed = execFileSync("find", ["out", "-type", "f"], { cwd: dir }).toString();
  } catch {
    return; // unzip が無い環境では構造の検査だけ
  }
  assert.match(listed, /ARC-PO-2026-0080\.pdf/);
  assert.equal(readFileSync(join(dir, "out", "合同会社アトリエ蒼", "ARC-PO-2026-0080.pdf")).toString(), "%PDF-1.4 dummy");
  assert.match(readFileSync(join(dir, "out", "読めなかった文書.txt"), "utf8"), /Drive から読めない/);
});

test("空でも壊れた ZIP にはならない", () => {
  const zip = buildZip([]);
  assert.equal(zip.length, 22);
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
});

test("ファイル名の禁則文字は落とす", () => {
  assert.equal(safeFileName('株式会社A/B:C*?"<>|'), "株式会社A_B_C______");
  assert.equal(safeFileName("   "), "無題");
});
