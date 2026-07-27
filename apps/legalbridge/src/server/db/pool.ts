import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export type DatabasePool = pg.Pool;

let pool: DatabasePool | null = null;

export function getPool(): DatabasePool | null {
  if (!config.databaseUrl) return null;
  pool ??= new Pool({
    connectionString: config.databaseUrl,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  return pool;
}

export async function checkDatabase(database: DatabasePool | null) {
  if (!database) return { configured: false, reachable: false };
  try {
    await database.query("SELECT 1");
    return { configured: true, reachable: true };
  } catch {
    return { configured: true, reachable: false };
  }
}

