import { test } from "node:test";
import assert from "node:assert/strict";
import { digitalBasisCheck, isDigitalBasis } from "./digital-basis.js";

test("電子の算定の基礎：未選択は保存させない", () => {
  assert.ok(digitalBasisCheck(null, "42.5").error);
  assert.ok(digitalBasisCheck("supply", "10").error);
  assert.equal(isDigitalBasis("receipts"), true);
});

test("電子の算定の基礎：基礎に対して珍しい料率は確かめる", () => {
  // 受領額 × 42.5% のつもりで配信価格を選んだ（9002 の取り違え）
  assert.ok(digitalBasisCheck("list", "42.5").confirm);
  assert.ok(digitalBasisCheck("list", "42.5%").confirm);
  assert.deepEqual(digitalBasisCheck("receipts", "42.5"), {});
  assert.deepEqual(digitalBasisCheck("list", "15"), {});
  assert.ok(digitalBasisCheck("receipts", "10").confirm);
  // 料率が空なら基礎だけ見る
  assert.deepEqual(digitalBasisCheck("list", ""), {});
});
