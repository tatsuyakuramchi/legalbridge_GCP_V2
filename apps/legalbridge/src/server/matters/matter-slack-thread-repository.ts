import type { DatabasePool } from "../db/pool.js";

// 案件ごとの Slack スレッド（1案件=1スレッド）。隔離テーブル
// lb_v2_matter_slack_threads（grant 024）。V1 の matter_slack_threads 相当だが
// 既存業務テーブルには触れず lb_v2_ 接頭辞で分離する。

export interface MatterSlackThreadRecord {
  matterId: number;
  channelId: string;
  threadTs: string;
  rootText: string;
  createdBy: string;
  createdAt: string;
}

export interface MatterSlackThreadCreate {
  matterId: number;
  channelId: string;
  threadTs: string;
  rootText: string;
  createdBy: string;
}

export interface MatterSlackThreadRepository {
  findByMatter(matterId: number): Promise<MatterSlackThreadRecord | null>;
  // スレッドを記録する。既存（同一 matter）はそのまま返す＝冪等（1案件1スレッド）。
  create(entry: MatterSlackThreadCreate): Promise<MatterSlackThreadRecord>;
}

const COLUMNS = `matter_id, channel_id, thread_ts, root_text, created_by, created_at`;

function mapRow(row: Record<string, any>): MatterSlackThreadRecord {
  return {
    matterId: Number(row.matter_id),
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    rootText: row.root_text,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export class PgMatterSlackThreadRepository implements MatterSlackThreadRepository {
  constructor(private readonly database: DatabasePool) {}

  async findByMatter(matterId: number) {
    const result = await this.database.query(
      `SELECT ${COLUMNS} FROM lb_v2_matter_slack_threads WHERE matter_id = $1 LIMIT 1`,
      [matterId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async create(entry: MatterSlackThreadCreate) {
    await this.database.query(
      `INSERT INTO lb_v2_matter_slack_threads (matter_id, channel_id, thread_ts, root_text, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (matter_id) DO NOTHING`,
      [entry.matterId, entry.channelId, entry.threadTs, entry.rootText, entry.createdBy]
    );
    const record = await this.findByMatter(entry.matterId);
    if (!record) throw new Error("matter slack thread failed to persist");
    return record;
  }
}

export class MemoryMatterSlackThreadRepository implements MatterSlackThreadRepository {
  constructor(private readonly records: MatterSlackThreadRecord[] = []) {}

  async findByMatter(matterId: number) {
    return this.records.find((r) => r.matterId === matterId) ?? null;
  }

  async create(entry: MatterSlackThreadCreate) {
    const existing = this.records.find((r) => r.matterId === entry.matterId);
    if (existing) return existing;
    const record: MatterSlackThreadRecord = {
      matterId: entry.matterId,
      channelId: entry.channelId,
      threadTs: entry.threadTs,
      rootText: entry.rootText,
      createdBy: entry.createdBy,
      createdAt: new Date().toISOString()
    };
    this.records.push(record);
    return record;
  }
}

// ── メンション候補（staff.slack_user_id）─────────────────────────────────────

export interface MatterMentionCandidate {
  name: string;
  id: string;   // slack_user_id
}

export interface MatterMentionRepository {
  listCandidates(): Promise<MatterMentionCandidate[]>;
  // 指定 slack_user_id のメール（Drive 権限付与用・存在するものだけ）。
  emailsForSlackIds(ids: string[]): Promise<Array<{ id: string; email: string }>>;
}

export class PgMatterMentionRepository implements MatterMentionRepository {
  constructor(private readonly database: DatabasePool) {}

  async listCandidates() {
    const result = await this.database.query(
      `SELECT staff_name, slack_user_id
         FROM staff
        WHERE slack_user_id IS NOT NULL AND btrim(slack_user_id) <> ''
        ORDER BY staff_name`
    );
    return result.rows.map((row) => ({ name: row.staff_name, id: row.slack_user_id }));
  }

  async emailsForSlackIds(ids: string[]) {
    if (!ids.length) return [];
    const result = await this.database.query(
      `SELECT slack_user_id, email FROM staff
        WHERE slack_user_id = ANY($1::text[]) AND email IS NOT NULL AND btrim(email) <> ''`,
      [ids]
    );
    return result.rows.map((row) => ({ id: row.slack_user_id, email: row.email }));
  }
}

export class MemoryMatterMentionRepository implements MatterMentionRepository {
  constructor(
    private readonly candidates: MatterMentionCandidate[] = [],
    private readonly emails: Array<{ id: string; email: string }> = []
  ) {}

  async listCandidates() { return this.candidates; }
  async emailsForSlackIds(ids: string[]) {
    const set = new Set(ids);
    return this.emails.filter((e) => set.has(e.id));
  }
}
