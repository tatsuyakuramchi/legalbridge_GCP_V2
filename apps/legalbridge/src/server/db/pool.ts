import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export type DatabasePool = pg.Pool;

let pool: DatabasePool | null = null;
let outboundPool: DatabasePool | null = null;

export function getPool(): DatabasePool | null {
  const hasDiscreteConfig =
    config.databaseHost &&
    config.databaseName &&
    config.databaseUser &&
    config.databasePassword;
  if (!config.databaseUrl && !hasDiscreteConfig) return null;

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
    application_name: "legalbridge-v2",
    options:
      config.databaseAccessMode === "readonly"
        ? "-c default_transaction_read_only=on"
        : undefined,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  return pool;
}

export function getOutboundPool(): DatabasePool | null {
  const configured =
    config.outboundConditionWritesEnabled &&
    config.outboundDatabaseHost &&
    config.outboundDatabaseName === "legalbridge" &&
    config.outboundDatabaseUser &&
    config.outboundDatabasePassword;
  if (!configured) return null;

  outboundPool ??= new Pool({
    host: config.outboundDatabaseHost!,
    port: config.outboundDatabasePort,
    database: config.outboundDatabaseName!,
    user: config.outboundDatabaseUser!,
    password: config.outboundDatabasePassword!,
    application_name: "legalbridge-v2-outbound",
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  return outboundPool;
}

export async function checkDatabase(database: DatabasePool | null) {
  if (!database) {
    return {
      configured: false,
      reachable: false,
      readOnly: null,
      currentDatabase: null
    };
  }
  try {
    const result = await database.query<{
      transaction_read_only: boolean;
      current_database: string;
    }>(
      `SELECT
         current_setting('transaction_read_only')::boolean AS transaction_read_only,
         current_database() AS current_database`
    );
    return {
      configured: true,
      reachable: true,
      readOnly: result.rows[0]?.transaction_read_only ?? false,
      currentDatabase: result.rows[0]?.current_database ?? null
    };
  } catch (error) {
    const databaseError = error as Error & { code?: string };
    console.error("Database health check failed", {
      name: databaseError?.name ?? "UnknownError",
      code: databaseError?.code ?? "UNKNOWN",
      message: databaseError?.message ?? "Unknown database error"
    });
    return {
      configured: true,
      reachable: false,
      readOnly: null,
      currentDatabase: null
    };
  }
}
