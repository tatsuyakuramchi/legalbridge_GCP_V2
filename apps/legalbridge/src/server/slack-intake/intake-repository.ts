import type { DatabasePool } from "../db/pool.js";

// 法務依頼インテークの書込（Phase 16-3a・grant 044）。V1 processLegalRequestSubmission の
// DB 書込サブセット：legal_requests INSERT ＋ issue_workflows INSERT（'文書生成依頼'）。
//   - legal_requests には V1 の AFTER INSERT トリガ（0103）があり matters/matter_issues が
//     自動生成される（べき等）。runtime ロールに両表の INSERT が必要（preflight 044 で確認）。
//   - すべての受付は隔離台帳 lb_v2_slack_intake_ledger にも記録する（dry-run はこちらのみ）。

export interface IntakeStaff { email: string | null; department: string | null; }

export interface RecordRequestInput {
  backlogIssueKey: string;
  slackUserId: string;
  requestType: string;
  counterparty: string | null;
  summary: string;
  notes: string | null;
}

export interface IntakeLedgerInput {
  slackUserId: string;
  requestType: string;
  summary: string;
  backlogIssueKey: string | null;
  mode: "live" | "dry-run";
  payload: unknown;
}

export interface SlackIntakeRepository {
  staffBySlackId(slackUserId: string): Promise<IntakeStaff | null>;
  departmentChannel(department: string | null): Promise<string | null>;
  recordRequest(input: RecordRequestInput): Promise<void>;
  ledger(input: IntakeLedgerInput): Promise<void>;
}

export class PgSlackIntakeRepository implements SlackIntakeRepository {
  constructor(private readonly database: DatabasePool) {}

  async staffBySlackId(slackUserId: string): Promise<IntakeStaff | null> {
    const r = await this.database.query(
      `SELECT email, department FROM staff WHERE slack_user_id = $1 LIMIT 1`, [slackUserId]);
    if (!r.rows[0]) return null;
    return { email: r.rows[0].email ?? null, department: r.rows[0].department ?? null };
  }

  async departmentChannel(department: string | null): Promise<string | null> {
    if (!department) return null;
    const r = await this.database.query(
      `SELECT slack_channel_id FROM department_workflow_rules
        WHERE department = $1 AND COALESCE(is_active, TRUE) LIMIT 1`, [department]);
    return r.rows[0]?.slack_channel_id ?? null;
  }

  async recordRequest(input: RecordRequestInput): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO legal_requests (backlog_issue_key, slack_user_id, contract_type, counterparty, summary, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.backlogIssueKey, input.slackUserId, input.requestType,
         input.counterparty, input.summary, input.notes]
      );
      await client.query(
        `INSERT INTO issue_workflows (backlog_issue_key, issue_type_name, current_status_name)
         VALUES ($1, $2, '文書生成依頼')
         ON CONFLICT (backlog_issue_key) DO NOTHING`,
        [input.backlogIssueKey, input.requestType]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ledger(input: IntakeLedgerInput): Promise<void> {
    await this.database.query(
      `INSERT INTO lb_v2_slack_intake_ledger
         (slack_user_id, request_type, summary, backlog_issue_key, mode, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [input.slackUserId, input.requestType, input.summary, input.backlogIssueKey,
       input.mode, JSON.stringify(input.payload ?? {})]
    );
  }
}

export class MemorySlackIntakeRepository implements SlackIntakeRepository {
  readonly requests: RecordRequestInput[] = [];
  readonly ledgerRows: IntakeLedgerInput[] = [];
  constructor(
    private readonly staff = new Map<string, IntakeStaff>(),
    private readonly channels = new Map<string, string>(),
    private readonly forbidden = false
  ) {}
  async staffBySlackId(slackUserId: string) { return this.staff.get(slackUserId) ?? null; }
  async departmentChannel(department: string | null) {
    return department ? this.channels.get(department) ?? null : null;
  }
  async recordRequest(input: RecordRequestInput) {
    if (this.forbidden) { const e = new Error("forbidden"); (e as { code?: string }).code = "42501"; throw e; }
    this.requests.push(input);
  }
  async ledger(input: IntakeLedgerInput) { this.ledgerRows.push(input); }
}
