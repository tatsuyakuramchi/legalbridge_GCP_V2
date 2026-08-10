import type { DatabasePool } from "../db/pool.js";
import type { WorkflowRuleInput } from "./workflow-rules-schema.js";

// 承認ルート リポジトリ（Phase 11-2・grant 037）。department_workflow_rules を list/upsert。
// 表未整備(42P01)は list で空縮退。権限不足(42501)は upsert で throw（route が FORBIDDEN_DB へ）。

export interface WorkflowRule {
  department: string;
  approverSlackId: string | null;
  stampOperatorSlackId: string | null;
  managerSlackId: string | null;
  slackChannelId: string | null;
  isActive: boolean;
}

export interface WorkflowRulesRepository {
  list(): Promise<WorkflowRule[]>;
  upsert(rule: WorkflowRuleInput): Promise<WorkflowRule>;
}

function mapRow(row: Record<string, any>): WorkflowRule {
  return {
    department: String(row.department),
    approverSlackId: row.approver_slack_id ?? null,
    stampOperatorSlackId: row.stamp_operator_slack_id ?? null,
    managerSlackId: row.manager_slack_id ?? null,
    slackChannelId: row.slack_channel_id ?? null,
    isActive: row.is_active !== false
  };
}

export class PgWorkflowRulesRepository implements WorkflowRulesRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(): Promise<WorkflowRule[]> {
    try {
      const r = await this.database.query(
        `SELECT department, approver_slack_id, stamp_operator_slack_id, manager_slack_id,
                slack_channel_id, COALESCE(is_active, true) AS is_active
           FROM department_workflow_rules
          ORDER BY department`
      );
      return r.rows.map(mapRow);
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return [];
      throw error;
    }
  }

  async upsert(rule: WorkflowRuleInput): Promise<WorkflowRule> {
    const r = await this.database.query(
      `INSERT INTO department_workflow_rules
         (department, approver_slack_id, stamp_operator_slack_id, manager_slack_id, slack_channel_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (department) DO UPDATE SET
         approver_slack_id = EXCLUDED.approver_slack_id,
         stamp_operator_slack_id = EXCLUDED.stamp_operator_slack_id,
         manager_slack_id = EXCLUDED.manager_slack_id,
         slack_channel_id = EXCLUDED.slack_channel_id,
         is_active = EXCLUDED.is_active
       RETURNING department, approver_slack_id, stamp_operator_slack_id, manager_slack_id,
                 slack_channel_id, COALESCE(is_active, true) AS is_active`,
      [rule.department, rule.approverSlackId ?? null, rule.stampOperatorSlackId ?? null,
       rule.managerSlackId ?? null, rule.slackChannelId ?? null, rule.isActive ?? true]
    );
    return mapRow(r.rows[0]);
  }
}

export class MemoryWorkflowRulesRepository implements WorkflowRulesRepository {
  private readonly rules = new Map<string, WorkflowRule>();
  constructor(seed: WorkflowRule[] = [], private readonly forbidden = false) {
    for (const r of seed) this.rules.set(r.department, r);
  }
  async list() {
    return [...this.rules.values()].sort((a, b) => a.department.localeCompare(b.department, "ja"));
  }
  async upsert(rule: WorkflowRuleInput): Promise<WorkflowRule> {
    if (this.forbidden) { const e = new Error("forbidden"); (e as { code?: string }).code = "42501"; throw e; }
    const next: WorkflowRule = {
      department: rule.department,
      approverSlackId: rule.approverSlackId ?? null,
      stampOperatorSlackId: rule.stampOperatorSlackId ?? null,
      managerSlackId: rule.managerSlackId ?? null,
      slackChannelId: rule.slackChannelId ?? null,
      isActive: rule.isActive ?? true
    };
    this.rules.set(next.department, next);
    return next;
  }
}
