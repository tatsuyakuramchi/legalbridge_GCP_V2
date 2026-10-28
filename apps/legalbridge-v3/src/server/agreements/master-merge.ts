import { inTransaction, type Queryable, type Transactable, dateStr, int, str } from "../core/db.js";
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

/**
 * 基本契約を差し替える先。いまある契約（種類を問わない。基本契約でなければ基本契約にする）か、
 * 文書（基本契約書の紙。その文書から基本契約を立てる）。
 */
export type ReplaceTarget =
  | { intoId: number }
  | { documentId: number; agreementNo?: string | null; title?: string | null };

/** 差し替えの試算（差し替え先が決まる前に、寄せる側から移るものだけ）。 */
export interface ReplacePreview {
  from: { id: number; agreementNo: string | null; title: string; kind: string; status: string };
  moves: MergeMastersPreview["moves"];
  reissue: MergeMastersPreview["reissue"];
}

/** 訂正版の枝番（-R2 など）を外した番号。文書から立てる基本契約の番号の既定。 */
export const baseNumber = (no: string) => no.replace(/-R\d+$/i, "");

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
      return await inTransaction(this.database, (client) => this.apply(client, fromId, intoId, actor));
    } catch (error) { throw translate(error); }
  }

  /** 差し替えの試算。寄せる側の下から移るもの（個別契約・条件・文書・案件）と、出し直す文書。 */
  async replacePreview(fromId: number): Promise<ReplacePreview> {
    try {
      const r = await this.database.query(
        "SELECT id, agreement_no, title, COALESCE(kind, 'master') AS kind, status FROM agreements WHERE id = $1", [fromId]);
      const a = r.rows[0] as any;
      if (!a) throw new DomainError("NOT_FOUND", `契約 ${fromId} が見つかりません`);
      const { moves, reissue } = await this.movesOf(this.database, fromId);
      return { from: { id: fromId, agreementNo: str(a.agreement_no), title: String(a.title ?? ""), kind: String(a.kind), status: String(a.status ?? "") },
               moves, reissue };
    } catch (error) { throw translate(error); }
  }

  /**
   * 基本契約を差し替える（1 回の操作で）。
   *   1. 差し替え先を基本契約にする。いまある契約なら種類を基本契約にし（親は外す。種別・向きは
   *      寄せる側に合わせる）、文書なら番号（既定は文書番号から訂正版の枝番を外したもの）で基本契約を立て、
   *      文書をその基本契約に繋ぐ。
   *   2. 寄せる側の下の個別契約・条件・文書・案件を付け替え、寄せる側は解除扱い（番号は残る）にする。
   * 下の決定済み文書の出し直しは、返す reissue を見て別に行う（merge と同じ）。
   */
  async replace(fromId: number, target: ReplaceTarget, actor: string): Promise<MergeMastersPreview & { created: boolean }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const fr = await client.query(
          `SELECT a.id, a.agreement_no, COALESCE(a.kind, 'master') AS kind, a.domain, a.direction, a.counterparty_id, r.resolved_id
             FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id WHERE a.id = $1 FOR UPDATE OF a`, [fromId]);
        const from = fr.rows[0] as any;
        if (!from) throw new DomainError("NOT_FOUND", `契約 ${fromId} が見つかりません`);
        if (from.kind !== "master") throw new DomainError("VALIDATION", "差し替えられるのは基本契約だけです");
        let intoId: number;
        let created = false;
        if ("intoId" in target) {
          intoId = Number(target.intoId);
          if (intoId === fromId) throw new DomainError("VALIDATION", "同じ基本契約です");
          const ir = await client.query(
            `SELECT a.id, COALESCE(a.kind, 'master') AS kind, a.domain, a.status, r.resolved_id
               FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id WHERE a.id = $1 FOR UPDATE OF a`, [intoId]);
          const into = ir.rows[0] as any;
          if (!into) throw new DomainError("NOT_FOUND", `契約 ${intoId} が見つかりません`);
          if (Number(into.resolved_id) !== Number(from.resolved_id)) throw new DomainError("VALIDATION", "相手先の違う契約には差し替えられません");
          if (into.status === "terminated") throw new DomainError("VALIDATION", "解除済みの契約には差し替えられません");
          if (into.kind !== "master") {
            const kids = await client.query(
              "SELECT count(*)::int AS n FROM agreements WHERE parent_id = $1 AND COALESCE(kind, 'master') IN ('master', 'standalone')", [intoId]);
            if (Number((kids.rows[0] as any)?.n ?? 0) > 0) throw new DomainError("VALIDATION", "この契約の下に基本契約・単体契約があるので、基本契約にできません");
            await client.query(
              `UPDATE agreements SET kind = 'master', parent_id = NULL, domain = COALESCE(domain, $2), direction = $3, updated_at = now()
                WHERE id = $1`, [intoId, str(from.domain) ?? "license", String(from.direction)]);
          }
        } else {
          const dr = await client.query(
            `SELECT d.id, d.document_no, d.status, d.agreement_id, d.manual_inputs->>'title' AS manual_title, v.title,
                    v.counterparty_id, r.resolved_id
               FROM documents d JOIN v_document_display v ON v.document_id = d.id
               LEFT JOIN v_party_resolved r ON r.party_id = v.counterparty_id
              WHERE d.id = $1 FOR UPDATE OF d`, [target.documentId]);
          const d = dr.rows[0] as any;
          if (!d) throw new DomainError("NOT_FOUND", `文書 ${target.documentId} が見つかりません`);
          if (!d.document_no || d.status === "draft" || d.status === "void" || d.status === "superseded") {
            throw new DomainError("VALIDATION", "決定済みの文書からだけ基本契約を立てられます");
          }
          if (d.resolved_id !== null && d.resolved_id !== undefined && Number(d.resolved_id) !== Number(from.resolved_id)) {
            throw new DomainError("VALIDATION", "相手先の違う文書からは差し替えられません");
          }
          if (d.agreement_id && Number(d.agreement_id) !== fromId) {
            throw new DomainError("CONFLICT", "この文書は別の契約に繋がっています。先にその契約から外してください");
          }
          const no = String(target.agreementNo ?? "").trim() || baseNumber(String(d.document_no));
          const clash = await client.query("SELECT id FROM agreements WHERE lower(btrim(agreement_no)) = lower($1)", [no]);
          if (clash.rows[0]) throw new DomainError("CONFLICT", `番号 ${no} の契約が既にあります。その契約を選ぶか、番号を変えてください`);
          const title = String(target.title ?? "").trim() || str(d.manual_title) || str(d.title) || "基本契約";
          const ins = await client.query(
            `INSERT INTO agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id)
             VALUES ($1, $2, $3, $4, 'negotiating', 'master', $5, NULL) RETURNING id`,
            [no, title, Number(from.counterparty_id), String(from.direction), str(from.domain) ?? "license"]);
          intoId = Number((ins.rows[0] as { id: number }).id);
          created = true;
          await client.query("UPDATE documents SET agreement_id = $2 WHERE id = $1", [Number(d.id), intoId]);
        }
        const p = await this.apply(client, fromId, intoId, actor);
        return { ...p, created };
      });
    } catch (error) { throw translate(error); }
  }

  private async apply(client: Queryable, fromId: number, intoId: number, actor: string): Promise<MergeMastersPreview> {
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

  private async check(client: Queryable, fromId: number, intoId: number): Promise<MergeMastersPreview> {
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
    const { moves, reissue } = await this.movesOf(client, fromId);
    return {
      from: { id: fromId, agreementNo: str(from.agreement_no), title: String(from.title ?? "") },
      into: { id: intoId, agreementNo: str(into.agreement_no), title: String(into.title ?? "") },
      moves, reissue, blockers
    };
  }

  private async movesOf(client: Queryable, fromId: number): Promise<Pick<MergeMastersPreview, "moves" | "reissue">> {
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
      moves: { supplements: Number(m.supplements ?? 0), conditions: Number(m.conditions ?? 0), documents: Number(m.documents ?? 0), matters: Number(m.matters ?? 0) },
      reissue: (d.rows as any[]).map((x) => ({ id: Number(x.id), documentNo: str(x.document_no), title: str(x.title), issuedOn: dateStr(x.issued_at), agreementNo: str(x.agreement_no) }))
    };
  }
}
