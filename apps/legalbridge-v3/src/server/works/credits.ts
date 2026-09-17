import { dateStr, inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * クレジット表記（著作権表示・第三者権利）の履歴（A-031）。
 *
 * 重版で著作権表示が変わる。作品 1 点に「適用開始日つきの表記」を行で持ち、
 * 今の表記は適用開始日が今日以前で最新の行。works.copyright_notice /
 * third_party_rights はその写しで、行を足す・消すたびにここで同期する
 * （一覧・検索・古い読み手は列のほうを見る）。
 *
 * 文書は決定日時点の表記を使う（文書の文脈が work_credits を日付で引く）。
 * 決定済みの文書は値が焼き付いているので、あとで表記が変わっても変わらない。
 */

export interface WorkCredit {
  id: number;
  workId: number;
  effectiveFrom: string;
  edition: string | null;
  copyrightNotice: string;
  thirdPartyRights: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  /** 今日時点で使われている行か。 */
  current: boolean;
}

export interface WorkCreditInput {
  effectiveFrom: string;
  edition?: string | null;
  copyrightNotice: string;
  thirdPartyRights?: string | null;
  note?: string | null;
}

const map = (r: Record<string, any>, currentId: number | null): WorkCredit => ({
  id: Number(r.id), workId: Number(r.work_id),
  effectiveFrom: dateStr(r.effective_from) ?? String(r.effective_from),
  edition: str(r.edition), copyrightNotice: String(r.copyright_notice ?? ""),
  thirdPartyRights: str(r.third_party_rights), note: str(r.note),
  createdBy: str(r.created_by),
  createdAt: r.created_at ? new Date(String(r.created_at)).toISOString() : "",
  current: currentId !== null && Number(r.id) === currentId
});

/** 今日時点の行の id。無ければ null。 */
async function currentIdOf(client: Queryable, workId: number): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM work_credits
      WHERE work_id = $1 AND effective_from <= current_date
      ORDER BY effective_from DESC, id DESC LIMIT 1`, [workId]);
  return r.rows[0] ? Number((r.rows[0] as { id: number }).id) : null;
}

/**
 * works の写しを今日時点の行に合わせる。行が 1 つも無ければ空にする。
 * 適用日が先の行は、その日が来てから（次に同期が走ったとき、または文書の
 * 文脈が日付で引くとき）効く。
 */
export async function syncCurrentCredit(client: Queryable, workId: number): Promise<void> {
  await client.query(
    `UPDATE works w
        SET copyright_notice = c.copyright_notice, third_party_rights = c.third_party_rights, updated_at = now()
       FROM (SELECT copyright_notice, third_party_rights FROM work_credits
              WHERE work_id = $1 AND effective_from <= current_date
              ORDER BY effective_from DESC, id DESC LIMIT 1) c
      WHERE w.id = $1
        AND (w.copyright_notice IS DISTINCT FROM c.copyright_notice
             OR w.third_party_rights IS DISTINCT FROM c.third_party_rights)`, [workId]);
  await client.query(
    `UPDATE works SET copyright_notice = NULL, third_party_rights = NULL, updated_at = now()
      WHERE id = $1 AND (copyright_notice IS NOT NULL OR third_party_rights IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM work_credits WHERE work_id = $1 AND effective_from <= current_date)`,
    [workId]);
}

/**
 * 表記の行を足す（同じ適用日があれば上書き）。作品の作成・編集（著作権表示の欄）
 * からも呼ぶので、トランザクションは呼ぶ側が持つ。
 */
export async function upsertCredit(
  client: Queryable, workId: number, input: WorkCreditInput, actor: string
): Promise<{ id: number }> {
  const notice = String(input.copyrightNotice ?? "").trim();
  if (!notice) throw new DomainError("VALIDATION", "著作権表示は必須です");
  const on = String(input.effectiveFrom ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new DomainError("VALIDATION", "適用開始日を入れてください");
  const r = await client.query(
    `INSERT INTO work_credits (work_id, effective_from, edition, copyright_notice, third_party_rights, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (work_id, effective_from) DO UPDATE
       SET edition = COALESCE(EXCLUDED.edition, work_credits.edition),
           copyright_notice = EXCLUDED.copyright_notice,
           third_party_rights = EXCLUDED.third_party_rights,
           note = COALESCE(EXCLUDED.note, work_credits.note),
           created_by = EXCLUDED.created_by
     RETURNING id`,
    [workId, on, str(input.edition), notice, str(input.thirdPartyRights), str(input.note), actor]);
  const id = Number((r.rows[0] as { id: number }).id);
  await syncCurrentCredit(client, workId);
  await recordAudit(client, {
    actor, action: "work.credit", targetType: "work", targetId: workId,
    detail: { creditId: id, effectiveFrom: on, edition: str(input.edition), copyrightNotice: notice,
              thirdPartyRights: str(input.thirdPartyRights), note: str(input.note) }
  });
  return { id };
}

export class WorkCreditService {
  constructor(private readonly database: Transactable) {}

  async list(workId: number): Promise<{ credits: WorkCredit[]; current: WorkCredit | null }> {
    try {
      const currentId = await currentIdOf(this.database, workId);
      const r = await this.database.query(
        `SELECT id, work_id, effective_from, edition, copyright_notice, third_party_rights, note, created_by, created_at
           FROM work_credits WHERE work_id = $1
          ORDER BY effective_from DESC, id DESC`, [workId]);
      const credits = (r.rows as Array<Record<string, any>>).map((x) => map(x, currentId));
      return { credits, current: credits.find((c) => c.current) ?? null };
    } catch (error) { throw translate(error); }
  }

  async add(workId: number, input: WorkCreditInput, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const w = await client.query("SELECT id FROM works WHERE id = $1", [workId]);
        if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);
        return upsertCredit(client, workId, input, actor);
      });
    } catch (error) { throw translate(error); }
  }

  /** 行を消す。取り違えて入れたときのため。消したあとの今の表記は残りの行から決まる。 */
  async remove(workId: number, creditId: number, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          "DELETE FROM work_credits WHERE id = $1 AND work_id = $2 RETURNING id, effective_from, copyright_notice",
          [creditId, workId]);
        const row = r.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `表記の行 ${creditId} が見つかりません`);
        await syncCurrentCredit(client, workId);
        await recordAudit(client, {
          actor, action: "work.credit_remove", targetType: "work", targetId: workId,
          detail: { creditId: int(row.id), effectiveFrom: dateStr(row.effective_from), copyrightNotice: str(row.copyright_notice) }
        });
        return { id: creditId };
      });
    } catch (error) { throw translate(error); }
  }
}
