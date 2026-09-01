import assert from "node:assert/strict";
import test from "node:test";
import { PgWorkReadRepository } from "./read-repository.js";
import type { DatabasePool } from "../db/pool.js";

// 作品詳細500（本番実障害）の回帰テスト。
// コアクエリは works と vendors を JOIN するため、両テーブルにある列
// （is_active 等）を修飾せずに書くと曖昧参照（42702）で毎回落ちる。
// 以前は `w.${SUMMARY_COLUMNS}` で先頭の1列にしか w. が付いていなかった。
// メモリリポジトリでは SQL を実行しないため、発行される SQL 文字列を検査する。

function capturePool(rowsForFirst: Array<Record<string, unknown>>): { pool: DatabasePool; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      // 1本目（コア）は1行返し、後続の集約クエリは空で良い。
      return { rows: queries.length === 1 ? rowsForFirst : [] } as { rows: Array<Record<string, unknown>> };
    }
  } as unknown as DatabasePool;
  return { pool, queries };
}

test("作品詳細のコアクエリは JOIN 下で全列を w. 修飾する（is_active の曖昧参照防止）", async () => {
  const { pool, queries } = capturePool([{ id: 1, title: "作品A" }]);
  const repository = new PgWorkReadRepository(pool);
  const detail = await repository.detail(1);
  assert.ok(detail);
  const core = queries[0];
  assert.match(core, /LEFT JOIN vendors/);
  // SELECT 句に修飾なしの is_active / status / title などが残っていないこと。
  const selectClause = core.slice(0, core.indexOf("FROM"));
  for (const column of ["is_active", "work_code", "title_kana", "status", "parent_work_id"]) {
    assert.match(selectClause, new RegExp(`w\\.${column}`), `${column} が w. 修飾されていること`);
    assert.doesNotMatch(selectClause, new RegExp(`[^.\\w]${column}`), `${column} の未修飾参照が無いこと`);
  }
});
