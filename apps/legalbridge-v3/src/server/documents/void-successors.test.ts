import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { voidSuccessors } from "./void-successors.js";

test("無効にした条件の新しい方：同じ作品 × 相手先 × 向き × 種類 × 利用形態 × パート の生きている条件（いちばん新しい id）", async () => {
  const db = new FakeDatabase((text, params) => {
    if (text.includes("c.status = 'void'")) {
      assert.deepEqual(params, [[11, 12]]);
      return [{ id: 11, successor_id: 31 }];
    }
    return undefined;
  });
  const map = await voidSuccessors(db, [11, 12, 11]);
  assert.deepEqual([...map.entries()], [[11, 31]], "12 は無効でないか新しい方が無い");
  assert.equal((await voidSuccessors(db, [])).size, 0, "空なら問い合わせない");
});
