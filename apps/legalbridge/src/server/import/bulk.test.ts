import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { bulkImport, csvBool, csvOptionalId } from "./bulk.js";

const schema = z.object({ name: z.string().min(1), n: z.coerce.number().int().positive() });

test("bulkImport は有効行を登録し無効行を独立に報告する", async () => {
  const created: unknown[] = [];
  const report = await bulkImport(
    [{ name: "A", n: "1" }, { name: "", n: "2" }, { name: "B", n: "3" }],
    schema,
    async (input) => { created.push(input); return { id: created.length }; }
  );
  assert.equal(report.insertedCount, 2);
  assert.equal(report.failedCount, 1);
  assert.equal(report.failed[0].index, 1);
  assert.deepEqual(report.inserted.map((r) => r.index), [0, 2]);
});

test("bulkImport は create の例外を行失敗として扱う", async () => {
  const report = await bulkImport(
    [{ name: "A", n: "1" }, { name: "B", n: "2" }],
    schema,
    async (input) => { if (input.name === "B") throw new Error("重複"); return { id: 1 }; }
  );
  assert.equal(report.insertedCount, 1);
  assert.equal(report.failedCount, 1);
  assert.equal(report.failed[0].error, "重複");
});

test("csvBool は各種表記を真偽へ寄せる", () => {
  for (const t of ["true", "1", "はい", "対象", "○"]) assert.equal(csvBool.parse(t), true);
  for (const f of ["false", "0", "いいえ", "対象外", ""]) assert.equal(csvBool.parse(f), false);
});

test("csvOptionalId は空をundefined、数値を正整数へ", () => {
  assert.equal(csvOptionalId.parse(""), undefined);
  assert.equal(csvOptionalId.parse("42"), 42);
  assert.throws(() => csvOptionalId.parse("0"));
});
