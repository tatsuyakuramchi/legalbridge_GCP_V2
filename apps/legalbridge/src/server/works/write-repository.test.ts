import assert from "node:assert/strict";
import test from "node:test";
import { PgWorkWriteRepository } from "./write-repository.js";
import type { DatabasePool } from "../db/pool.js";

// 作品の新規登録が「作品コードが既に存在します」で塞がった実障害の回帰テスト。
//   - id 連番が既存データより後ろ（V1移行の明示id INSERT等）→ works_pkey の 23505。
//     連番を MAX(id) に合わせて1回だけ自動再試行する（自己修復）。
//   - 自動採番の仮コードは毎回ユニーク（固定 'PENDING' は同時作成・残骸と衝突する）。

type Call = { sql: string; params?: unknown[] };

function poolWith(behavior: (sql: string, calls: Call[]) => { rows: Array<Record<string, unknown>> }) {
  const calls: Call[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return behavior(sql, calls);
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined })
  } as unknown as DatabasePool;
  return { pool, calls };
}

test("id連番の衝突（works_pkey 23505）は連番修復して1回だけ再試行する", async () => {
  let insertAttempts = 0;
  const { pool, calls } = poolWith((sql) => {
    if (sql.startsWith("INSERT INTO works")) {
      insertAttempts += 1;
      if (insertAttempts === 1) {
        const error = new Error("duplicate key") as Error & { code: string; constraint: string };
        error.code = "23505"; error.constraint = "works_pkey";
        throw error;
      }
      return { rows: [{ id: 10001, work_code: "PENDING-x" }] };
    }
    if (sql.includes("UPDATE works SET work_code")) return { rows: [{ work_code: "WRK-10001" }] };
    return { rows: [] };
  });
  const repository = new PgWorkWriteRepository(pool);
  const saved = await repository.create({ title: "新作" } as Parameters<typeof repository.create>[0]);
  assert.equal(saved.workCode, "WRK-10001");
  assert.equal(insertAttempts, 2);
  assert.ok(calls.some((c) => c.sql.includes("setval(pg_get_serial_sequence('works','id')")));
});

test("work_code の重複はそのまま利用者向けエラー（再試行しない）", async () => {
  const { pool } = poolWith((sql) => {
    if (sql.startsWith("INSERT INTO works")) {
      const error = new Error("duplicate key") as Error & { code: string; constraint: string };
      error.code = "23505"; error.constraint = "works_work_code_key";
      throw error;
    }
    return { rows: [] };
  });
  const repository = new PgWorkWriteRepository(pool);
  await assert.rejects(
    () => repository.create({ title: "新作", workCode: "WRK-00001" } as Parameters<typeof repository.create>[0]),
    /作品コードが既に存在します/);
});

test("自動採番の仮コードは毎回ユニーク（固定 PENDING を使わない）", async () => {
  const captured: string[] = [];
  const { pool } = poolWith((sql, calls) => {
    if (sql.startsWith("INSERT INTO works")) {
      const params = calls[calls.length - 1].params ?? [];
      captured.push(String(params[params.length - 1]));
      return { rows: [{ id: captured.length, work_code: params[params.length - 1] }] };
    }
    if (sql.includes("UPDATE works SET work_code")) return { rows: [{ work_code: "WRK-0000X" }] };
    return { rows: [] };
  });
  const repository = new PgWorkWriteRepository(pool);
  await repository.create({ title: "A" } as Parameters<typeof repository.create>[0]);
  await repository.create({ title: "B" } as Parameters<typeof repository.create>[0]);
  assert.equal(captured.length, 2);
  assert.notEqual(captured[0], captured[1]);
  assert.match(captured[0], /^PENDING-/);
});

test("自動採番は桁あふれで切り詰めない（lpad固定5桁で全行 WRK-10000 に潰れた実障害）", async () => {
  // 本番の works.id は移行時 setval で10億番台。lpad(id, 5) は先頭5文字に
  // 切り詰めるため全行 'WRK-10000' になり、2件目以降が一意制約違反だった。
  let updateSql = "";
  const { pool } = poolWith((sql) => {
    if (sql.startsWith("INSERT INTO works")) return { rows: [{ id: 1000000113, work_code: "PENDING-x" }] };
    if (sql.includes("UPDATE works SET work_code")) { updateSql = sql; return { rows: [{ work_code: "WRK-1000000113" }] }; }
    return { rows: [] };
  });
  const repository = new PgWorkWriteRepository(pool);
  const saved = await repository.create({ title: "新作" } as Parameters<typeof repository.create>[0]);
  assert.equal(saved.workCode, "WRK-1000000113");
  assert.match(updateSql, /GREATEST\(length\(id::text\), 5\)/);
});
