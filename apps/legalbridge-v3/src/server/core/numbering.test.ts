import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "./fake-db.js";
import { allocateNumber, currentYearInTokyo, formatNumber, type NumberSpec } from "./numbering.js";

const MATTER: NumberSpec = { prefix: "MTR", table: "matters", column: "matter_no" };

/** 採番表と既存番号を持つ偽DB。V1 が使っている番号を `taken` で渡す。 */
const build = (opts: { seeded?: number; taken?: string[] } = {}) => {
  let current = opts.seeded ?? 0;
  const seeded = opts.seeded !== undefined;
  const taken = new Set(opts.taken ?? []);
  const db = new FakeDatabase((text, params) => {
    if (text.includes("SELECT 1 FROM document_sequences")) return seeded ? [{ x: 1 }] : [];
    if (text.includes("COALESCE(MAX(")) return [{ m: 0 }];
    if (text.includes("INSERT INTO document_sequences")) return [];
    if (text.includes("UPDATE document_sequences")) { current += 1; return [{ current_value: current }]; }
    if (text.includes("FROM matters WHERE matter_no")) {
      return taken.has(String(params[0])) ? [{ x: 1 }] : [];
    }
    return undefined;
  });
  return db;
};

test("東京の年で切る", () => {
  // 1月1日 08:00 JST は UTC ではまだ前年の12月31日。
  assert.equal(currentYearInTokyo(new Date("2026-12-31T23:00:00Z")), 2027);
  assert.equal(currentYearInTokyo(new Date("2026-01-01T00:00:00Z")), 2026);
});

test("既存データと同じ形に整える", () => {
  assert.equal(formatNumber("MTR", 2026, 213), "MTR-2026-00213");
  assert.equal(formatNumber("CL", 2026, 7), "CL-2026-00007");
});

test("空いている番号を返す", async () => {
  const db = build({ seeded: 212 });
  assert.equal(await allocateNumber(db, MATTER, new Date("2026-09-08T00:00:00Z")), "MTR-2026-00213");
});

test("V1 が先に使っていたら次へ進む", async () => {
  // 並行稼働中はこれが起きる。落ちずに空き番号まで飛ばす。
  const db = build({ seeded: 212, taken: ["MTR-2026-00213", "MTR-2026-00214"] });
  assert.equal(await allocateNumber(db, MATTER, new Date("2026-09-08T00:00:00Z")), "MTR-2026-00215");
});

test("未採番なら移行データの最大値から始める", async () => {
  const db = new FakeDatabase((text) => {
    if (text.includes("SELECT 1 FROM document_sequences")) return [];       // 採番表がまだ無い
    if (text.includes("COALESCE(MAX(")) return [{ m: 240 }];                // 移行済みの最大
    if (text.includes("UPDATE document_sequences")) return [{ current_value: 241 }];
    return [];
  });
  assert.equal(await allocateNumber(db, MATTER, new Date("2026-09-08T00:00:00Z")), "MTR-2026-00241");
  const seed = db.find("INSERT INTO document_sequences")!;
  assert.equal(seed.params[2], 240, "1 からではなく既存の続きから始める");
});

test("空きが見つからなければ黙って壊さず止まる", async () => {
  let current = 0;
  const db = new FakeDatabase((text) => {
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) { current += 1; return [{ current_value: current }]; }
    if (text.includes("FROM matters WHERE matter_no")) return [{ x: 1 }];   // 全部埋まっている
    return [];
  });
  await assert.rejects(
    () => allocateNumber(db, MATTER, new Date("2026-09-08T00:00:00Z"), 5),
    /5 回試しても確保できません/);
});
