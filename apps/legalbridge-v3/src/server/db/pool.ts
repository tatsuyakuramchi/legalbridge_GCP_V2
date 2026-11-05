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
    // 接続を待つ上限。空きを待つ時間も含む。5 秒だと、起動直後（Cloud SQL への接続を張り直す）や
    // ホームのように一度に何本も問い合わせる画面で、軽い集計まで「timeout exceeded when trying
    // to connect」で落ちていた（2026-11-05 11:56 UTC）。
    connectionTimeoutMillis: int(process.env.DB_CONNECT_TIMEOUT_MS, 15_000)
  });
  return pool;
}

/** 接続の待ちで落ちたときに、プールがどういう状態だったか（使い切りか、つながらないのか）。 */
export function poolState(): { total: number; idle: number; waiting: number; max: number } | null {
  if (!pool) return null;
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount,
           max: int(process.env.DB_POOL_MAX, 10) };
}

/** pg-pool の「接続を待ちきれなかった」。 */
export const isPoolTimeout = (error: unknown): boolean =>
  /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i
    .test(String((error as { message?: unknown })?.message ?? ""));

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
