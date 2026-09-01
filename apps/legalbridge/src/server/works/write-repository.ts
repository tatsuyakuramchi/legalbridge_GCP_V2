import type { DatabasePool } from "../db/pool.js";
import type { WorkCreateInput, WorkUpdateInput, WorkRelationCreateInput } from "./write-schema.js";

export interface SavedWork { id: number; workCode: string | null; }
export interface WorkRecord {
  id: number; title: string; workCode: string | null;
  ledgerCode: string | null; remarks: string | null; isActive: boolean;
  titleKana: string | null; workType: string | null; kind: string | null;
  derivationType: string | null; isOriginal: boolean | null;
  parentWorkId: number | null; rightsHolderVendorId: number | null;
  creatorName: string | null; publisherName: string | null;
}

export class WorkWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface SavedRelation { childWorkId: number; parentWorkId: number; created: boolean; }
export interface WorkWriteRepository {
  create(input: WorkCreateInput): Promise<SavedWork>;
  update(id: number, input: WorkUpdateInput): Promise<SavedWork>;
  find(id: number): Promise<WorkRecord | null>;
  addRelation(input: WorkRelationCreateInput): Promise<SavedRelation>;
}

const COLUMNS: Record<string, string> = {
  title: "title", workCode: "work_code", ledgerCode: "ledger_code",
  remarks: "remarks", isActive: "is_active",
  titleKana: "title_kana", workType: "work_type", status: "status", kind: "kind",
  derivationType: "derivation_type", isOriginal: "is_original",
  parentWorkId: "parent_work_id", rightsHolderVendorId: "rights_holder_vendor_id",
  creatorName: "creator_name", publisherName: "publisher_name"
};

export class PgWorkWriteRepository implements WorkWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async create(input: WorkCreateInput) {
    // 23505（一意制約違反）は2系統ある：
    //   works_pkey … id 連番が既存データより後ろ（V1移行が明示idでINSERTした行など）。
    //                連番を MAX(id) に合わせて1回だけ自動再試行（自己修復）。
    //   work_code … コードの重複。利用者に返す。
    let retriedAfterSequenceFix = false;
    for (;;) {
      try {
        return await this.insertOnce(input);
      } catch (error) {
        const pgError = error as { code?: string; constraint?: string };
        if (!retriedAfterSequenceFix && pgError?.code === "23505" &&
            String(pgError.constraint ?? "").includes("pkey")) {
          retriedAfterSequenceFix = true;
          await this.database.query(
            `SELECT setval(pg_get_serial_sequence('works','id'),
                           GREATEST((SELECT COALESCE(MAX(id), 1) FROM works), 1))`);
          continue;
        }
        throw translate(error);
      }
    }
  }

  private async insertOnce(input: WorkCreateInput): Promise<SavedWork> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const columns: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        columns.push(column); values.push(value);
      }
      const hasCode = columns.includes("work_code");
      if (!hasCode) {
        // 仮コードは毎回ユニークにする。固定 'PENDING' だと同時作成や過去の残骸と
        // 衝突し「作品コードが既に存在します」で新規登録が塞がる。
        columns.push("work_code");
        values.push(`PENDING-${Date.now().toString(36)}-${Math.floor(Math.random() * 1679616).toString(36)}`);
      }
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const inserted = await client.query(
        `INSERT INTO works (${columns.join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING id, work_code`,
        values
      );
      const id = Number(inserted.rows[0].id);
      let workCode: string | null = inserted.rows[0].work_code ?? null;
      if (!hasCode) {
        // lpad は対象が桁数より長いと「先頭で切り詰める」。本番の id は移行時の
        // setval で10億番台のため、固定5桁だと全行が 'WRK-10000' に潰れて2件目
        // 以降が一意制約違反になっていた（実障害）。桁数は id の長さと5の大きい方。
        const numbered = await client.query(
          `UPDATE works SET work_code = 'WRK-' || lpad(id::text, GREATEST(length(id::text), 5), '0')
            WHERE id = $1 RETURNING work_code`, [id]);
        workCode = numbered.rows[0]?.work_code ?? workCode;
      }
      await client.query("COMMIT");
      return { id, workCode };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 系譜の閉路防止：新しい親が自分自身、または自分の子孫であってはならない。
  private async assertNoCycle(id: number, parentWorkId: number) {
    if (parentWorkId === id) {
      throw new WorkWriteError("WORK_LINEAGE_CYCLE", "作品を自身の親に設定できません");
    }
    // 深さ上限つき（読取側と同じ防御・監査④）：V1時代に混入済みの parent_work_id
    // 循環データが系譜上にあると、無制限の再帰は保存リクエストをハングさせる。
    const result = await this.database.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_work_id, 1 AS depth FROM works WHERE id = $1
         UNION ALL
         SELECT w.id, w.parent_work_id, up.depth + 1
           FROM works w JOIN up ON w.id = up.parent_work_id
          WHERE up.depth < 50
       )
       SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
      [parentWorkId, id]
    );
    if (result.rows.length) {
      throw new WorkWriteError("WORK_LINEAGE_CYCLE", "系譜が循環するため、その親は設定できません");
    }
  }

  async update(id: number, input: WorkUpdateInput) {
    if (typeof input.parentWorkId === "number") await this.assertNoCycle(id, input.parentWorkId);
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      // works.kind は NOT NULL DEFAULT 'own'。null は「変更しない」として無視する
      // （従来は 23502 →「必須項目が不足しています」で保存不能になっていた・監査④）。
      if (key === "kind" && value === null) continue;
      values.push(value); assignments.push(`${column} = $${values.length}`);
    }
    if (!assignments.length) {
      // kind: null 単独などで更新対象が消えた場合は現状返し（no-op）。
      const current = await this.find(id);
      if (!current) throw new WorkWriteError("WORK_NOT_FOUND", "指定した作品が見つかりません");
      return { id: current.id, workCode: current.workCode ?? null };
    }
    values.push(id);
    try {
      const result = await this.database.query(
        `UPDATE works SET ${assignments.join(", ")} WHERE id = $${values.length}
         RETURNING id, work_code`, values);
      if (!result.rows[0]) throw new WorkWriteError("WORK_NOT_FOUND", "指定した作品が見つかりません");
      return { id: Number(result.rows[0].id), workCode: result.rows[0].work_code ?? null };
    } catch (error) { throw translate(error); }
  }

  async find(id: number) {
    const result = await this.database.query(
      `SELECT id, title, work_code, ledger_code, remarks, is_active, title_kana, work_type,
              kind, derivation_type, is_original, parent_work_id, rights_holder_vendor_id,
              creator_name, publisher_name
         FROM works WHERE id = $1`, [id]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id), title: String(row.title ?? ""), workCode: row.work_code ?? null,
      ledgerCode: row.ledger_code ?? null, remarks: row.remarks ?? null, isActive: Boolean(row.is_active),
      titleKana: row.title_kana ?? null, workType: row.work_type ?? null, kind: row.kind ?? null,
      derivationType: row.derivation_type ?? null,
      isOriginal: row.is_original === null || row.is_original === undefined ? null : Boolean(row.is_original),
      parentWorkId: row.parent_work_id === null || row.parent_work_id === undefined ? null : Number(row.parent_work_id),
      rightsHolderVendorId: row.rights_holder_vendor_id === null || row.rights_holder_vendor_id === undefined ? null : Number(row.rights_holder_vendor_id),
      creatorName: row.creator_name ?? null, publisherName: row.publisher_name ?? null
    };
  }

  async addRelation(input: WorkRelationCreateInput) {
    // parent_work_id 系譜と整合させ、閉路（親が子の子孫）を防ぐ。
    await this.assertNoCycle(input.childWorkId, input.parentWorkId);
    try {
      const result = await this.database.query(
        `INSERT INTO work_relations (child_work_id, parent_work_id, relation_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (child_work_id, parent_work_id) DO NOTHING
         RETURNING child_work_id`,
        [input.childWorkId, input.parentWorkId, input.relationType]
      );
      return { childWorkId: input.childWorkId, parentWorkId: input.parentWorkId, created: result.rows.length > 0 };
    } catch (error) { throw translate(error); }
  }
}

function translate(error: unknown): Error {
  if (error instanceof WorkWriteError) return error;
  const code = (error as { code?: string })?.code;
  const constraint = String((error as { constraint?: string })?.constraint ?? "");
  if (code === "23505") {
    // どの一意制約かで意味が違う。id（自動再試行後も衝突）は採番異常として区別する。
    return constraint.includes("pkey")
      ? new WorkWriteError("WORK_ID_CONFLICT", "作品IDの採番が既存データと衝突しました。もう一度お試しください（続く場合は管理者へ）")
      : new WorkWriteError("WORK_CONFLICT", "作品コードが既に存在します");
  }
  if (code === "23502") return new WorkWriteError("WORK_REQUIRED", "必須項目が不足しています");
  if (code === "23503") return new WorkWriteError("WORK_INVALID_REF", "指定した作品が存在しません");
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryWorkWriteRepository implements WorkWriteRepository {
  private seq = 0;
  readonly works = new Map<number, WorkRecord>();
  async create(input: WorkCreateInput) {
    const id = ++this.seq;
    const workCode = input.workCode ?? `WRK-${String(id).padStart(5, "0")}`;
    this.works.set(id, {
      id, title: input.title, workCode, ledgerCode: input.ledgerCode ?? null,
      remarks: input.remarks ?? null, isActive: input.isActive,
      titleKana: input.titleKana ?? null, workType: input.workType ?? null, kind: input.kind ?? null,
      derivationType: input.derivationType ?? null, isOriginal: input.isOriginal ?? null,
      parentWorkId: input.parentWorkId ?? null, rightsHolderVendorId: input.rightsHolderVendorId ?? null,
      creatorName: input.creatorName ?? null, publisherName: input.publisherName ?? null
    });
    return { id, workCode };
  }
  async update(id: number, input: WorkUpdateInput) {
    const existing = this.works.get(id);
    if (!existing) throw new WorkWriteError("WORK_NOT_FOUND", "指定した作品が見つかりません");
    if (typeof input.parentWorkId === "number") {
      if (input.parentWorkId === id) throw new WorkWriteError("WORK_LINEAGE_CYCLE", "作品を自身の親に設定できません");
      // 新親から根へ遡り、自分に到達したら循環。
      let cursor: number | null = input.parentWorkId;
      const seen = new Set<number>();
      while (cursor != null && !seen.has(cursor)) {
        if (cursor === id) throw new WorkWriteError("WORK_LINEAGE_CYCLE", "系譜が循環するため、その親は設定できません");
        seen.add(cursor);
        cursor = this.works.get(cursor)?.parentWorkId ?? null;
      }
    }
    // Pg 実装と同じく kind: null は「変更しない」（works.kind は NOT NULL DEFAULT 'own'）。
    const patch: Record<string, unknown> = { ...input };
    if (patch.kind === null) delete patch.kind;
    Object.assign(existing, patch);
    return { id, workCode: existing.workCode };
  }
  async find(id: number) { return this.works.get(id) ?? null; }
  readonly relations: Array<{ childWorkId: number; parentWorkId: number; relationType: string }> = [];
  async addRelation(input: WorkRelationCreateInput) {
    if (input.childWorkId === input.parentWorkId) throw new WorkWriteError("WORK_LINEAGE_CYCLE", "作品を自身の派生元にできません");
    // 親が子の子孫（parent_work_id 系譜）なら循環。
    let cursor: number | null = input.parentWorkId;
    const seen = new Set<number>();
    while (cursor != null && !seen.has(cursor)) {
      if (cursor === input.childWorkId) throw new WorkWriteError("WORK_LINEAGE_CYCLE", "系譜が循環するため、その派生元は設定できません");
      seen.add(cursor);
      cursor = this.works.get(cursor)?.parentWorkId ?? null;
    }
    const exists = this.relations.some((r) => r.childWorkId === input.childWorkId && r.parentWorkId === input.parentWorkId);
    if (!exists) this.relations.push({ childWorkId: input.childWorkId, parentWorkId: input.parentWorkId, relationType: input.relationType });
    return { childWorkId: input.childWorkId, parentWorkId: input.parentWorkId, created: !exists };
  }
}
