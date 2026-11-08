import pg from "pg";
import type { DbEndpoint } from "./target.js";

/**
 * 本番 DB（primary）に届くかを、短い接続で確かめる（docs/v3-local-app-cloud-db.md §3）。
 *
 * 写し（standby）で動いている間、画面に「本番 DB に届くようになりました」と出すためのもの。
 * 自動では切り替えない（届いた・届かないは経路の一時断でも起きる）。人が判断する材料にする。
 *
 * 接続は 3 秒で諦め、結果を 30 秒持ち回す（/api/v3/me は画面を開くたびに呼ばれる）。
 */
export type Connector = (endpoint: DbEndpoint) => Promise<void>;

const pgConnect: Connector = async (endpoint) => {
  const client = new pg.Client({
    host: endpoint.host, port: endpoint.port, database: endpoint.database,
    user: endpoint.user, password: endpoint.password,
    application_name: "legalbridge-v3-probe", connectionTimeoutMillis: 3_000
  });
  await client.connect();
  try { await client.query("SELECT 1"); } finally { await client.end().catch(() => undefined); }
};

export class PrimaryProbe {
  private last: { at: number; ok: boolean } | null = null;
  private inflight: Promise<boolean> | null = null;

  constructor(
    private readonly endpoint: DbEndpoint | null,
    private readonly connect: Connector = pgConnect,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** 届くか。接続先が無ければ null（分からない）。 */
  async reachable(): Promise<boolean | null> {
    if (!this.endpoint) return null;
    const t = this.now();
    if (this.last && t - this.last.at < this.ttlMs) return this.last.ok;
    this.inflight ??= this.connect(this.endpoint).then(() => true, () => false)
      .then((ok) => { this.last = { at: this.now(), ok }; this.inflight = null; return ok; });
    return this.inflight;
  }
}
