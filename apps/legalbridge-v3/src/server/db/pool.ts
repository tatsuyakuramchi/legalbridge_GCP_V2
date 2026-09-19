import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
export type DatabasePool = pg.Pool;

let pool: DatabasePool | null = null;

export function getPool(): DatabasePool | null {
  const discrete =
    config.databaseHost && config.databaseName && config.databaseUser && config.databasePassword;
  if (!config.databaseUrl && !discrete) return null;

  // search_path を v3 に固定する。アプリのSQLはスキーマ名を書かずに済み、
  // 万一 public のテーブル名と衝突しても v3 側が選ばれる。
  const options = [
    `-c search_path=${config.databaseSchema}`,
    config.readOnly ? "-c default_transaction_read_only=on" : ""
  ].filter(Boolean).join(" ");

  pool ??= new Pool({
    ...(config.databaseUrl
      ? { connectionString: config.databaseUrl }
      : {
          host: config.databaseHost!,
          port: config.databasePort,
          database: config.databaseName!,
          user: config.databaseUser!,
          password: config.databasePassword!
        }),
    application_name: "legalbridge-v3",
    options,
    max: int(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  return pool;
}

function int(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function checkDatabase(database: DatabasePool | null) {
  if (!database) return { configured: false, reachable: false, schema: null, readOnly: null };
  try {
    const r = await database.query<{ search_path: string; ro: boolean }>(
      `SELECT current_setting('search_path') AS search_path,
              current_setting('transaction_read_only')::boolean AS ro`
    );
    return {
      configured: true,
      reachable: true,
      schema: r.rows[0]?.search_path ?? null,
      readOnly: r.rows[0]?.ro ?? false
    };
  } catch (error) {
    const e = error as Error & { code?: string };
    console.error("db health check failed", { code: e?.code ?? "UNKNOWN", message: e?.message });
    return { configured: true, reachable: false, schema: null, readOnly: null };
  }
}
