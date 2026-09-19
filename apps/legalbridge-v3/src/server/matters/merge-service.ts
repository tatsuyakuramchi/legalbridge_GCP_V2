import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 案件の統合（A-029）。
 *
 * 同じ仕事の案件が2つできることがある（先に相手方から届いた契約書で1つ、
 * 発注の段でもう1つ）。片方にまとめる。
 *
 * 取引先の名寄せと違い、ここは中身を物理的に付け替える。案件は「参照する
 * だけ」の箱で、条件・文書・タスクは案件の下にぶら下がっているのではなく
 * 案件を指しているだけなので、指す先を変えれば済む。統合元は消さず
 * merged_into_id を持って「統合済み」になる（一覧から消え、開けば統合先へ飛ぶ）。
 *
 * 取り消しは、統合のときに何を動かしたかを監査の記録に残しておき、それを
 * 読んで付け戻す。動かしたものだけ戻すので、統合後に統合先で作ったものは残る。
 */

export interface MatterMergeCounts {
  conditions: number; documents: number; tasks: number; communications: number;
  links: number; batches: number;
}

export interface MatterMergePreview {
  from: { id: number; matterNo: string | null; title: string; kind: string; status: string;
          counterparty: string | null };
  into: { id: number; matterNo: string | null; title: string; kind: string; status: string;
          counterparty: string | null };
  moves: MatterMergeCounts;
  /** 統合を止める理由。空なら実行できる。 */
  blockers: string[];
  /** 止めはしないが、確認のうえで進めるもの（相手先が違う など）。 */
  warnings: string[];
}

interface Moved {
  links: Array<{ targetType: string; targetRef: string }>;
  tasks: number[]; documents: number[]; communications: number[]; batches: number[];
  driveFolderCopied: boolean;
}

const HEAD = `
  SELECT m.id, m.matter_no, m.title, m.kind, m.status, m.merged_into_id, m.counterparty_id,
         m.remarks, m.drive_folder_url, p.name AS party_name,
         (SELECT count(*)::int FROM matter_links l WHERE l.matter_id = m.id AND l.target_type = 'condition') AS conditions,
         (SELECT count(*)::int FROM matter_links l WHERE l.matter_id = m.id AND l.target_type <> 'condition') AS links,
         (SELECT count(*)::int FROM documents d WHERE d.matter_id = m.id) AS documents,
         (SELECT count(*)::int FROM tasks t WHERE t.matter_id = m.id) AS tasks,
         (SELECT count(*)::int FROM matter_communications c WHERE c.matter_id = m.id) AS communications,
         (SELECT count(*)::int FROM document_batches b WHERE b.matter_id = m.id) AS batches
    FROM matters m LEFT JOIN parties p ON p.id = m.counterparty_id`;

const side = (r: Record<string, any>) => ({
  id: Number(r.id), matterNo: str(r.matter_no), title: String(r.title ?? ""), kind: String(r.kind),
  status: String(r.status), counterparty: str(r.party_name)
});

export class MatterMergeService {
  constructor(private readonly database: Transactable) {}

  async preview(fromId: number, intoId: number): Promise<MatterMergePreview> {
    try { return await this.check(this.database, fromId, intoId); }
    catch (error) { throw translate(error); }
  }

  /**
   * 統合する。警告（相手先が違う など）は acknowledge を付けたときだけ越えられる。
   * 何を動かしたかを監査に残す。取り消しはそれを読む。
   */
  async merge(fromId: number, intoId: number, actor: string, options: { acknowledge?: boolean } = {})
    : Promise<MatterMergePreview> {
    try {
      return await inTransaction(this.database, async (client) => {
        await client.query("SELECT id FROM matters WHERE id = ANY($1::bigint[]) FOR UPDATE", [[fromId, intoId]]);
        const check = await this.check(client, fromId, intoId);
        if (check.blockers.length) {
          throw new DomainError("CONFLICT", check.blockers.join(" / "), { blockers: check.blockers });
        }
        if (check.warnings.length && !options.acknowledge) {
          throw new DomainError("CONFLICT",
            `${check.warnings.join(" / ")}。確認のうえ統合するなら acknowledge を付けてください`,
            { warnings: check.warnings });
        }

        const moved: Moved = { links: [], tasks: [], documents: [], communications: [], batches: [],
                               driveFolderCopied: false };

        // 外部リンク（条件・Backlog・Drive など）。統合先に同じものがあれば動かさず捨てる。
        const links = await client.query(
          `SELECT l.target_type, l.target_ref FROM matter_links l
            WHERE l.matter_id = $1
              AND NOT EXISTS (SELECT 1 FROM matter_links x
                               WHERE x.matter_id = $2 AND x.target_type = l.target_type
                                 AND x.target_ref = l.target_ref)`, [fromId, intoId]);
        moved.links = (links.rows as any[]).map((l) => ({ targetType: String(l.target_type), targetRef: String(l.target_ref) }));
        await client.query(
          `UPDATE matter_links l SET matter_id = $2
            WHERE l.matter_id = $1
              AND NOT EXISTS (SELECT 1 FROM matter_links x
                               WHERE x.matter_id = $2 AND x.target_type = l.target_type
                                 AND x.target_ref = l.target_ref)`, [fromId, intoId]);
        await client.query("DELETE FROM matter_links WHERE matter_id = $1", [fromId]);

        const move = async (table: string): Promise<number[]> => {
          const r = await client.query(
            `UPDATE ${table} SET matter_id = $2 WHERE matter_id = $1 RETURNING id`, [fromId, intoId]);
          return (r.rows as Array<{ id: number }>).map((x) => Number(x.id));
        };
        moved.documents = await move("documents");
        moved.tasks = await move("tasks");
        // やり取りの記録（matter_communications）は追記専用で、実行ロールに UPDATE が
        // 無い（記録は書き換えない約束）。動かさず、統合先の画面が統合元の分も
        // 一緒に読む（communication-service）。
        moved.communications = [];
        moved.batches = await move("document_batches");

        // 統合先に Drive フォルダが無ければ統合元のを引き継ぐ。備考は捨てずに足す。
        const heads = await client.query(
          "SELECT id, remarks, drive_folder_url FROM matters WHERE id = ANY($1::bigint[])", [[fromId, intoId]]);
        const from = (heads.rows as any[]).find((x) => Number(x.id) === fromId);
        const into = (heads.rows as any[]).find((x) => Number(x.id) === intoId);
        if (!str(into?.drive_folder_url) && str(from?.drive_folder_url)) {
          await client.query("UPDATE matters SET drive_folder_url = $2, updated_at = now() WHERE id = $1",
            [intoId, from.drive_folder_url]);
          moved.driveFolderCopied = true;
        }
        if (str(from?.remarks)) {
          await client.query(
            `UPDATE matters SET remarks = concat_ws(E'\\n', NULLIF(remarks, ''), $2::text), updated_at = now()
              WHERE id = $1`,
            [intoId, `【統合元 ${check.from.matterNo ?? `#${fromId}`} の備考】${String(from.remarks)}`]);
        }

        await client.query(
          "UPDATE matters SET merged_into_id = $2, merged_at = now(), updated_at = now() WHERE id = $1",
          [fromId, intoId]);

        await recordAudit(client, {
          actor, action: "matter.merge", targetType: "matter", targetId: fromId,
          detail: { from: check.from, into: check.into, moves: check.moves, warnings: check.warnings, moved }
        });
        await recordAudit(client, {
          actor, action: "matter.merge_in", targetType: "matter", targetId: intoId,
          detail: { from: check.from, moves: check.moves }
        });
        return check;
      });
    } catch (error) { throw translate(error); }
  }

  /** 統合を取り消す。統合のときに動かしたものだけ付け戻す。 */
  async unmerge(matterId: number, actor: string): Promise<{ id: number; matterNo: string | null; into: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          "SELECT id, matter_no, merged_into_id FROM matters WHERE id = $1 FOR UPDATE", [matterId]);
        const row = r.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);
        if (!row.merged_into_id) throw new DomainError("CONFLICT", "この案件は統合されていません");
        const intoId = Number(row.merged_into_id);

        const audit = await client.query(
          `SELECT detail FROM audit_events
            WHERE action = 'matter.merge' AND target_type = 'matter' AND target_id = $1
            ORDER BY id DESC LIMIT 1`, [matterId]);
        const detail = (audit.rows[0] as { detail: any } | undefined)?.detail ?? {};
        const moved: Partial<Moved> = (typeof detail === "string" ? JSON.parse(detail) : detail).moved ?? {};

        const back = async (table: string, ids: number[] | undefined) => {
          if (!ids?.length) return;
          await client.query(
            `UPDATE ${table} SET matter_id = $1 WHERE id = ANY($3::bigint[]) AND matter_id = $2`,
            [matterId, intoId, ids]);
        };
        await back("documents", moved.documents);
        await back("tasks", moved.tasks);
        // やり取りの記録は動かしていないので戻すものが無い。
        await back("document_batches", moved.batches);
        for (const l of moved.links ?? []) {
          await client.query(
            `UPDATE matter_links SET matter_id = $1
              WHERE matter_id = $2 AND target_type = $3 AND target_ref = $4`,
            [matterId, intoId, l.targetType, l.targetRef]);
        }
        await client.query(
          "UPDATE matters SET merged_into_id = NULL, merged_at = NULL, updated_at = now() WHERE id = $1",
          [matterId]);
        await recordAudit(client, {
          actor, action: "matter.unmerge", targetType: "matter", targetId: matterId,
          detail: { into: intoId, restored: moved }
        });
        return { id: matterId, matterNo: str(row.matter_no), into: intoId };
      });
    } catch (error) { throw translate(error); }
  }

  private async check(client: Queryable, fromId: number, intoId: number): Promise<MatterMergePreview> {
    if (fromId === intoId) throw new DomainError("VALIDATION", "同じ案件どうしは統合できません");
    const r = await client.query(`${HEAD} WHERE m.id = ANY($1::bigint[])`, [[fromId, intoId]]);
    const rows = r.rows as any[];
    const from = rows.find((x) => Number(x.id) === fromId);
    const into = rows.find((x) => Number(x.id) === intoId);
    if (!from) throw new DomainError("NOT_FOUND", `統合元の案件 ${fromId} が見つかりません`);
    if (!into) throw new DomainError("NOT_FOUND", `統合先の案件 ${intoId} が見つかりません`);

    const blockers: string[] = [];
    const warnings: string[] = [];
    if (from.merged_into_id) blockers.push("統合元はすでに別の案件に統合されています");
    if (into.merged_into_id) blockers.push("統合先はすでに別の案件に統合されています。その統合先を選んでください");
    if (String(from.kind) !== String(into.kind)) {
      blockers.push("取引モデルが違う案件は統合できません（ライセンスと業務委託など）。先に取引モデルを揃えてください");
    }
    if (from.counterparty_id && into.counterparty_id
        && Number(from.counterparty_id) !== Number(into.counterparty_id)) {
      warnings.push(`相手先が違います（${from.party_name ?? "—"} → ${into.party_name ?? "—"}）`);
    }
    if (String(into.status) === "canceled") warnings.push("統合先は取り下げ済みの案件です");

    return {
      from: side(from), into: side(into),
      moves: {
        conditions: Number(from.conditions), documents: Number(from.documents), tasks: Number(from.tasks),
        communications: Number(from.communications), links: Number(from.links), batches: Number(from.batches)
      },
      blockers, warnings
    };
  }
}

export const mergedAtOf = (v: unknown): string | null => dateStr(v);
