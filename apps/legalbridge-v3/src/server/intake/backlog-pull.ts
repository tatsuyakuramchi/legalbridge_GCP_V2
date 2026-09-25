import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import type { BacklogIssue, BacklogReader } from "../integrations/adapters.js";
import type { IntegrationMode } from "../integrations/gate.js";
import { fromIssue, requestNoInSummary, snapshotOf, tokyoDate } from "./guess.js";

/**
 * Backlog を読みに行って受付箱に入れる。docs/v3-request-inbox.md §5
 *
 * Cloud Scheduler から 5 分ごとに叩く（/internal/jobs/backlog-pull）。
 * V1 の Slack 受付・GAS・Backlog 直接起票で立った課題を、ここで受付箱に拾う。
 *
 *   - 案件に繋がっている課題（matter_links の backlog_issue）は取り込まない。
 *     案件から立てた課題や、移行してきた課題が受付箱に湧かないように。
 *   - 受付箱にある課題は写しを更新する。受付済みで更新時刻が進んでいれば「更新あり」。
 *   - Slack 受付で立てた課題（件名が [REQ-…]）は、キーを控える前に読まれても
 *     同じ依頼に繋ぐ（二重に入れない）。
 *
 * 栞（settings の backlog_pull_cursor）は「前回見た課題の最大更新時刻」。
 * 5 分巻き戻して読む（境界の取りこぼし対策。同じ課題は冪等に扱う）。
 * 1件の失敗で残りを止めない。栞は失敗より手前までしか進めない（メール取込と同じ）。
 * Backlog へは書き込まない。
 */

export const CURSOR_KEY = "backlog_pull_cursor";
export const PAGE_SIZE = 100;
export const MAX_PAGES = 50;
export const OVERLAP_MS = 5 * 60 * 1000;
export const FIRST_LOOKBACK_MS = 24 * 3600 * 1000;

export type PullAction = "created" | "updated" | "unchanged" | "linked_to_matter" | "attached";

export interface BacklogPullReport {
  ran: boolean;
  reason?: string;
  fetched: number;
  counts: Partial<Record<PullAction | "failed", number>>;
  created: Array<{ requestNo: string | null; issueKey: string }>;
  failures: Array<{ issueKey: string; error: string }>;
  since: string | null;
  cursorBefore: string | null;
  cursorAfter: string | null;
}

export interface PullSettings { mode: IntegrationMode; readOnly: boolean }

export class BacklogPullJob {
  constructor(
    private readonly database: Transactable,
    private readonly reader: BacklogReader | null,
    private readonly settings: () => PullSettings,
    private readonly now: () => Date = () => new Date()
  ) {}

  async run(options: { since?: string | null } = {}): Promise<BacklogPullReport> {
    const empty = { fetched: 0, counts: {}, created: [], failures: [],
                    since: null, cursorBefore: null, cursorAfter: null };
    const s = this.settings();
    if (s.mode === "off") return { ran: false, reason: "Backlog 連携が無効です（BACKLOG_MODE=off）", ...empty };
    if (s.readOnly) return { ran: false, reason: "読み取り専用で動作しています", ...empty };
    if (!this.reader || !this.reader.configured) {
      return { ran: false, reason: "Backlog の接続情報がありません（BACKLOG_HOST / API_KEY / PROJECT_ID）", ...empty };
    }

    try {
      const cursorBefore = await this.readCursor();
      const since = options.since ? new Date(options.since)
        : cursorBefore ? new Date(new Date(cursorBefore).getTime() - OVERLAP_MS)
        : new Date(this.now().getTime() - FIRST_LOOKBACK_MS);
      if (Number.isNaN(since.getTime())) {
        return { ran: false, reason: `since が日時として読めません：${options.since}`, ...empty };
      }

      // 読む。Backlog の updatedSince は日付単位なので 1 日前から取り、時刻で絞る。
      const issues: BacklogIssue[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const batch = await this.reader.listIssues({
          count: PAGE_SIZE, offset: page * PAGE_SIZE, sort: "updated", order: "asc",
          updatedSince: tokyoDate(new Date(since.getTime() - 24 * 3600 * 1000))
        });
        for (const issue of batch) {
          const updated = issue.updated ? new Date(issue.updated) : null;
          if (updated && updated < since) continue;
          issues.push(issue);
        }
        if (batch.length < PAGE_SIZE) break;
        if (page === MAX_PAGES - 1) {
          throw new Error(`取得が ${MAX_PAGES * PAGE_SIZE} 件を超えました。since を分けて取り直してください`);
        }
      }

      const counts: BacklogPullReport["counts"] = {};
      const created: BacklogPullReport["created"] = [];
      const failures: BacklogPullReport["failures"] = [];
      let advanceTo: string | null = cursorBefore;
      let stopped = false;
      for (const issue of issues) {
        try {
          const action = await inTransaction(this.database, (client) => this.apply(client, issue, created));
          counts[action] = (counts[action] ?? 0) + 1;
          if (!stopped && issue.updated && (!advanceTo || new Date(issue.updated) > new Date(advanceTo))) {
            advanceTo = new Date(issue.updated).toISOString();
          }
        } catch (error) {
          stopped = true;
          failures.push({ issueKey: issue.issueKey, error: (error as Error)?.message ?? String(error) });
        }
      }
      if (failures.length) counts.failed = failures.length;
      if (advanceTo && advanceTo !== cursorBefore) await this.writeCursor(advanceTo);

      await inTransaction(this.database, (client) => recordAudit(client, {
        actor: "system", action: "job.backlog_pull", targetType: "job",
        detail: { fetched: issues.length, counts, since: since.toISOString(),
                  cursorBefore, cursorAfter: advanceTo,
                  created: created.slice(0, 50), failures: failures.slice(0, 20) }
      }));

      return { ran: true, fetched: issues.length, counts, created, failures,
               since: since.toISOString(), cursorBefore, cursorAfter: advanceTo };
    } catch (error) { throw translate(error); }
  }

  /** 課題1件を受付箱に反映する。 */
  private async apply(
    client: Queryable, issue: BacklogIssue, created: BacklogPullReport["created"]
  ): Promise<PullAction> {
    const key = String(issue.issueKey ?? "").trim().toUpperCase();
    const snapshot = JSON.stringify(snapshotOf(issue));
    const status = issue.status?.name ?? null;
    const updated = issue.updated ?? null;

    const found = await client.query(
      `SELECT id, state, backlog_updated_at, backlog_issue_key
         FROM intake_requests
        WHERE backlog_issue_id = $1 OR backlog_issue_key = $2
        ORDER BY (backlog_issue_id = $1) DESC NULLS LAST
        LIMIT 1
        FOR UPDATE`, [issue.id, key]);
    let row = found.rows[0] as any;
    let attached = false;

    // Slack 受付で立てた課題。キーを控える前に読まれたら、ここで繋ぐ。
    if (!row) {
      const no = requestNoInSummary(issue.summary);
      if (no) {
        const byNo = await client.query(
          `SELECT id, state, backlog_updated_at, backlog_issue_key
             FROM intake_requests WHERE request_no = $1 AND backlog_issue_key IS NULL FOR UPDATE`, [no]);
        row = byNo.rows[0] as any;
        attached = Boolean(row);
      }
    }

    if (row) {
      const before = row.backlog_updated_at ? new Date(row.backlog_updated_at).getTime() : null;
      const after = updated ? new Date(updated).getTime() : null;
      if (!attached && before !== null && after !== null && after <= before) return "unchanged";
      // 受け付けたあとに Backlog 側が動いた。知らせるだけで、案件は動かさない。
      const unseen = !attached && before !== null && String(row.state) === "accepted";
      await client.query(
        `UPDATE intake_requests
            SET backlog_issue_key = COALESCE(backlog_issue_key, $2),
                backlog_issue_id  = COALESCE(backlog_issue_id, $3),
                backlog_status = $4, backlog_updated_at = $5::timestamptz, backlog_snapshot = $6::jsonb,
                has_unseen_update = has_unseen_update OR $7, updated_at = now()
          WHERE id = $1`,
        [row.id, key, issue.id, status, updated, snapshot, unseen]);
      if (unseen) {
        await recordAudit(client, {
          actor: "system", action: "intake.backlog_changed", targetType: "intake_request",
          targetId: Number(row.id), detail: { issueKey: key, status, updated }
        });
      }
      return attached ? "attached" : "updated";
    }

    // 案件に繋がっている課題は受付箱に入れない（案件から立てた・移行してきた課題）。
    const linked = await client.query(
      `SELECT 1 FROM matter_links WHERE target_type = 'backlog_issue' AND target_ref = $1 LIMIT 1`, [key]);
    if (linked.rows[0]) return "linked_to_matter";

    const f = fromIssue(issue);
    const requestNo = await allocateNumber(
      client, { prefix: "REQ", table: "intake_requests", column: "request_no" });
    const inserted = await client.query(
      `INSERT INTO intake_requests
         (request_no, source, state, kind, title, detail, counterparty_name, due_on,
          requester_slack_id, requester_name,
          backlog_issue_key, backlog_issue_id, backlog_status, backlog_updated_at, backlog_snapshot,
          created_by)
       VALUES ($1, 'backlog', 'new', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb,
               'backlog-pull')
       RETURNING id`,
      [requestNo, f.kind, f.title, f.detail, f.counterpartyName, f.dueOn,
       f.requesterSlackId, f.requesterName, key, issue.id, status, updated, snapshot]);
    await recordAudit(client, {
      actor: "system", action: "intake.pull", targetType: "intake_request",
      targetId: Number((inserted.rows[0] as any).id),
      detail: { issueKey: key, requestNo, kind: f.kind }
    });
    created.push({ requestNo, issueKey: key });
    return "created";
  }

  private async readCursor(): Promise<string | null> {
    const r = await this.database.query(
      "SELECT value->>'since' AS since FROM settings WHERE key = $1", [CURSOR_KEY]);
    return ((r.rows[0] as { since?: string } | undefined)?.since) ?? null;
  }

  private async writeCursor(since: string): Promise<void> {
    await this.database.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'system')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = 'system'`,
      [CURSOR_KEY, JSON.stringify({ since })]);
  }
}
