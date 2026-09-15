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
  /** 著作権表示・第三者権利（A-027）。出版条件書の一覧に出る。 */
  copyrightNotice?: string | null;
  thirdPartyRights?: string | null;
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

export interface WorkPatch {
  title?: string;
  titleKana?: string | null;
  kind?: WorkKind;
  businessLine?: string | null;
  status?: WorkStatus;
  remarks?: string | null;
  copyrightNotice?: string | null;
  thirdPartyRights?: string | null;
}

export interface WorkPartPatch {
  name?: string;
  partType?: string;
  royaltyBearing?: boolean;
  remarks?: string | null;
  partNo?: number;
}

const WORK_COLUMNS: Record<keyof WorkPatch, string> = {
  title: "title", titleKana: "title_kana", kind: "kind", businessLine: "business_line",
  status: "status", remarks: "remarks",
  copyrightNotice: "copyright_notice", thirdPartyRights: "third_party_rights"
};
const PART_COLUMNS: Record<keyof WorkPartPatch, string> = {
  name: "name", partType: "part_type", royaltyBearing: "royalty_bearing",
  remarks: "remarks", partNo: "part_no"
};

/** 原作（Core Logic）と作品の親子。関係の種類は1つに固定する。 */
const SOURCE_RELATION = "derivative";

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
          `INSERT INTO works (work_code, title, title_kana, kind, business_line, status, remarks,
                              copyright_notice, third_party_rights)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, work_code`,
          [code, title, input.titleKana ?? null, kind, input.businessLine ?? null,
           input.status ?? "planning", input.remarks ?? null,
           input.copyrightNotice ?? null, input.thirdPartyRights ?? null]);
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

  /** 作品の本体の編集。題名・カナ・種別・事業区分・状態・備考。 */
  async update(id: number, patch: WorkPatch, actor: string): Promise<{ id: number }> {
    const entries = (Object.keys(patch) as Array<keyof WorkPatch>)
      .filter((key) => patch[key] !== undefined)
      .map((key) => ({ column: WORK_COLUMNS[key], value: patch[key] as unknown }));
    if (!entries.length) throw new DomainError("VALIDATION", "変更する項目がありません");
    if (patch.title !== undefined && !String(patch.title).trim()) {
      throw new DomainError("VALIDATION", "作品名は必須です");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        await this.requireWork(client, id);
        const sets = entries.map((e, i) => `${e.column} = $${i + 2}`).join(", ");
        await client.query(
          `UPDATE works SET ${sets}, updated_at = now() WHERE id = $1`,
          [id, ...entries.map((e) => e.value)]);
        await recordAudit(client, {
          actor, action: "work.update", targetType: "work", targetId: id, detail: { patch }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 原作（Core Logic）の付け替え。
   *
   * 原作 N に対して作品 N。この作品の「親」の集合を、渡されたものに置き換える。
   * 自分自身や、自分の子孫を親にはできない（系譜が輪になる）。
   */
  async setSources(id: number, parentIds: number[], actor: string): Promise<{ id: number; sources: number[] }> {
    const wanted = [...new Set(parentIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    try {
      return await inTransaction(this.database, async (client) => {
        await this.requireWork(client, id);
        if (wanted.includes(id)) throw new DomainError("VALIDATION", "自分自身を原作にはできません");
        if (wanted.length) {
          const found = await client.query(
            "SELECT id FROM works WHERE id = ANY($1::bigint[])", [wanted]);
          const known = new Set((found.rows as Array<{ id: unknown }>).map((r) => Number(r.id)));
          const missing = wanted.filter((p) => !known.has(p));
          if (missing.length) {
            throw new DomainError("NOT_FOUND", `作品 ${missing.join("・")} が見つかりません`);
          }
          // 輪の検査。候補の親から上へ辿って、この作品に戻ってきたら輪。
          const loop = await client.query(
            `WITH RECURSIVE up AS (
               SELECT parent_work_id AS wid, 0 AS depth FROM work_lineage
                WHERE child_work_id = ANY($1::bigint[])
               UNION
               SELECT l.parent_work_id, up.depth + 1 FROM work_lineage l
                 JOIN up ON l.child_work_id = up.wid
                WHERE up.depth < 20
             )
             SELECT 1 FROM up WHERE wid = $2 LIMIT 1`, [wanted, id]);
          if (loop.rows[0]) {
            throw new DomainError("VALIDATION",
              "その作品はこの作品から派生しているので、原作にはできません（系譜が輪になります）");
          }
        }
        await client.query(
          "DELETE FROM work_lineage WHERE child_work_id = $1 AND relation_type = $2",
          [id, SOURCE_RELATION]);
        for (const parent of wanted) {
          await client.query(
            `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [parent, id, SOURCE_RELATION]);
        }
        await recordAudit(client, {
          actor, action: "work.set_sources", targetType: "work", targetId: id,
          detail: { sources: wanted }
        });
        return { id, sources: wanted };
      });
    } catch (error) { throw translate(error); }
  }

  async updatePart(
    workId: number, partId: number, patch: WorkPartPatch, actor: string
  ): Promise<{ id: number }> {
    const entries = (Object.keys(patch) as Array<keyof WorkPartPatch>)
      .filter((key) => patch[key] !== undefined)
      .map((key) => ({ column: PART_COLUMNS[key], value: patch[key] as unknown }));
    if (!entries.length) throw new DomainError("VALIDATION", "変更する項目がありません");
    if (patch.name !== undefined && !String(patch.name).trim()) {
      throw new DomainError("VALIDATION", "パート名は必須です");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        await this.requirePart(client, workId, partId);
        const sets = entries.map((e, i) => `${e.column} = $${i + 3}`).join(", ");
        await client.query(
          `UPDATE work_parts SET ${sets} WHERE id = $1 AND work_id = $2`,
          [partId, workId, ...entries.map((e) => e.value)]);
        await recordAudit(client, {
          actor, action: "work.update_part", targetType: "work", targetId: workId,
          detail: { partId, patch }
        });
        return { id: partId };
      });
    } catch (error) { throw translate(error); }
  }

  /** パートの削除。条件がそのパートを指していれば消さない。 */
  async removePart(workId: number, partId: number, actor: string): Promise<{ deleted: true }> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.requirePart(client, workId, partId);
        const used = await client.query(
          "SELECT count(*)::int AS n FROM conditions WHERE work_part_id = $1", [partId]);
        const n = Number((used.rows[0] as { n: number }).n);
        if (n > 0) {
          throw new DomainError("CONFLICT",
            `このパートを指している条件が ${n} 件あるので削除できません。先に条件側を直してください`);
        }
        await client.query("DELETE FROM work_parts WHERE id = $1 AND work_id = $2", [partId, workId]);
        await recordAudit(client, {
          actor, action: "work.remove_part", targetType: "work", targetId: workId, detail: { partId }
        });
        return { deleted: true };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 作品の終了（削除の1段目）。状態を archived にする。一覧の既定から消える。
   * 条件や文書からは今までどおり辿れる。
   */
  async archive(id: number, reason: string, actor: string): Promise<{ id: number }> {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "終了にする理由は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const work = await this.requireWork(client, id);
        if (work.status === "archived") throw new DomainError("CONFLICT", "すでに終了しています");
        await client.query(
          `UPDATE works
              SET status = 'archived',
                  remarks = concat_ws(E'\n', NULLIF(remarks, ''), $2::text),
                  updated_at = now()
            WHERE id = $1`, [id, `終了：${why}`]);
        await recordAudit(client, {
          actor, action: "work.archive", targetType: "work", targetId: id,
          detail: { reason: why, was: work.status }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 作品の削除（2段目）。終了にしてあるものだけ。
   * 条件（無効化済みも含む）が指していれば消さない。パートと系譜は作品の
   * 一部なので一緒に消える（ON DELETE CASCADE）。
   */
  async remove(id: number, actor: string): Promise<{ deleted: true; workCode: string | null }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const work = await this.requireWork(client, id);
        if (work.status !== "archived") {
          throw new DomainError("VALIDATION",
            "先に終了にしてください（終了 → 削除の2段階）");
        }
        const used = await client.query(
          `SELECT
             (SELECT count(*)::int FROM conditions WHERE work_id = $1) AS conditions,
             (SELECT count(*)::int FROM conditions c
                JOIN work_parts p ON p.id = c.work_part_id WHERE p.work_id = $1) AS part_refs,
             (SELECT count(*)::int FROM work_lineage WHERE parent_work_id = $1) AS children`,
          [id]);
        const row = used.rows[0] as Record<string, number>;
        const blockers = [
          { target: "条件", rows: Number(row.conditions ?? 0) },
          { target: "パートを指す条件", rows: Number(row.part_refs ?? 0) },
          { target: "この作品を原作にしている作品", rows: Number(row.children ?? 0) }
        ].filter((b) => b.rows > 0);
        if (blockers.length) {
          throw new DomainError("CONFLICT",
            "この作品を指しているものがあるので削除できません：" +
            blockers.map((b) => `${b.target} ${b.rows} 件`).join("、"));
        }
        await client.query("DELETE FROM works WHERE id = $1", [id]);
        await recordAudit(client, {
          actor, action: "work.delete", targetType: "work", targetId: id,
          detail: { workCode: work.work_code, title: work.title }
        });
        return { deleted: true, workCode: work.work_code };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 作品の統合。id を intoId にまとめる。
   *
   * 移行データには同じ作品が表記違いで何本も入っている。条件・パート・系譜を
   * 残す側へ付け替え、まとめられた側は終了にして統合先を記録する（取引先の
   * 統合と同じ持ち方）。行は消さない。古い番号で探した人が、どこへ行ったかを
   * 辿れるようにする。
   *
   * 付け替えるもの
   *   条件      work_id を先へ（無効化・旧版も含めて全部。指す先を失わせない）
   *   パート    先の末尾に番号を振り直して移す。条件の work_part_id はそのまま生きる
   *   系譜      こちらの親は先の親に、こちらの子は先の子に。自分自身への輪は落とす
   *
   * 系譜で繋がっている2つ（親と子）はまとめない。子を親にまとめると、子の
   * 子が親の子になるだけで済むように見えるが、親の親がこちらだった場合に輪に
   * なる。関係のある2つは、先に系譜を外してからまとめてもらう。
   */
  async merge(id: number, intoId: number, actor: string): Promise<{
    id: number; intoId: number; moved: { conditions: number; parts: number; lineage: number };
  }> {
    if (id === intoId) throw new DomainError("VALIDATION", "同じ作品にはまとめられません");
    try {
      return await inTransaction(this.database, async (client) => {
        const source = await this.requireWork(client, id);
        const target = await this.requireWork(client, intoId);
        if (source.merged_into_id) {
          throw new DomainError("CONFLICT", "この作品はすでに別の作品にまとめてあります");
        }
        if (target.merged_into_id) {
          throw new DomainError("CONFLICT", "統合先がすでに別の作品にまとめられています。その先を選んでください");
        }
        if (target.status === "archived") {
          throw new DomainError("VALIDATION", "終了した作品にはまとめられません。残す側を選んでください");
        }
        const related = await client.query(
          `WITH RECURSIVE up AS (
             SELECT parent_work_id AS wid, 1 AS depth FROM work_lineage WHERE child_work_id = $1
             UNION
             SELECT l.parent_work_id, up.depth + 1 FROM work_lineage l JOIN up ON l.child_work_id = up.wid
              WHERE up.depth < 20
           ), down AS (
             SELECT child_work_id AS wid, 1 AS depth FROM work_lineage WHERE parent_work_id = $1
             UNION
             SELECT l.child_work_id, down.depth + 1 FROM work_lineage l JOIN down ON l.parent_work_id = down.wid
              WHERE down.depth < 20
           )
           SELECT 1 FROM up WHERE wid = $2
           UNION ALL
           SELECT 1 FROM down WHERE wid = $2
           LIMIT 1`, [id, intoId]);
        if (related.rows[0]) {
          throw new DomainError("VALIDATION",
            "系譜で繋がっている作品どうしはまとめられません。先に原作の付け外しで系譜を切ってください");
        }

        const conditions = await client.query(
          "UPDATE conditions SET work_id = $2, updated_at = now() WHERE work_id = $1", [id, intoId]);
        const parts = await client.query(
          `UPDATE work_parts SET work_id = $2,
                  part_no = part_no + (SELECT COALESCE(max(part_no), 0) FROM work_parts WHERE work_id = $2)
            WHERE work_id = $1`, [id, intoId]);
        // 系譜。先と同じ行があれば ON CONFLICT で吸収し、自分自身への輪は入れない。
        const parents = await client.query(
          `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type)
           SELECT parent_work_id, $2, relation_type FROM work_lineage
            WHERE child_work_id = $1 AND parent_work_id <> $2
           ON CONFLICT DO NOTHING`, [id, intoId]);
        const children = await client.query(
          `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type)
           SELECT $2, child_work_id, relation_type FROM work_lineage
            WHERE parent_work_id = $1 AND child_work_id <> $2
           ON CONFLICT DO NOTHING`, [id, intoId]);
        await client.query(
          "DELETE FROM work_lineage WHERE parent_work_id = $1 OR child_work_id = $1", [id]);

        await client.query(
          `UPDATE works
              SET status = 'archived', merged_into_id = $2,
                  remarks = concat_ws(E'\n', NULLIF(remarks, ''), $3::text),
                  updated_at = now()
            WHERE id = $1`,
          [id, intoId, `統合：→ ${target.work_code ?? `#${intoId}`} ${target.title}`]);

        const moved = {
          conditions: conditions.rowCount ?? 0, parts: parts.rowCount ?? 0,
          lineage: (parents.rowCount ?? 0) + (children.rowCount ?? 0)
        };
        await recordAudit(client, {
          actor, action: "work.merge", targetType: "work", targetId: id,
          detail: { intoId, intoCode: target.work_code, moved }
        });
        await recordAudit(client, {
          actor, action: "work.merge_in", targetType: "work", targetId: intoId,
          detail: { fromId: id, fromCode: source.work_code, moved }
        });
        return { id, intoId, moved };
      });
    } catch (error) { throw translate(error); }
  }

  private async requireWork(client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, id: number) {
    const r = await client.query(
      "SELECT id, work_code, title, status, merged_into_id FROM works WHERE id = $1 FOR UPDATE", [id]);
    const row = r.rows[0] as { id: number; work_code: string | null; title: string; status: string;
                               merged_into_id: number | null } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `作品 ${id} が見つかりません`);
    return row;
  }

  private async requirePart(client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, workId: number, partId: number) {
    const r = await client.query(
      "SELECT id FROM work_parts WHERE id = $1 AND work_id = $2 FOR UPDATE", [partId, workId]);
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", `パート ${partId} が見つかりません`);
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
