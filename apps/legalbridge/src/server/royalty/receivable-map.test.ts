import assert from "node:assert/strict";
import test from "node:test";
import { buildLineageCascade } from "./receivable-map.js";

test("単段：分配 = 料率 × 受領、留保 = 受領 − 分配", () => {
  const r = buildLineageCascade([
    { workId: 1, received: 10000, upstream: [{ capabilityId: 1, ratePct: 20 }] }
  ]);
  assert.equal(r.chain[0].cascadeBase, 10000);
  assert.equal(r.chain[0].distributed, 2000); // round(10000×20%)
  assert.equal(r.chain[0].retained, 8000);
  assert.deepEqual(r.totals, { received: 10000, distributed: 2000, retained: 8000 });
});

test("多段：cascade_base は当該段〜最下段の受領合計", () => {
  const r = buildLineageCascade([
    { workId: 1, received: 5000, upstream: [{ capabilityId: 1, ratePct: 10 }] }, // root
    { workId: 2, received: 3000, upstream: [{ capabilityId: 2, ratePct: 20 }] }  // selected
  ]);
  assert.equal(r.chain[0].cascadeBase, 8000);  // 5000+3000
  assert.equal(r.chain[0].distributed, 800);   // round(8000×10%)
  assert.equal(r.chain[1].cascadeBase, 3000);
  assert.equal(r.chain[1].distributed, 600);   // round(3000×20%)
  assert.equal(r.totals.received, 8000);
  assert.equal(r.totals.distributed, 1400);
  assert.equal(r.totals.retained, 6600);
});

test("同一capabilityは複数段で二重計上しない（inherited=0）", () => {
  const r = buildLineageCascade([
    { workId: 1, received: 5000, upstream: [{ capabilityId: 7, ratePct: 10 }] },
    { workId: 2, received: 3000, upstream: [{ capabilityId: 7, ratePct: 10 }] } // 同一cap
  ]);
  assert.equal(r.chain[0].upstream[0].inherited, false);
  assert.equal(r.chain[0].distributed, 800);          // round(8000×10%)
  assert.equal(r.chain[1].upstream[0].inherited, true);
  assert.equal(r.chain[1].upstream[0].distributeAmount, 0);
  assert.equal(r.chain[1].distributed, 0);
  assert.equal(r.chain[1].retained, 3000);
});

test("料率不明は分配 null（distributed には0で寄与）", () => {
  const r = buildLineageCascade([
    { workId: 1, received: 4000, upstream: [{ capabilityId: 1, ratePct: null }] }
  ]);
  assert.equal(r.chain[0].upstream[0].distributeAmount, null);
  assert.equal(r.chain[0].distributed, 0);
  assert.equal(r.chain[0].retained, 4000);
});

test("上流なしの段は分配0・留保=受領", () => {
  const r = buildLineageCascade([{ workId: 1, received: 6000, upstream: [] }]);
  assert.equal(r.chain[0].distributed, 0);
  assert.equal(r.chain[0].retained, 6000);
});
