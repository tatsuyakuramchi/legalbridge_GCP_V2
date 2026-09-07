// V3 の実行時設定。V2 と違い、DB は v3 スキーマだけを見る。
const bool = (v: string | undefined, fallback = false) =>
  v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface Config {
  port: number;
  databaseUrl?: string;
  databaseHost?: string;
  databasePort: number;
  databaseName?: string;
  databaseUser?: string;
  databasePassword?: string;
  /** v3 スキーマ以外を見せない。public への読み書きは V1 のものなので触らない。 */
  databaseSchema: string;
  readOnly: boolean;
  authMode: "disabled" | "iap";
  adminEmails: string[];
  legalEmails: string[];
  requesterDomains: string[];
}

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const config: Config = {
  port: int(process.env.PORT, 8081),
  databaseUrl: process.env.DATABASE_URL,
  databaseHost: process.env.DB_HOST,
  databasePort: int(process.env.DB_PORT, 5432),
  databaseName: process.env.DB_NAME,
  databaseUser: process.env.DB_USER,
  databasePassword: process.env.DB_PASSWORD,
  databaseSchema: (process.env.DB_SCHEMA ?? "v3").trim(),
  readOnly: bool(process.env.READ_ONLY, false),
  authMode: process.env.AUTH_MODE === "iap" ? "iap" : "disabled",
  adminEmails: list(process.env.ADMIN_EMAILS),
  legalEmails: list(process.env.LEGAL_EMAILS),
  requesterDomains: list(process.env.REQUESTER_DOMAINS)
};
