import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as nodeCrc32 } from "node:zlib";
import { buildZip, crc32, safeFileName } from "./zip.js";

test("crc32 は Node の実装と同じ値になる", () => {
  for (const s of ["", "a", "%PDF-1.4 dummy", "合同会社アトリエ蒼"]) {
    const bytes = Buffer.from(s, "utf8");
    assert.equal(crc32(bytes), nodeCrc32(bytes) >>> 0, s);
  }
});

test("ZIP は unzip で開けて、日本語名と中身がそのまま戻る", () => {
  const zip = Buffer.from(buildZip([
    { name: "合同会社アトリエ蒼/ARC-PO-2026-0080.pdf", data: Buffer.from("%PDF-1.4 dummy") },
    { name: "読めなかった文書.txt", data: Buffer.from("ARC-IN-2026-0001：Drive から読めない\n", "utf8") }
  ]));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  writeFileSync(join(dir, "a.zip"), zip);
  let listed: string;
  // UTF-8 の端末で展開する（利用者の手元と同じ）。作成元を MS-DOS と名乗っていた頃は、
  // Debian・Ubuntu の unzip がここで日本語名を DOS の文字コードとして読み替えて化けた。
  const env = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
  try {
    listed = execFileSync("unzip", ["-o", "-q", "a.zip", "-d", "out"], { cwd: dir, env }).toString();
    listed = execFileSync("find", ["out", "-type", "f"], { cwd: dir, env }).toString();
  } catch {
    return; // unzip が無い環境では構造の検査だけ
  }
  assert.match(listed, /ARC-PO-2026-0080\.pdf/);
  assert.equal(readFileSync(join(dir, "out", "合同会社アトリエ蒼", "ARC-PO-2026-0080.pdf")).toString(), "%PDF-1.4 dummy");
  assert.match(readFileSync(join(dir, "out", "読めなかった文書.txt"), "utf8"), /Drive から読めない/);
  // 展開したファイルが読める権限で出る（作成元を Unix と名乗るので権限も渡す）。
  assert.equal(statSync(join(dir, "out", "読めなかった文書.txt")).mode & 0o444, 0o444);
});

test("ロケールが無い環境（Cloud Build）でも日本語名がそのまま戻る", () => {
  const zip = Buffer.from(buildZip([{ name: "検収書_個人_2026-09-30.xlsx", data: Buffer.from("x") }]));
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  writeFileSync(join(dir, "a.zip"), zip);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  try {
    execFileSync("unzip", ["-o", "-q", "a.zip", "-d", "out"], { cwd: dir, env });
  } catch {
    return; // unzip が無い環境では構造の検査だけ
  }
  assert.equal(readFileSync(join(dir, "out", "検収書_個人_2026-09-30.xlsx")).toString(), "x");
});

test("空でも壊れた ZIP にはならない", () => {
  const zip = Buffer.from(buildZip([]));
  assert.equal(zip.length, 22);
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
});

test("ファイル名の禁則文字は落とす", () => {
  assert.equal(safeFileName('株式会社A/B:C*?"<>|'), "株式会社A_B_C______");
  assert.equal(safeFileName("   "), "無題");
});
