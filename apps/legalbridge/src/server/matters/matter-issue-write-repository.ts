import type { DatabasePool } from "../db/pool.js";
import { MatterWriteError } from "./write-repository.js";

// 案件⇄Backlog課題の紐付け編集（matter_issues）。grant 025 で INSERT/UPDATE/DELETE。
// attach は UPSERT（既存は relation 等を更新）、detach は解除のみ（課題自体は消さない）。

export const MATTER_ISSUE_RELATIONS = ["primary", "duplicate", "partial", "related"] as const;
export type MatterIssueRelation = typeof MATTER_ISSUE_RELATIONS[number];

export interface MatterIssueLinkInput {
  backlogIssueKey: string;
  relation: MatterIssueRelation;
  summarySnapshot?: string | null;
  note?: string | null;
}

export interface MatterIssueLink {
  matterId: number;
  backlogIssueKey: string;
  relation: string;
  summarySnapshot: string | null;
  note: string | null;
}

export interface MatterIssueWriteRepository {
  attach(matterId: number, input: MatterIssueLinkInput): Promise<MatterIssueLink>;
  detach(matterId: number, backlogIssueKey: string): Promise<boolean>;
}

// DB権限不足（grant 025 未適用）を分かりやすいエラーへ翻訳する。
function translate(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code === "42501") {
    throw new MatterWriteError("MATTER_ISSUE_GRANT_MISSING", "matter_issues への権限がありません（grant 025 未適用）");
  }
  if (code === "23503") {
    throw new MatterWriteError("MATTER_NOT_FOUND", "案件が存在しません");
  }
  throw error as Error;
}

export class PgMatterIssueWriteRepository implements MatterIssueWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async attach(matterId: number, input: MatterIssueLinkInput) {
    try {
      const result = await this.database.query(
        `INSERT INTO matter_issues (matter_id, backlog_issue_key, relation, summary_snapshot, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (matter_id, backlog_issue_key)
           DO UPDATE SET relation = EXCLUDED.relation,
                         summary_snapshot = COALESCE(EXCLUDED.summary_snapshot, matter_issues.summary_snapshot),
                         note = COALESCE(EXCLUDED.note, matter_issues.note)
         RETURNING matter_id, backlog_issue_key, relation, summary_snapshot, note`,
        [matterId, input.backlogIssueKey, input.relation, input.summarySnapshot ?? null, input.note ?? null]
      );
      await this.database.query(`UPDATE matters SET updated_at = now() WHERE id = $1`, [matterId]);
      const row = result.rows[0];
      return {
        matterId: Number(row.matter_id), backlogIssueKey: row.backlog_issue_key,
        relation: row.relation, summarySnapshot: row.summary_snapshot, note: row.note
      };
    } catch (error) {
      return translate(error);
    }
  }

  async detach(matterId: number, backlogIssueKey: string) {
    try {
      const result = await this.database.query(
        `DELETE FROM matter_issues WHERE matter_id = $1 AND backlog_issue_key = $2`,
        [matterId, backlogIssueKey]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      return translate(error);
    }
  }
}

export class MemoryMatterIssueWriteRepository implements MatterIssueWriteRepository {
  constructor(private readonly links: MatterIssueLink[] = []) {}

  async attach(matterId: number, input: MatterIssueLinkInput) {
    const existing = this.links.find((l) => l.matterId === matterId && l.backlogIssueKey === input.backlogIssueKey);
    if (existing) {
      existing.relation = input.relation;
      if (input.summarySnapshot != null) existing.summarySnapshot = input.summarySnapshot;
      if (input.note != null) existing.note = input.note;
      return existing;
    }
    const link: MatterIssueLink = {
      matterId, backlogIssueKey: input.backlogIssueKey, relation: input.relation,
      summarySnapshot: input.summarySnapshot ?? null, note: input.note ?? null
    };
    this.links.push(link);
    return link;
  }

  async detach(matterId: number, backlogIssueKey: string) {
    const idx = this.links.findIndex((l) => l.matterId === matterId && l.backlogIssueKey === backlogIssueKey);
    if (idx < 0) return false;
    this.links.splice(idx, 1);
    return true;
  }
}
