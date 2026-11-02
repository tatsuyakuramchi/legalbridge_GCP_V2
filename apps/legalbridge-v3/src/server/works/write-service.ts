import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { upsertCredit } from "./credits.js";
import { allocateNumber } from "../core/numbering.js";

/** 作品の統合の下見（案件の統合と同じ形）。 */
export interface WorkMergeCounts {
  conditions: number; activeConditions: number; parts: number; editions: number; codes: number;
  credits: number; events: number; matters: number; links: number; lineage: number;
}
export interface WorkMergePreview {
  from: { id: number; workCode: string | null; title: string; kind: string; status: string };
  into: { id: number; workCode: string | null; title: string; kind: string; status: string };
  moves: WorkMergeCounts;
  /** 統合を止める理由。空なら実行できる。 */
  blockers: string[];
  /** 止めはしないが、確認のうえで進めるもの。 */
  warnings: string[];
}
/** 統合で動かしたもの。取り消しはこれを読んで付け戻す（監査 work.merge の detail.restore）。 */
interface MergeRestore {
  prevStatus: string;
  conditions: number[]; work_editions: number[]; ebook_work_codes: number[]; work_credits: number[];
  condition_events: number[]; matters: number[];
  parts: Array<{ id: number; partNo: number }>;
  links: Array<{ matterId: number }>;
  /** 先もすでに指していたので消した繋がり（取り消しで戻す）。 */
  linksDropped: Array<{ matterId: number }>;
  lineage: Array<{ parentId: number; childId: number; relationType: string }>;
  lineageAdded: Array<{ parentId: number; childId: number; relationType: string }>;
}
/** 2 つの作品が系譜で繋がっているか（$1 の上下 20 段に $2 が居るか）。 */
const LINEAGE_RELATED_SQL = `WITH RECURSIVE up AS (
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
           LIMIT 1`;

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
  /** 原作名（原著作物名。196）。空なら作品名と同じ。 */
  sourceTitle?: string | null;
}

export interface WorkPartInput {
  name: string;
  partType?: string;
  /** 役割（コア／サブ。A-078）。空なら種別から導く。 */
  partRole?: "core" | "sub" | null;
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
  /** 原作名（原著作物名。196）。空なら作品名と同じ。利用許諾計算書の件名に出る。 */
  sourceTitle?: string | null;
}

export interface WorkPartPatch {
  name?: string;
  partType?: string;
  partRole?: "core" | "sub" | null;
  royaltyBearing?: boolean;
  remarks?: string | null;
  partNo?: number;
}

const WORK_COLUMNS: Record<keyof WorkPatch, string> = {
  title: "title", titleKana: "title_kana", kind: "kind", businessLine: "business_line",
  status: "status", remarks: "remarks",
  copyrightNotice: "copyright_notice", thirdPartyRights: "third_party_rights",
  sourceTitle: "source_title"
};
const PART_COLUMNS: Record<keyof WorkPartPatch, string> = {
  partRole: "part_role",
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
        // 原作名（196）。入っているときだけ書く（196 の前の DB で、原作名なしの登録を止めない）。
        const sourceTitle = String(input.sourceTitle ?? "").trim();
        if (sourceTitle) await client.query("UPDATE works SET source_title = $2 WHERE id = $1", [id, sourceTitle]);

        if (input.parentWorkId) {
          await client.query(
            `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type)
             VALUES ($1, $2, 'derivative') ON CONFLICT DO NOTHING`, [input.parentWorkId, id]);
        }

        await recordAudit(client, {
          actor, action: "work.create", targetType: "work", targetId: id,
          detail: { title, kind, workCode: row.work_code, parentWorkId: input.parentWorkId ?? null }
        });
        // 著作権表示は履歴（A-031）で持つ。登録時の表記は初版の行。
        if (String(input.copyrightNotice ?? "").trim()) {
          await upsertCredit(client, id, {
            effectiveFrom: new Date().toISOString().slice(0, 10), edition: "初版",
            copyrightNotice: String(input.copyrightNotice), thirdPartyRights: input.thirdPartyRights ?? null
          }, actor);
        }
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
        // 著作権表示・第三者権利を直したら、今日から効く行として履歴（A-031）にも残す。
        // 列だけ直すと履歴と食い違い、次の同期で古い表記に戻る。
        if (patch.copyrightNotice !== undefined || patch.thirdPartyRights !== undefined) {
          const cur = await client.query(
            "SELECT copyright_notice, third_party_rights FROM works WHERE id = $1", [id]);
          const row = cur.rows[0] as { copyright_notice: string | null; third_party_rights: string | null } | undefined;
          if (row && String(row.copyright_notice ?? "").trim()) {
            await upsertCredit(client, id, {
              effectiveFrom: new Date().toISOString().slice(0, 10),
              copyrightNotice: String(row.copyright_notice), thirdPartyRights: row.third_party_rights
            }, actor);
          }
        }
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
   *   ほか      刊行物・製品（ISBN／JAN）、電子書籍の CID、クレジット表記、実績の作品、案件の作品
   *
   * 系譜で繋がっている2つ（親と子）はまとめない。子を親にまとめると、子の
   * 子が親の子になるだけで済むように見えるが、親の親がこちらだった場合に輪に
   * なる。関係のある2つは、先に系譜を外してからまとめてもらう。
   */
  async merge(id: number, intoId: number, actor: string): Promise<{
    id: number; intoId: number; moved: { conditions: number; parts: number; lineage: number } & Record<string, number>;
  }> {
    if (id === intoId) throw new DomainError("VALIDATION", "同じ作品にはまとめられません");
    try {
      return await inTransaction(this.database, (client) => this.mergeWithin(client, id, intoId, actor));
    } catch (error) { throw translate(error); }
  }

  /**
   * 原作を作品に畳む（docs/work-editions.md §8）。原作名は作品の項目の 1 つにする。
   * 子の作品が 1 つだけの原作を、その作品にまとめる：作品の原作名に原作の名前を入れ（空のときだけ）、
   * 原作と作品の系譜を外してから統合する（原作の条件・刊行物・パート・ほかの親子は作品へ）。
   * 子が 2 つ以上の原作は畳まない（原作の条件がどの作品の分か決まらない）。原作名を写すだけにする。
   */
  async foldSource(sourceId: number, actor: string): Promise<{ sourceId: number; intoId: number; sourceTitle: string }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const src = await this.requireWork(client, sourceId);
        if (src.kind !== "source_ip") throw new DomainError("VALIDATION", "原作（種別 原作）だけ畳めます");
        if (src.merged_into_id || src.status === "archived") throw new DomainError("VALIDATION", "終了・統合済みの原作は畳めません");
        const kids = (await client.query(
          `SELECT DISTINCT w.id, w.title FROM work_lineage l JOIN works w ON w.id = l.child_work_id
            WHERE l.parent_work_id = $1 AND w.status <> 'archived' AND w.merged_into_id IS NULL`, [sourceId])).rows as Array<{ id: number; title: string }>;
        if (kids.length !== 1) {
          throw new DomainError("VALIDATION", kids.length
            ? `この原作には作品が ${kids.length} つあります。畳めるのは作品が 1 つの原作だけです（原作名を作品に写すことはできます）`
            : "この原作には作品がありません。作品を繋ぐか、種別を作品に直してください");
        }
        const intoId = Number(kids[0].id);
        await client.query(
          "UPDATE works SET source_title = COALESCE(NULLIF(btrim(source_title), ''), $2), updated_at = now() WHERE id = $1",
          [intoId, String(src.title)]);
        await client.query(
          "DELETE FROM work_lineage WHERE parent_work_id = $1 AND child_work_id = $2", [sourceId, intoId]);
        await this.mergeWithin(client, sourceId, intoId, actor);
        await recordAudit(client, { actor, action: "work.fold_source", targetType: "work", targetId: intoId,
                                    detail: { sourceId, sourceTitle: src.title } });
        return { sourceId, intoId, sourceTitle: String(src.title) };
      });
    } catch (error) { throw translate(error); }
  }

  /** 原作の名前を、その下の作品の原作名に写す（原作名が空の作品だけ）。原作はそのまま残す。 */
  async copySourceTitle(sourceId: number, actor: string): Promise<{ sourceId: number; updated: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const src = await this.requireWork(client, sourceId);
        const r = await client.query(
          `UPDATE works w SET source_title = $2, updated_at = now()
            FROM work_lineage l
           WHERE l.parent_work_id = $1 AND l.child_work_id = w.id AND w.status <> 'archived'
             AND COALESCE(btrim(w.source_title), '') = ''`, [sourceId, String(src.title)]);
        await recordAudit(client, { actor, action: "work.copy_source_title", targetType: "work", targetId: sourceId,
                                    detail: { updated: r.rowCount ?? 0 } });
        return { sourceId, updated: r.rowCount ?? 0 };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 統合の下見。何が移るか（条件・刊行物・実績・案件…）と、止める理由・注意を返す。
   * 案件の統合（matters/merge-service）と同じ形で、画面は実行前にこれを出す。
   */
  async mergePreview(id: number, intoId: number): Promise<WorkMergePreview> {
    try {
      const client = this.database;
      const blockers: string[] = [];
      const warnings: string[] = [];
      const head = async (wid: number) => {
        const r = await client.query(
          "SELECT id, work_code, title, kind, status, merged_into_id FROM works WHERE id = $1", [wid]);
        const w = r.rows[0] as { id: number; work_code: string | null; title: string; kind: string; status: string;
                                 merged_into_id: number | null } | undefined;
        if (!w) throw new DomainError("NOT_FOUND", `作品 ${wid} が見つかりません`);
        return w;
      };
      const from = await head(id);
      const into = id === intoId ? from : await head(intoId);
      if (id === intoId) blockers.push("同じ作品にはまとめられません");
      if (from.merged_into_id) blockers.push("この作品はすでに別の作品にまとめてあります");
      if (into.merged_into_id) blockers.push("統合先がすでに別の作品にまとめられています。その先を選んでください");
      if (into.status === "archived") blockers.push("終了した作品にはまとめられません。残す側を選んでください");
      if (id !== intoId) {
        const related = await client.query(LINEAGE_RELATED_SQL, [id, intoId]);
        if (related.rows[0]) blockers.push("系譜で繋がっている作品どうしはまとめられません。先に原作の付け外しで系譜を切ってください");
      }
      const count = async (sql: string, params: unknown[]) => {
        try { return Number(((await client.query(sql, params)).rows[0] as { n?: number } | undefined)?.n ?? 0); }
        catch (error) {
          const code = (error as { code?: string })?.code;
          if (code === "42P01" || code === "42703") return 0;   // 表・列が無い DB
          throw error;
        }
      };
      const moves: WorkMergeCounts = {
        conditions: await count("SELECT count(*)::int AS n FROM conditions WHERE work_id = $1", [id]),
        activeConditions: await count(
          "SELECT count(*)::int AS n FROM conditions WHERE work_id = $1 AND status IN ('active','scheduled','draft')", [id]),
        parts: await count("SELECT count(*)::int AS n FROM work_parts WHERE work_id = $1", [id]),
        editions: await count("SELECT count(*)::int AS n FROM work_editions WHERE work_id = $1", [id]),
        codes: await count("SELECT count(*)::int AS n FROM ebook_work_codes WHERE work_id = $1", [id]),
        credits: await count("SELECT count(*)::int AS n FROM work_credits WHERE work_id = $1", [id]),
        events: await count("SELECT count(*)::int AS n FROM condition_events WHERE work_id = $1", [id]),
        matters: await count("SELECT count(*)::int AS n FROM matters WHERE work_id = $1", [id]),
        links: await count("SELECT count(*)::int AS n FROM matter_links WHERE target_type = 'work' AND target_ref = $1", [String(id)]),
        lineage: await count(
          "SELECT count(*)::int AS n FROM work_lineage WHERE parent_work_id = $1 OR child_work_id = $1", [id])
      };
      if (from.kind !== into.kind) warnings.push(`種別が違います（${from.kind} → ${into.kind}）`);
      if (moves.activeConditions > 0) {
        const intoActive = await count(
          "SELECT count(*)::int AS n FROM conditions WHERE work_id = $1 AND status IN ('active','scheduled','draft')", [intoId]);
        if (intoActive > 0) {
          warnings.push(`両方に生きている条件があります（こちら ${moves.activeConditions}・先 ${intoActive}）。` +
                        "同じ相手・同じ使い方の条件が二重になっていないか、統合後に「条件ごと」で確かめてください");
        }
      }
      const side = (w: typeof from) => ({
        id: Number(w.id), workCode: w.work_code ?? null, title: String(w.title ?? ""), kind: String(w.kind), status: String(w.status)
      });
      return { from: side(from), into: side(into), moves, blockers, warnings };
    } catch (error) { throw translate(error); }
  }

  /**
   * 統合を取り消す。統合のときに動かしたものだけ付け戻す（統合後に先で作ったものは残る）。
   * 動かしたものの id は統合の監査（work.merge の detail.restore）に残してある。
   */
  async unmerge(id: number, actor: string): Promise<{ id: number; intoId: number; restored: Record<string, number> }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const work = await this.requireWork(client, id);
        if (!work.merged_into_id) throw new DomainError("CONFLICT", "この作品は統合されていません");
        const intoId = Number(work.merged_into_id);
        const audit = await client.query(
          `SELECT detail FROM audit_events
            WHERE action = 'work.merge' AND target_type = 'work' AND target_id = $1
            ORDER BY id DESC LIMIT 1`, [id]);
        const raw = (audit.rows[0] as { detail: unknown } | undefined)?.detail ?? {};
        const detail = (typeof raw === "string" ? JSON.parse(raw) : raw) as { intoId?: number; restore?: Partial<MergeRestore> };
        if (detail.intoId && Number(detail.intoId) !== intoId) {
          throw new DomainError("CONFLICT", "統合の記録と統合先が合いません。手で付け直してください");
        }
        const r: Partial<MergeRestore> = detail.restore ?? {};
        const restored: Record<string, number> = {};
        const back = async (table: string, ids: number[] | undefined, extra = "") => {
          if (!ids?.length) { restored[table] = 0; return; }
          await client.query("SAVEPOINT unmerge_back");
          try {
            const q = await client.query(
              `UPDATE ${table} SET work_id = $1${extra} WHERE id = ANY($3::bigint[]) AND work_id = $2`, [id, intoId, ids]);
            restored[table] = q.rowCount ?? 0;
            await client.query("RELEASE SAVEPOINT unmerge_back");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT unmerge_back");
            const code = (error as { code?: string })?.code;
            if (code !== "42P01" && code !== "42703") throw error;
            restored[table] = 0;
          }
        };
        await back("conditions", r.conditions, ", updated_at = now()");
        await back("work_editions", r.work_editions, ", updated_at = now()");
        await back("ebook_work_codes", r.ebook_work_codes);
        await back("work_credits", r.work_credits);
        await back("condition_events", r.condition_events);
        await back("matters", r.matters, ", updated_at = now()");
        let parts = 0;
        for (const p of r.parts ?? []) {
          const q = await client.query(
            "UPDATE work_parts SET work_id = $1, part_no = $4 WHERE id = $3 AND work_id = $2", [id, intoId, p.id, p.partNo]);
          parts += q.rowCount ?? 0;
        }
        restored.parts = parts;
        let links = 0;
        for (const l of r.links ?? []) {
          const q = await client.query(
            `UPDATE matter_links SET target_ref = $1 WHERE matter_id = $3 AND target_type = 'work' AND target_ref = $2`,
            [String(id), String(intoId), l.matterId]);
          links += q.rowCount ?? 0;
        }
        for (const l of r.linksDropped ?? []) {
          const q = await client.query(
            `INSERT INTO matter_links (matter_id, target_type, target_ref) VALUES ($1, 'work', $2)
             ON CONFLICT DO NOTHING`, [l.matterId, String(id)]);
          links += q.rowCount ?? 0;
        }
        restored.links = links;
        // 系譜：先へ写した行のうち、統合で入れたものだけ消し、元の行を戻す。
        for (const l of r.lineageAdded ?? []) {
          await client.query(
            "DELETE FROM work_lineage WHERE parent_work_id = $1 AND child_work_id = $2 AND relation_type = $3",
            [l.parentId, l.childId, l.relationType]);
        }
        let lineage = 0;
        for (const l of r.lineage ?? []) {
          const q = await client.query(
            `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`, [l.parentId, l.childId, l.relationType]);
          lineage += q.rowCount ?? 0;
        }
        restored.lineage = lineage;
        await client.query(
          `UPDATE works
              SET status = $2, merged_into_id = NULL,
                  remarks = NULLIF(btrim(regexp_replace(COALESCE(remarks, ''), '(^|\n)統合：→ [^\n]*$', '')), ''),
                  updated_at = now()
            WHERE id = $1`, [id, r.prevStatus ?? "released"]);
        await recordAudit(client, {
          actor, action: "work.unmerge", targetType: "work", targetId: id, detail: { intoId, restored }
        });
        return { id, intoId, restored };
      });
    } catch (error) { throw translate(error); }
  }

  /** 統合の本体（同じトランザクションの中で）。 */
  private async mergeWithin(client: Queryable, id: number, intoId: number, actor: string): Promise<{
    id: number; intoId: number; moved: { conditions: number; parts: number; lineage: number } & Record<string, number>;
  }> {
    if (id === intoId) throw new DomainError("VALIDATION", "同じ作品にはまとめられません");
    {
      {
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
        const related = await client.query(LINEAGE_RELATED_SQL, [id, intoId]);
        if (related.rows[0]) {
          throw new DomainError("VALIDATION",
            "系譜で繋がっている作品どうしはまとめられません。先に原作の付け外しで系譜を切ってください");
        }

        const ids = (rows: unknown[]) => rows.map((r) => Number((r as { id?: unknown }).id)).filter((n) => Number.isFinite(n));
        const restore: MergeRestore = {
          prevStatus: String(source.status), conditions: [], work_editions: [], ebook_work_codes: [], work_credits: [],
          condition_events: [], matters: [], parts: [], links: [], linksDropped: [], lineage: [], lineageAdded: []
        };
        const conditions = await client.query(
          "UPDATE conditions SET work_id = $2, updated_at = now() WHERE work_id = $1 RETURNING id", [id, intoId]);
        restore.conditions = ids(conditions.rows);
        // 作品を指すほかの行も先へ。残すと、終了した作品にぶら下がったまま見えなくなる
        // （刊行物の ISBN は一意なので、残すと統合先に同じ ISBN を足せない）。
        // 表がまだ無い DB（193 の前など）は飛ばす。SAVEPOINT で、1 つ無くても統合は続ける。
        const others: Record<string, number> = {};
        for (const [table, sql] of [
          ["work_editions", "UPDATE work_editions SET work_id = $2, updated_at = now() WHERE work_id = $1 RETURNING id"],
          ["ebook_work_codes", "UPDATE ebook_work_codes SET work_id = $2 WHERE work_id = $1 RETURNING id"],
          ["work_credits", "UPDATE work_credits SET work_id = $2 WHERE work_id = $1 RETURNING id"],
          ["condition_events", "UPDATE condition_events SET work_id = $2 WHERE work_id = $1 RETURNING id"],
          ["matters", "UPDATE matters SET work_id = $2, updated_at = now() WHERE work_id = $1 RETURNING id"]
        ] as const) {
          await client.query("SAVEPOINT merge_other");
          try {
            const r = await client.query(sql, [id, intoId]);
            others[table] = r.rowCount ?? 0;
            restore[table] = ids(r.rows);
            await client.query("RELEASE SAVEPOINT merge_other");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT merge_other");
            const code = (error as { code?: string })?.code;
            if (code !== "42P01" && code !== "42703") throw error;   // 表・列が無い DB だけ飛ばす
          }
        }
        // 案件が「ほかの作品」として指している行（matter_links target_type='work'）も先へ。
        // 先をすでに指している案件は、二重になるので元の行を消す。
        await client.query("SAVEPOINT merge_links");
        try {
          const dropped = await client.query(
            `DELETE FROM matter_links a USING matter_links b
              WHERE a.target_type = 'work' AND a.target_ref = $1
                AND b.matter_id = a.matter_id AND b.target_type = 'work' AND b.target_ref = $2
              RETURNING a.matter_id`,
            [String(id), String(intoId)]);
          restore.linksDropped = dropped.rows.map((r) => ({ matterId: Number((r as { matter_id: unknown }).matter_id) }));
          const moved = await client.query(
            "UPDATE matter_links SET target_ref = $2 WHERE target_type = 'work' AND target_ref = $1 RETURNING matter_id",
            [String(id), String(intoId)]);
          restore.links = moved.rows.map((r) => ({ matterId: Number((r as { matter_id: unknown }).matter_id) }));
          others.links = moved.rowCount ?? 0;
          await client.query("RELEASE SAVEPOINT merge_links");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT merge_links");
          const code = (error as { code?: string })?.code;
          if (code !== "42P01" && code !== "42703") throw error;
        }
        const partsBefore = await client.query("SELECT id, part_no FROM work_parts WHERE work_id = $1", [id]);
        restore.parts = partsBefore.rows.map((r) => ({
          id: Number((r as { id: unknown }).id), partNo: Number((r as { part_no: unknown }).part_no) }));
        const parts = await client.query(
          `UPDATE work_parts SET work_id = $2,
                  part_no = part_no + (SELECT COALESCE(max(part_no), 0) FROM work_parts WHERE work_id = $2)
            WHERE work_id = $1`, [id, intoId]);
        // 系譜。先と同じ行があれば ON CONFLICT で吸収し、自分自身への輪は入れない。
        const lineageRow = (r: unknown) => ({
          parentId: Number((r as { parent_work_id: unknown }).parent_work_id),
          childId: Number((r as { child_work_id: unknown }).child_work_id),
          relationType: String((r as { relation_type: unknown }).relation_type ?? "")
        });
        const lineageBefore = await client.query(
          "SELECT parent_work_id, child_work_id, relation_type FROM work_lineage WHERE parent_work_id = $1 OR child_work_id = $1", [id]);
        restore.lineage = lineageBefore.rows.map(lineageRow);
        const parents = await client.query(
          `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type)
           SELECT parent_work_id, $2, relation_type FROM work_lineage
            WHERE child_work_id = $1 AND parent_work_id <> $2
           ON CONFLICT DO NOTHING
           RETURNING parent_work_id, child_work_id, relation_type`, [id, intoId]);
        const children = await client.query(
          `INSERT INTO work_lineage (parent_work_id, child_work_id, relation_type)
           SELECT $2, child_work_id, relation_type FROM work_lineage
            WHERE parent_work_id = $1 AND child_work_id <> $2
           ON CONFLICT DO NOTHING
           RETURNING parent_work_id, child_work_id, relation_type`, [id, intoId]);
        restore.lineageAdded = [...parents.rows, ...children.rows].map(lineageRow);
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
          lineage: (parents.rowCount ?? 0) + (children.rowCount ?? 0), ...others
        };
        await recordAudit(client, {
          actor, action: "work.merge", targetType: "work", targetId: id,
          detail: { intoId, intoCode: target.work_code, moved, restore }
        });
        await recordAudit(client, {
          actor, action: "work.merge_in", targetType: "work", targetId: intoId,
          detail: { fromId: id, fromCode: source.work_code, moved }
        });
        return { id, intoId, moved };
      }
    }
  }

  private async requireWork(client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, id: number) {
    const r = await client.query(
      "SELECT id, work_code, title, kind, status, merged_into_id FROM works WHERE id = $1 FOR UPDATE", [id]);
    const row = r.rows[0] as { id: number; work_code: string | null; title: string; kind: string; status: string;
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
          `INSERT INTO work_parts (work_id, part_no, name, part_type, royalty_bearing, remarks, part_role)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [workId, partNo, name, input.partType ?? "unspecified",
           input.royaltyBearing !== false, input.remarks ?? null, input.partRole ?? null]);
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
