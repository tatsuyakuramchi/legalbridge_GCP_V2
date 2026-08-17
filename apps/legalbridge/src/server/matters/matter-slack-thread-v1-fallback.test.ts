import assert from "node:assert/strict";
import test from "node:test";
import { PgMatterSlackThreadRepository } from "./matter-slack-thread-repository.js";
import type { DatabasePool } from "../db/pool.js";

// V1（matter_slack_threads）で立てたスレッドを V2 が引き継げること。
// 引き継げないと、同じ案件に2本目の root を立てて「1案件=1スレッド」が崩れる。

type Row = Record<string, unknown>;

function poolWith(tables: { v2?: Row[]; v1?: Row[]; v1Error?: { code: string } }) {
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      const matterId = Number(params?.[0]);
      if (sql.includes("lb_v2_matter_slack_threads")) {
        if (sql.trim().startsWith("INSERT")) {
          (tables.v2 ??= []).push({
            matter_id: matterId, channel_id: params?.[1], thread_ts: params?.[2],
            root_text: params?.[3], created_by: params?.[4],
            created_at: "2026-08-17T00:00:00.000Z"
          });
          return { rows: [] };
        }
        return { rows: (tables.v2 ?? []).filter((row) => Number(row.matter_id) === matterId) };
      }
      if (sql.includes("matter_slack_threads")) {
        if (tables.v1Error) throw Object.assign(new Error("denied"), tables.v1Error);
        return { rows: (tables.v1 ?? []).filter((row) => Number(row.matter_id) === matterId) };
      }
      return { rows: [] };
    }
  } as unknown as DatabasePool;
  return { pool, queries };
}

const v1Row = {
  matter_id: 7, channel_id: "C0LEGAL0001", thread_ts: "1780000000.000100",
  root_text: "V1で立てたスレッド", created_by: "v1@example.com",
  created_at: "2026-07-01T00:00:00.000Z"
};

test("V2 に無ければ V1 のスレッドをアンカーとして返す", async () => {
  const { pool } = poolWith({ v1: [v1Row] });
  const found = await new PgMatterSlackThreadRepository(pool).findByMatter(7);
  assert.equal(found?.source, "v1");
  assert.equal(found?.channelId, "C0LEGAL0001");
  assert.equal(found?.threadTs, "1780000000.000100");
});

test("V2 にあれば V1 は見ない（V2 が正）", async () => {
  const { pool, queries } = poolWith({
    v2: [{ ...v1Row, channel_id: "C0V2", thread_ts: "1790000000.000200" }],
    v1: [v1Row]
  });
  const found = await new PgMatterSlackThreadRepository(pool).findByMatter(7);
  assert.equal(found?.source, "v2");
  assert.equal(found?.channelId, "C0V2");
  assert.equal(queries.filter((q) => !q.includes("lb_v2_")).length, 0, "V1 テーブルへ問い合わせない");
});

test("どちらにも無ければ未作成（作成ボタンを出す）", async () => {
  const { pool } = poolWith({});
  assert.equal(await new PgMatterSlackThreadRepository(pool).findByMatter(7), null);
});

test("V1 の root_text / created_by が NULL でも空文字で返す", async () => {
  const { pool } = poolWith({ v1: [{ ...v1Row, root_text: null, created_by: null }] });
  const found = await new PgMatterSlackThreadRepository(pool).findByMatter(7);
  assert.equal(found?.rootText, "");
  assert.equal(found?.createdBy, "");
});

test("V1 にスレッドがある案件では create しても2本目を作らない", async () => {
  const tables = { v1: [v1Row], v2: [] as Row[] };
  const { pool } = poolWith(tables);
  const created = await new PgMatterSlackThreadRepository(pool).create({
    matterId: 7, channelId: "C0NEW", threadTs: "1799999999.000999",
    rootText: "V2が立てようとしたroot", createdBy: "v2@example.com"
  });
  assert.equal(created.source, "v1");
  assert.equal(created.threadTs, "1780000000.000100");
  assert.equal(tables.v2.length, 0, "lb_v2 側へ行を作らない");
});

test("V1 が無い案件は従来どおり V2 へ保存する", async () => {
  const tables = { v1: [] as Row[], v2: [] as Row[] };
  const { pool } = poolWith(tables);
  const created = await new PgMatterSlackThreadRepository(pool).create({
    matterId: 8, channelId: "C0LEGAL0001", threadTs: "1790000000.000300",
    rootText: "V2のroot", createdBy: "v2@example.com"
  });
  assert.equal(created.source, "v2");
  assert.equal(tables.v2.length, 1);
});

test("V1 が権限不足・未作成なら null に縮退し、案件スレッド機能は止めない", async () => {
  for (const code of ["42501", "42P01"]) {
    const { pool } = poolWith({ v1Error: { code } });
    const repo = new PgMatterSlackThreadRepository(pool);
    assert.equal(await repo.findByMatter(7), null);
  }
});

test("V1 の再試行は1度だけ（毎回エラーログを出さない）", async () => {
  const { pool, queries } = poolWith({ v1Error: { code: "42501" } });
  const repo = new PgMatterSlackThreadRepository(pool);
  await repo.findByMatter(7);
  await repo.findByMatter(8);
  assert.equal(queries.filter((q) => !q.includes("lb_v2_")).length, 1);
});

test("DB 障害は握り潰さない（未作成に見せない）", async () => {
  const { pool } = poolWith({ v1Error: { code: "57P01" } });
  await assert.rejects(() => new PgMatterSlackThreadRepository(pool).findByMatter(7), /denied/);
});
