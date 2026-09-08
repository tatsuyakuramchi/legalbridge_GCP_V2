import { inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";

export type WorkKind = "own" | "source_ip" | "derivative";
export type WorkStatus = "planning" | "in_production" | "released" | "archived";

export interface WorkInput {
  title: string;
  kind?: WorkKind;
  titleKana?: string | null;
  businessLine?: string | null;
  status?: WorkStatus;
  remarks?: string | null;
  workCode?: string | null;
  /** 親作品。指定すると系譜に登録し、kind を derivative にする。 */
  parentWorkId?: number | null;
}

export interface WorkPartInput {
  name: string;
  partType?: string;
  royaltyBearing?: boolean;
  remarks?: string | null;
  /** 指定しなければ末尾に採番する。 */
  partNo?: number | null;
}

const NUMBER = { prefix: "WRK", table: "works", column: "work_code" };

export class WorkWriteService {
  constructor(private readonly database: Transactable) {}

  async create(input: WorkInput, actor: string): Promise<{ id: number; workCode: string | null }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "作品名は必須です");

    try {
      return await inTransaction(this.database, async (client) => {
        if (input.parentWorkId) {
          const parent = await client.query("SELECT id FROM works WHERE id = $1", [input.parentWorkId]);
          if (!parent.rows[0]) {
            throw new DomainError("NOT_FOUND", `親作品 ${input.parentWorkId} が見つかりません`);
          }
        }
        const code = String(input.workCode ?? "").trim() || await allocateNumber(client, NUMBER);
        const kind: WorkKind = input.kind ?? (input.parentWorkId ? "derivative" : "own");

        const inserted = await client.query(
          `INSERT INTO works (work_code, title, title_kana, kind, business_line, status, remarks)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, work_code`,
          [code, title, input.titleKana ?? null, kind, input.businessLine ?? null,
           input.status ?? "planning", input.remarks ?? null]);
        const row = inserted.rows[0] as { id: number; work_code: string | null };
        const id = Number(row.id);

        if (input.parentWorkId) {
          await client.query(
            `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type)
             VALUES ($1, $2, 'derivative') ON CONFLICT DO NOTHING`, [input.parentWorkId, id]);
        }

        await recordAudit(client, {
          actor, action: "work.create", targetType: "work", targetId: id,
          detail: { title, kind, workCode: row.work_code, parentWorkId: input.parentWorkId ?? null }
        });
        return { id, workCode: row.work_code };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 構成パートの追加。
   *
   * 権利の上限はパートの取得条件の積で決まるので、パートを足すことは
   * 「その作品で確認すべき権利が1つ増える」ことを意味する。監査に残す。
   */
  async addPart(
    workId: number, input: WorkPartInput, actor: string
  ): Promise<{ id: number; partNo: number }> {
    const name = String(input.name ?? "").trim();
    if (!name) throw new DomainError("VALIDATION", "パート名は必須です");

    try {
      return await inTransaction(this.database, async (client) => {
        const work = await client.query("SELECT id FROM works WHERE id = $1", [workId]);
        if (!work.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);

        let partNo = input.partNo ?? null;
        if (partNo === null) {
          const max = await client.query(
            "SELECT COALESCE(MAX(part_no), 0) + 1 AS n FROM work_parts WHERE work_id = $1", [workId]);
          partNo = Number((max.rows[0] as { n: number }).n);
        }

        const inserted = await client.query(
          `INSERT INTO work_parts (work_id, part_no, name, part_type, royalty_bearing, remarks)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [workId, partNo, name, input.partType ?? "unspecified",
           input.royaltyBearing !== false, input.remarks ?? null]);
        const id = Number((inserted.rows[0] as { id: number }).id);

        await recordAudit(client, {
          actor, action: "work.add_part", targetType: "work", targetId: workId,
          detail: { partId: id, partNo, name }
        });
        return { id, partNo: partNo as number };
      });
    } catch (error) { throw translate(error); }
  }
}
