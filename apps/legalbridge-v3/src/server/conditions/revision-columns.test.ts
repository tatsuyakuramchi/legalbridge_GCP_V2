import test from "node:test";
import assert from "node:assert/strict";
import { COPY_COLUMNS, ECONOMICS_COLUMNS } from "./write-service.js";

test("改訂（-R2 …）で写す列：編集できる列はすべて入っている（入っていないと、改訂になった編集で値が落ちる）", () => {
  const missing = Object.values(ECONOMICS_COLUMNS).filter((column) => !COPY_COLUMNS.includes(column));
  assert.deepEqual(missing, []);
});

test("改訂で写す列：算定の基礎・分配のしかた・再許諾の種類を引き継ぐ。状態と完了の記録は引き継がない", () => {
  for (const column of ["price_basis", "distribution", "sublicense_kind", "sublicense_consent", "usage_type", "auto_renew"]) {
    assert.ok(COPY_COLUMNS.includes(column), column);
  }
  for (const column of ["id", "status", "superseded_by_id", "closed_at", "closed_kind", "created_at"]) {
    assert.ok(!COPY_COLUMNS.includes(column), column);
  }
  assert.equal(new Set(COPY_COLUMNS).size, COPY_COLUMNS.length, "同じ列を 2 回写さない");
});
