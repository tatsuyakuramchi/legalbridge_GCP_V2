import type { DatabasePool } from "../db/pool.js";

// Webhook べき等台帳（lb_v2_webhook_receipts・grant 032）。(source, external_id) が初出なら
// true を返して記録、既出なら false（＝副作用をスキップ）。権限/表未整備は firstTime=false 側に
// 倒さず、呼び出し側が判断できるよう throw する（べき等性が壊れるほうが危険なため）。

export interface WebhookReceiptsRepository {
  // 初回なら記録して true、既に記録済みなら false。
  recordIfFirst(source: string, externalId: string, detail?: Record<string, unknown>): Promise<boolean>;
}

export class PgWebhookReceiptsRepository implements WebhookReceiptsRepository {
  constructor(private readonly database: DatabasePool) {}
  async recordIfFirst(source: string, externalId: string, detail: Record<string, unknown> = {}) {
    const r = await this.database.query(
      `INSERT INTO lb_v2_webhook_receipts (source, external_id, detail)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [source, externalId, JSON.stringify(detail)]
    );
    return (r.rowCount ?? 0) > 0;
  }
}

export class MemoryWebhookReceiptsRepository implements WebhookReceiptsRepository {
  readonly seen = new Set<string>();
  async recordIfFirst(source: string, externalId: string) {
    const key = `${source}:${externalId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
