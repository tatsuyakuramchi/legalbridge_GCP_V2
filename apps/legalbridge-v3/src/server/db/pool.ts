import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
export type DatabasePool = pg.Pool;

let pool: DatabasePool | null = null;
let listening = false;

export function getPool(): DatabasePool | null {
  const discrete =
    config.databaseHost && config.databaseName && config.databaseUser && config.databasePassword;
  if (!config.databaseUrl && !discrete) return null;

  // search_path を v3 に固定する。アプリのSQLはスキーマ名を書かずに済み、
  // 万一 public のテーブル名と衝突しても v3 側が選ばれる。
  //
  // 接続ごとの上限（2026-11-05 11:54〜12:05 UTC の障害）。古いサーバの 5 本の接続が戻らず、軽い集計まで
  // 「timeout exceeded when trying to connect」で 10 分落ち続け、版を入れ替えて初めて直った。
  // 1 つの詰まった問い合わせ・止まった取引が接続を握り続けないよう、台帳の側で切る。
  //   lock_timeout … 表・行が押さえられていたら、この時間で諦める（Studio で COMMIT 前の ALTER など）
  //   idle_in_transaction_session_timeout … 取引の途中で止まった接続を切る
  //   statement_timeout … 1 つの問い合わせの上限。重い一括処理があるので既定では付けない（0 = 無し）
  const ms = (name: string, fallback: number) => {
    const raw = process.env[name];
    const n = raw === undefined || raw === "" ? fallback : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
  };
  const options = [
    `-c search_path=${config.databaseSchema}`,
    config.readOnly ? "-c default_transaction_read_only=on" : "",
    `-c lock_timeout=${ms("DB_LOCK_TIMEOUT_MS", 30_000)}`,
    `-c idle_in_transaction_session_timeout=${ms("DB_IDLE_TX_TIMEOUT_MS", 300_000)}`,
    `-c statement_timeout=${ms("DB_STATEMENT_TIMEOUT_MS", 0)}`
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
    connectionTimeoutMillis: int(process.env.DB_CONNECT_TIMEOUT_MS, 15_000),
    // 切れた TCP 接続を早く見つけて捨てる（Cloud SQL の再起動・経路の切断で、生きている扱いのまま残らないように）。
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000
  });
  if (!listening) {
    listening = true;
    // 台帳の側で切られた接続（再起動・上の上限で切った取引）は 'error' を出す。受け手が無いと
    // Node はそれを処理されない例外としてサーバごと落とす。記録して、プールに捨てさせる。
    pool.on("error", (error) => {
      console.error("db pool idle client error", (error as { code?: string })?.code ?? "", error?.message);
    });
    pool.on("connect", (client) => {
      client.on("error", (error) => {
        console.error("db client error", (error as { code?: string })?.code ?? "", error?.message);
      });
    });
  }
  return pool;
}

/** 接続の待ちで落ちたときに、プールがどういう状態だったか（使い切りか、つながらないのか）。 */
export function poolState(): { total: number; idle: number; waiting: number; max: number } | null {
  if (!pool) return null;
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount,
           max: int(process.env.DB_POOL_MAX, 10) };
}

/**
 * 上の上限で台帳が止めた問い合わせ。lock_timeout（55P03）・statement_timeout（57014）・
 * 止まった取引を切った（25P03）。いずれも「待てば通るかもしれない」ので 503 で返す。
 */
export const isDbTimeout = (error: unknown): "lock" | "statement" | "idle_tx" | null => {
  const code = String((error as { code?: unknown })?.code ?? "");
  return code === "55P03" ? "lock" : code === "57014" ? "statement" : code === "25P03" ? "idle_tx" : null;
};

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
