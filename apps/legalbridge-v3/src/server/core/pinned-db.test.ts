import test from "node:test";
import assert from "node:assert/strict";
import { PinnedDatabase } from "./pinned-db.js";
import { inTransaction } from "./db.js";

test("1 本の接続に乗せる：サービスの BEGIN／COMMIT／ROLLBACK は SAVEPOINT に読み替える", async () => {
  const sent: string[] = [];
  const pinned = new PinnedDatabase({ query: async (t: string) => { sent.push(t); return { rows: [], rowCount: 0 }; } });
  await inTransaction(pinned, async (c) => { await c.query("UPDATE x SET y = 1"); });
  await assert.rejects(inTransaction(pinned, async () => { throw new Error("断る"); }), /断る/);
  assert.deepEqual(sent, ["SAVEPOINT pinned_1", "UPDATE x SET y = 1", "RELEASE SAVEPOINT pinned_1",
                          "SAVEPOINT pinned_2", "ROLLBACK TO SAVEPOINT pinned_2"]);
});
