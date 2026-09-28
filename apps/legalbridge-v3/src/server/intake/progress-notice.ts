import { inTransaction, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import {
  firedKeys, isPaymentPurpose, loadProgress, milestoneText, paymentDocLabel, STAGE_LABEL,
  type PaymentPurpose
} from "./payment-request.js";
import { SETTINGS_KEY } from "../matters/flow-notice.js";

/**
 * 案件にせず処理している依頼（A-058）の節目を、依頼者の DM のスレッドに知らせる。
 *
 * 案件の工程の知らせ（matters/flow-notice.ts）と同じ作り。工程は保存しないので、
 * 定期的に導き直し、前回までに知らせた節目（audit_events の intake.progress_notice）と
 * 比べて、新しく成り立ったものだけを送る。
 *
 *   - 知らせるのは 作成・送付・支払予定・支払（受付は受け付けたときに送っている）
 *   - 同じ節目は二度送らない（冪等キー intake-progress:<依頼>:<節目>）
 *   - 1回の実行で1依頼につき1通にまとめる
 *   - 止めるのは案件の工程の知らせと同じ settings の flow_notice。
 *     段ごとに外すなら {"off": ["送付"]}（段の名前は 作成・送付・支払予定・支払）
 *   - Slack のゲートで止まっても節目は記録する（開けた日に溜まった分が届かないように）
 */

export interface RequestNoticeDeps {
  database: Transactable;
  /** 依頼のスレッドへ送る（IntakeRequestService.notifyProgress）。送れたら true。 */
  send: (requestId: number, slackId: string, body: string) => Promise<boolean>;
}

export interface RequestNoticeReport {
  ran: boolean;
  reason?: string;
  requests: number;
  notified: Array<{ requestNo: string | null; keys: string[]; sent: boolean }>;
  failures: Array<{ requestId: number; error: string }>;
}

export const ACTOR = "system:intake-progress";

export class RequestProgressNoticeJob {
  constructor(private readonly deps: RequestNoticeDeps) {}

  async run(options: { limit?: number } = {}): Promise<RequestNoticeReport> {
    const { database } = this.deps;
    const empty = { requests: 0, notified: [], failures: [] };
    try {
      const s = await database.query("SELECT value FROM settings WHERE key = $1", [SETTINGS_KEY]);
      const setting = ((s.rows[0] as any)?.value ?? {}) as { disabled?: boolean; off?: string[] };
      if (setting.disabled) return { ran: false, reason: "工程の通知は止めてあります（settings の flow_notice）", ...empty };
      const off = new Set(setting.off ?? []);

      // 完了した依頼は完了の知らせのために数日だけ見る。
      const r = await database.query(
        `SELECT id, request_no, title, requester_slack_id, source_payload, created_at, handled_at, done_at
           FROM intake_requests
          WHERE state = 'accepted' AND handling = 'direct' AND requester_slack_id IS NOT NULL
            AND (done_at IS NULL OR done_at > now() - interval '3 days')
          ORDER BY id
          LIMIT $1`, [options.limit ?? 500]);
      const rows = r.rows as any[];
      const ids = rows.map((x) => Number(x.id));
      const marks = new Map<number, Set<string>>();
      if (ids.length) {
        const k = await database.query(
          `SELECT target_id, detail->>'key' AS key FROM audit_events
            WHERE action = 'intake.progress_notice' AND target_type = 'intake_request'
              AND target_id = ANY($1::bigint[])`, [ids]);
        for (const row of k.rows as any[]) {
          const id = Number(row.target_id);
          if (!marks.has(id)) marks.set(id, new Set());
          marks.get(id)!.add(String(row.key));
        }
      }

      const report: RequestNoticeReport = { ran: true, ...empty, requests: rows.length, notified: [], failures: [] };
      for (const row of rows) {
        const requestId = Number(row.id);
        try {
          const purpose = (row.source_payload ?? {}).purpose as PaymentPurpose;
          if (!isPaymentPurpose(purpose)) continue;
          const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
          const doneAt = iso(row.done_at);
          const progress = await loadProgress(database, {
            id: requestId, purpose, createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
            acceptedAt: iso(row.handled_at), doneAt
          });
          const seen = marks.get(requestId) ?? new Set<string>();
          const fresh = firedKeys(progress, doneAt)
            .filter((key) => !seen.has(key))
            .filter((key) => key === "done" || !off.has(STAGE_LABEL[key]));
          if (!fresh.length) continue;
          // 支払まで済んだら、支払予定は飛ばしてよい（同じ回で両方成り立ったとき）。
          const keys = fresh.includes("paid") ? fresh.filter((k) => k !== "scheduled") : fresh;
          const body = [
            `📌 ${row.request_no ?? ""} ${String(row.title)}（${paymentDocLabel(purpose)}）`.trim(),
            ...keys.map((key) => `・${milestoneText(key, purpose, progress)}`)
          ].join("\n");
          const sent = await this.deps.send(requestId, String(row.requester_slack_id), body);
          await inTransaction(database, async (client) => {
            for (const key of fresh) {
              await recordAudit(client, {
                actor: ACTOR, action: "intake.progress_notice", targetType: "intake_request", targetId: requestId,
                idempotencyKey: `intake-progress:${requestId}:${key}`,
                detail: { key, sent }
              });
            }
          });
          report.notified.push({ requestNo: row.request_no ?? null, keys, sent });
        } catch (error) {
          report.failures.push({ requestId, error: (error as Error)?.message ?? String(error) });
        }
      }

      await inTransaction(database, (client) => recordAudit(client, {
        actor: ACTOR, action: "job.intake_progress_notice", targetType: "job",
        detail: { requests: report.requests, notified: report.notified.slice(0, 50),
                  failures: report.failures.slice(0, 20) }
      }));
      return report;
    } catch (error) { throw translate(error); }
  }
}
