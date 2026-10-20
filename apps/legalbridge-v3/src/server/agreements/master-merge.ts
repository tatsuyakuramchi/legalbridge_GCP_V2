import { inTransaction, type Transactable, dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 基本契約の二重作成を 1 本に寄せる（取引先⇔基本契約の画面）。
 *
 * 寄せる側（from）にぶら下がる 個別契約・解除合意（parent_id）、条件（agreement_id）、文書（agreement_id）、
 * 案件のつながり（matter_links）を、残す側（into）へ付け替える。from は解除扱いにして番号は残す
 * （参照をたどれるように。件名に「統合済み → 残した番号」を添える）。
 *
 * 個別契約の番号は条件書の番号なので変わらない。ただし条件書・基本契約書の本文には基本契約の
 * 件名と締結日が入っているので、付け替えた下の決定済み文書は訂正版で出し直す（reissue）。
 */

export const MERGE_REASON = "基本契約の付け替え（二重作成の統合）に合わせて出し直す";

export interface MergeMastersPreview {
  from: { id: number; agreementNo: string | null; title: string };
  into: { id: number; agreementNo: string | null; title: string };
  moves: { supplements: number; conditions: number; documents: number; matters: number };
  /** 付け替えのあとに出し直す決定済みの文書（基本契約の件名・締結日が本文に入るもの）。 */
  reissue: Array<{ id: number; documentNo: string | null; title: string | null; issuedOn: string | null; agreementNo: string | null }>;
  blockers: string[];
}

export interface Reissuer {
  reissue(documentId: number, reason: string, actor: string): Promise<{ id: number }>;
  issue(documentId: number, actor: string, extra?: { issuedOn?: string | null }): Promise<{ documentNo?: string | null }>;
}

export class MasterMergeService {
  constructor(private readonly database: Transactable, private readonly issuer: Reissuer | null = null) {}

  async preview(fromId: number, intoId: number): Promise<MergeMastersPreview> {
    try { return await this.check(this.database, fromId, intoId); }
    catch (error) { throw translate(error); }
  }

  async merge(fromId: number, intoId: number, actor: string): Promise<MergeMastersPreview> {
    try {
      return await inTransaction(this.database, async (client) => {
        const p = await this.check(client, fromId, intoId);
        if (p.blockers.length) throw new DomainError("CONFLICT", p.blockers.join(" / "));
        await client.query("UPDATE agreements SET parent_id = $2, updated_at = now() WHERE parent_id = $1", [fromId, intoId]);
        await client.query("UPDATE conditions SET agreement_id = $2, updated_at = now() WHERE agreement_id = $1", [fromId, intoId]);
        await client.query("UPDATE documents SET agreement_id = $2 WHERE agreement_id = $1", [fromId, intoId]);
        // 案件のつながり：残す側に既にあれば消す、無ければ付け替える。
        await client.query(
          `DELETE FROM matter_links ml WHERE ml.target_type = 'agreement' AND ml.target_ref = $1::text
             AND EXISTS (SELECT 1 FROM matter_links x WHERE x.matter_id = ml.matter_id AND x.target_type = 'agreement' AND x.target_ref = $2::text)`,
          [fromId, intoId]);
        await client.query(
          "UPDATE matter_links SET target_ref = $2::text WHERE target_type = 'agreement' AND target_ref = $1::text", [fromId, intoId]);
        await client.query(
          `UPDATE agreements SET status = 'terminated', terminated_on = COALESCE(terminated_on, current_date),
                  title = '【統合済み → ' || $2::text || '】' || title, updated_at = now()
            WHERE id = $1`, [fromId, p.into.agreementNo ?? `#${intoId}`]);
        await recordAudit(client, {
          actor, action: "agreement.merge_master", targetType: "agreement", targetId: fromId,
          detail: { into: intoId, intoNo: p.into.agreementNo, fromNo: p.from.agreementNo, moves: p.moves, reissue: p.reissue.map((d) => d.id) }
        });
        return p;
      });
    } catch (error) { throw translate(error); }
  }

  /** 付け替えた下の決定済み文書を訂正版で出し直す（元の決定日のまま）。1 枚ずつ、失敗しても止めない。 */
  async reissue(documentIds: number[], actor: string): Promise<{ reissued: number; results: Array<{ documentId: number; documentNo: string | null; status: "reissued" | "error"; newDocumentNo?: string | null; message?: string }> }> {
    if (!this.issuer) throw new DomainError("UNAVAILABLE", "出し直しの口がありません");
    const results: Array<{ documentId: number; documentNo: string | null; status: "reissued" | "error"; newDocumentNo?: string | null; message?: string }> = [];
    for (const id of [...new Set(documentIds.map(Number))]) {
      const r = await this.database.query("SELECT document_no, issued_at, status FROM documents WHERE id = $1", [id]);
      const row = r.rows[0] as any;
      if (!row || row.status !== "issued") {
        results.push({ documentId: id, documentNo: str(row?.document_no) ?? null, status: "error", message: "決定済みの文書ではありません" });
        continue;
      }
      try {
        const open = await this.database.query(
          "SELECT id, supersede_reason FROM documents WHERE supersedes_id = $1 AND status = 'draft' ORDER BY id LIMIT 1", [id]);
        const draft = open.rows[0] as any;
        if (draft && str(draft.supersede_reason) !== MERGE_REASON) {
          throw new DomainError("CONFLICT", `訂正版の下書き（#${draft.id}）が開いています。それを決定するか捨ててください`);
        }
        const draftId = draft ? Number(draft.id) : (await this.issuer.reissue(id, MERGE_REASON, actor)).id;
        const issued = await this.issuer.issue(draftId, actor, { issuedOn: dateStr(row.issued_at) });
        results.push({ documentId: id, documentNo: str(row.document_no), status: "reissued", newDocumentNo: issued.documentNo ?? null });
      } catch (error) {
        results.push({ documentId: id, documentNo: str(row.document_no), status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { reissued: results.filter((x) => x.status === "reissued").length, results };
  }

  private async check(client: Transactable | { query: Transactable["query"] }, fromId: number, intoId: number): Promise<MergeMastersPreview> {
    if (fromId === intoId) throw new DomainError("VALIDATION", "同じ基本契約です");
    const r = await client.query(
      `SELECT a.id, a.agreement_no, a.title, COALESCE(a.kind, 'master') AS kind, a.status, a.direction, r.resolved_id
         FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id
        WHERE a.id = ANY($1::bigint[])`, [[fromId, intoId]]);
    const rows = r.rows as any[];
    const from = rows.find((x) => Number(x.id) === fromId);
    const into = rows.find((x) => Number(x.id) === intoId);
    if (!from || !into) throw new DomainError("NOT_FOUND", "基本契約が見つかりません");
    const blockers: string[] = [];
    if (from.kind !== "master") blockers.push("寄せる側が基本契約ではありません");
    if (into.kind !== "master") blockers.push("残す側が基本契約ではありません");
    if (Number(from.resolved_id) !== Number(into.resolved_id)) blockers.push("相手先の違う基本契約は寄せられません");
    if (from.direction !== into.direction) blockers.push("向き（IN／OUT）の違う基本契約は寄せられません");
    if (into.status === "terminated") blockers.push("残す側が解除済みです");
    const c = await client.query(
      `SELECT (SELECT count(*)::int FROM agreements WHERE parent_id = $1) AS supplements,
              (SELECT count(*)::int FROM conditions WHERE agreement_id = $1) AS conditions,
              (SELECT count(*)::int FROM documents WHERE agreement_id = $1) AS documents,
              (SELECT count(*)::int FROM matter_links WHERE target_type = 'agreement' AND target_ref = $1::text) AS matters`, [fromId]);
    const m = (c.rows[0] ?? {}) as any;
    const d = await client.query(
      `SELECT d.id, d.document_no, d.issued_at, COALESCE(d.manual_inputs->>'title', v.title) AS title, a.agreement_no
         FROM documents d
         JOIN agreements a ON a.id = d.agreement_id
         LEFT JOIN v_document_display v ON v.document_id = d.id
        WHERE d.status = 'issued' AND d.template_version_id IS NOT NULL
          AND (d.agreement_id = $1 OR a.parent_id = $1)
        ORDER BY d.document_no`, [fromId]);
    return {
      from: { id: fromId, agreementNo: str(from.agreement_no), title: String(from.title ?? "") },
      into: { id: intoId, agreementNo: str(into.agreement_no), title: String(into.title ?? "") },
      moves: { supplements: Number(m.supplements ?? 0), conditions: Number(m.conditions ?? 0), documents: Number(m.documents ?? 0), matters: Number(m.matters ?? 0) },
      reissue: (d.rows as any[]).map((x) => ({ id: Number(x.id), documentNo: str(x.document_no), title: str(x.title), issuedOn: dateStr(x.issued_at), agreementNo: str(x.agreement_no) })),
      blockers
    };
  }
}
