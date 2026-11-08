/**
 * DB の接続先の切り替え（docs/v3-local-app-cloud-db.md §3・§5）。
 *
 * 手元で動かすアプリは、平時は本番（primary＝Cloud SQL）、GCP 停止中は手元の写し（standby）に
 * つなぐ。どちらにつなぐかは次の順で決める。
 *
 *   1. DB_TARGET_PATH のファイルの中身（"primary" か "standby"）。ops failover / failback が書く。
 *      app と ops が同じ /data を見ているので、.env を書き換えずに切り替えられる
 *   2. 環境変数 DB_TARGET
 *   3. どちらも無ければ null＝従来どおり DB_HOST などをそのまま使う（いまの予備系・開発）
 *
 * 接続先は PRIMARY_DB_* / STANDBY_DB_*（HOST・PORT・NAME・USER・PASSWORD）。決まった側の値が
 * 揃っていなければ DB_* に落ちる（.env に片方しか書いていない環境でも起動する）。
 *
 * NUMBER_BAND=auto のときの番号帯もここで決める：本番につないでいるときだけ本番の連番、
 * それ以外（写し・従来）は予備系の帯（9000 番台。core/numbering.ts）。
 */

export type DbTarget = "primary" | "standby";

export interface DbEndpoint { host: string; port: number; database: string; user: string; password: string }

export interface DbTargetResolution {
  target: DbTarget | null;
  /** どこで決まったか。null は従来どおり。 */
  source: "file" | "env" | null;
  /** 決まった側の接続先。null なら DB_* をそのまま使う。 */
  endpoint: DbEndpoint | null;
  primary: DbEndpoint | null;
  standby: DbEndpoint | null;
  /** NUMBER_BAND=auto のときに使う帯。 */
  numberBand: "backup" | "";
  /** 起動時に知らせたいこと（ファイルの中身が読めない、など）。 */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const endpointOf = (env: Env, prefix: string): DbEndpoint | null => {
  const v = (k: string) => (env[`${prefix}_DB_${k}`] ?? "").trim();
  const host = v("HOST"), database = v("NAME"), user = v("USER"), password = v("PASSWORD");
  if (!host || !database || !user || !password) return null;
  const port = Number(v("PORT") || 5432);
  return { host, port: Number.isFinite(port) && port > 0 ? Math.trunc(port) : 5432, database, user, password };
};

const asTarget = (raw: string | undefined): DbTarget | null => {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "primary" || s === "standby" ? s : null;
};

export function resolveDbTarget(env: Env, readFile: (path: string) => string): DbTargetResolution {
  const warnings: string[] = [];
  let target: DbTarget | null = null;
  let source: DbTargetResolution["source"] = null;

  const path = (env.DB_TARGET_PATH ?? "").trim();
  if (path) {
    let content: string | null = null;
    try { content = readFile(path); } catch { content = null; }
    if (content !== null && content.trim()) {
      const t = asTarget(content);
      if (t) { target = t; source = "file"; }
      else warnings.push(`${path} の中身が primary / standby のどちらでもありません（"${content.trim()}"）。無視します`);
    }
  }
  if (!target) {
    const raw = env.DB_TARGET;
    if (raw && raw.trim()) {
      const t = asTarget(raw);
      if (t) { target = t; source = "env"; }
      else warnings.push(`DB_TARGET は primary / standby のどちらかです（"${raw}"）。無視します`);
    }
  }

  const primary = endpointOf(env, "PRIMARY");
  const standby = endpointOf(env, "STANDBY");
  let endpoint: DbEndpoint | null = null;
  if (target === "primary") {
    endpoint = primary;
    if (!primary) warnings.push("DB_TARGET=primary ですが PRIMARY_DB_* が揃っていません。DB_* につなぎます");
  } else if (target === "standby") {
    endpoint = standby;
    if (!standby) warnings.push("DB_TARGET=standby ですが STANDBY_DB_* が揃っていません。DB_* につなぎます");
  }

  return { target, source, endpoint, primary, standby, numberBand: target === "primary" ? "" : "backup", warnings };
}
