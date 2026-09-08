import { inTransaction, type Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

export class OpsRepository {
  constructor(private readonly database: Transactable) {}

  /** データ品質。移行で落ちた行も、運用で出た不整合も同じ表に集まる。 */
  async issues(status = "open", limit = 300) {
    try {
      const r = await this.database.query(
        `SELECT id, rule_code, target_type, target_id, severity, status, detected_at, detail
           FROM data_quality_issues
          WHERE ($1 = 'all' OR status = $1)
          ORDER BY (severity = 'high') DESC, detected_at DESC
          LIMIT $2`, [status, Math.min(Math.max(limit, 1), 1000)]);
      return r.rows.map((row: Record<string, any>) => ({
        id: Number(row.id),
        ruleCode: String(row.rule_code),
        targetType: String(row.target_type),
        targetId: Number(row.target_id),
        severity: String(row.severity),
        status: String(row.status),
        detectedAt: new Date(String(row.detected_at)).toISOString(),
        detail: (row.detail as Record<string, unknown>) ?? {}
      }));
    } catch (error) { throw translate(error); }
  }

  async resolveIssue(id: number, actor: string, mode: "resolved" | "ignored") {
    try {
      return await inTransaction(this.database, async (client) => {
        const updated = await client.query(
          `UPDATE data_quality_issues SET status = $2, resolved_at = now()
            WHERE id = $1 AND status = 'open' RETURNING rule_code, target_type, target_id`,
          [id, mode]);
        const row = updated.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `未解決の課題 ${id} が見つかりません`);
        await recordAudit(client, {
          actor, action: `quality.${mode}`, targetType: "data_quality_issue", targetId: id,
          detail: { ruleCode: row.rule_code, target: `${row.target_type}:${row.target_id}` }
        });
        return { id, status: mode };
      });
    } catch (error) { throw translate(error); }
  }

  /** 監査記録。V2 では12の台帳表に分かれていたものが1本になっている。 */
  async auditEvents(query: { action?: string; targetType?: string; limit?: number } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.action) { params.push(`${query.action}%`); where.push(`action LIKE $${params.length}`); }
    if (query.targetType) { params.push(query.targetType); where.push(`target_type = $${params.length}`); }
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `SELECT id, occurred_at, actor, action, target_type, target_id, detail
           FROM audit_events
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY occurred_at DESC, id DESC
          LIMIT $${params.length}`, params);
      return r.rows.map((row: Record<string, any>) => ({
        id: Number(row.id),
        occurredAt: new Date(String(row.occurred_at)).toISOString(),
        actor: String(row.actor),
        action: String(row.action),
        targetType: String(row.target_type),
        targetId: row.target_id === null ? null : Number(row.target_id),
        detail: (row.detail as Record<string, unknown>) ?? {}
      }));
    } catch (error) { throw translate(error); }
  }

  async settings() {
    try {
      const r = await this.database.query("SELECT key, value, updated_at FROM settings ORDER BY key");
      return r.rows.map((row: Record<string, any>) => ({
        key: String(row.key),
        value: row.value,
        updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null
      }));
    } catch (error) { throw translate(error); }
  }

  async saveSetting(key: string, value: unknown, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        await client.query(
          `INSERT INTO settings (key, value, updated_at, updated_by)
           VALUES ($1, $2::jsonb, now(), $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [key, JSON.stringify(value ?? {}), actor]);
        await recordAudit(client, {
          actor, action: "settings.save", targetType: "setting", detail: { key }
        });
        return { key };
      });
    } catch (error) { throw translate(error); }
  }

  /** ホームの数字。すべて条件を起点に導出する。 */
  async summary() {
    try {
      const r = await this.database.query(
        `SELECT
           (SELECT count(*)::int FROM matters WHERE status NOT IN ('done','canceled'))        AS open_matters,
           (SELECT count(*)::int FROM v_deadlines
             WHERE due_on BETWEEN current_date AND current_date + 7)                          AS due_soon,
           (SELECT COALESCE(SUM(ag_remaining), 0)::bigint FROM v_condition_balance)           AS ag_remaining,
           (SELECT count(*)::int FROM data_quality_issues WHERE status = 'open'
              AND severity = 'high')                                                          AS quality_high,
           (SELECT count(*)::int FROM conditions WHERE status = 'active' AND direction = 'in') AS in_conditions,
           (SELECT count(*)::int FROM conditions WHERE status = 'active' AND direction = 'out')AS out_conditions`);
      const row = r.rows[0] as Record<string, any>;
      return {
        openMatters: Number(row.open_matters ?? 0),
        dueSoon: Number(row.due_soon ?? 0),
        agRemaining: Number(row.ag_remaining ?? 0),
        qualityHigh: Number(row.quality_high ?? 0),
        inConditions: Number(row.in_conditions ?? 0),
        outConditions: Number(row.out_conditions ?? 0)
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 期限。過ぎたものは下限なしで全部返す。
   *
   * 以前は「今日-30日から」で切っていたが、期限切れは古いほど危険なのに
   * 古いほど見えなくなる。実データで6〜7週間放置されたタスク4件と
   * 満了済みの契約1件が画面から消えていた。
   */
  async deadlines(days = 30) {
    try {
      const r = await this.database.query(
        `SELECT source, ref_id, ref_no, title, due_on, status,
                (due_on < current_date) AS overdue
           FROM v_deadlines
          WHERE due_on <= current_date + $1::int
          ORDER BY due_on LIMIT 200`, [Math.min(Math.max(days, 1), 365)]);
      return r.rows.map((row: Record<string, any>) => ({
        source: String(row.source), refId: Number(row.ref_id), refNo: str(row.ref_no),
        title: String(row.title ?? ""), dueOn: dateStr(row.due_on) ?? "",
        status: String(row.status), overdue: Boolean(row.overdue)
      }));
    } catch (error) { throw translate(error); }
  }
}
