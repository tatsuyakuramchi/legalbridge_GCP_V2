import type { Queryable } from "./db.js";

export interface AuditEntry {
  actor: string;
  action: string;              // condition.update / document.issue / payment.allocate ...
  targetType: string;
  targetId?: number | null;
  idempotencyKey?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * 監査記録。V2 では 12 の台帳表に分かれていたものを 1 本にまとめる。
 * 追記専用なので UPDATE / DELETE は行わない。
 */
export async function recordAudit(client: Queryable, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (actor, action, target_type, target_id, idempotency_key, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      entry.actor,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.idempotencyKey ?? null,
      JSON.stringify(entry.detail ?? {})
    ]
  );
}
