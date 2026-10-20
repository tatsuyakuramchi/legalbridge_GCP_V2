import { inTransaction, type Queryable, type Transactable, dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 複数当事者の契約（docs/v3-tidy.md 型 3。A-075）。
 *
 * 契約・条件の相手方は 1 人のまま。それ以外の当事者は 2 つの形で持つ。
 *   - 文書の関係当事者（document_parties）：文書 × 取引先 × 役割。文書は 1 件で、
 *     どの取引先の木からも同じ 1 件が見える。お金の宛先は変えない（条件の取り分で制御）。
 *   - 契約の地位承継（agreement_successions）：元の契約の相手方を発効日で from → to に
 *     切り替える出来事。発効日前の実績・支払文書・支払は from 宛てのまま残る。
 */

export type DocumentPartyRole = "counterparty" | "coauthor" | "assignor" | "assignee" | "consenter" | "signer" | "other";
export const DOCUMENT_PARTY_ROLES: DocumentPartyRole[] = ["counterparty", "coauthor", "assignor", "assignee", "consenter", "signer", "other"];
export const DOCUMENT_PARTY_ROLE_LABEL: Record<DocumentPartyRole, string> = {
  counterparty: "相手方", coauthor: "共著者", assignor: "譲渡人", assignee: "譲受人", consenter: "承諾者", signer: "署名者", other: "その他"
};

export interface DocumentParty {
  id: number; partyId: number; partyName: string; partyKind: string; role: DocumentPartyRole; note: string | null;
  /** 文書の宛名（相手方・受取人）と同じ取引先か。宛名は document_parties とは別に決まる。 */
  addressee: boolean;
}

export interface RelatedDocument {
  documentId: number; documentNo: string | null; title: string | null; status: string; issuedOn: string | null;
  role: DocumentPartyRole; note: string | null;
  /** その文書の宛名（相手方）。 */
  counterpartyName: string | null;
}

export class DocumentPartyService {
  constructor(private readonly database: Transactable) {}

  /** 文書の関係当事者。宛名の取引先には addressee の印。 */
  async list(documentId: number): Promise<DocumentParty[]> {
    try {
      const r = await this.database.query(
        `SELECT dp.id, dp.party_id, p.name AS party_name, p.kind AS party_kind, dp.role, dp.note,
                (dp.party_id = COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                             THEN (d.manual_inputs->>'_payeePartyId')::bigint END, v.counterparty_id)) AS addressee
           FROM document_parties dp
           JOIN documents d ON d.id = dp.document_id
           JOIN v_document_display v ON v.document_id = d.id
           JOIN parties p ON p.id = dp.party_id
          WHERE dp.document_id = $1
          ORDER BY dp.sort_order, dp.id`, [documentId]);
      return (r.rows as any[]).map(mapParty);
    } catch (error) { throw translate(error); }
  }

  /**
   * 関係当事者を置き換える。宛名の取引先は常に相手方として残す（消させない）。
   * 同じ取引先に 2 つの役割は付けられる（署名者で共著者、など）。
   */
  async replace(documentId: number, parties: Array<{ partyId: number; role: DocumentPartyRole; note?: string | null }>, actor: string): Promise<DocumentParty[]> {
    try {
      return await inTransaction(this.database, async (client) => {
        const d = await client.query(
          `SELECT d.id, COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                      THEN (d.manual_inputs->>'_payeePartyId')::bigint END, v.counterparty_id) AS addressee
             FROM documents d JOIN v_document_display v ON v.document_id = d.id WHERE d.id = $1 FOR UPDATE OF d`, [documentId]);
        const row = d.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        const addressee = int(row.addressee);
        const rows = parties.map((p) => ({ partyId: p.partyId, role: p.role, note: str(p.note ?? null) }));
        if (addressee && !rows.some((p) => p.partyId === addressee && p.role === "counterparty")) {
          rows.unshift({ partyId: addressee, role: "counterparty", note: null });
        }
        const seen = new Set<string>();
        const uniq = rows.filter((p) => { const k = `${p.partyId}:${p.role}`; if (seen.has(k)) return false; seen.add(k); return true; });
        const ids = [...new Set(uniq.map((p) => p.partyId))];
        if (ids.length) {
          const ok = await client.query("SELECT id FROM parties WHERE id = ANY($1::bigint[])", [ids]);
          const found = new Set((ok.rows as any[]).map((x) => Number(x.id)));
          const missing = ids.filter((x) => !found.has(x));
          if (missing.length) throw new DomainError("NOT_FOUND", `取引先 ${missing.join("・")} が見つかりません`);
        }
        const before = await client.query("SELECT party_id, role FROM document_parties WHERE document_id = $1", [documentId]);
        await client.query("DELETE FROM document_parties WHERE document_id = $1", [documentId]);
        for (const [i, p] of uniq.entries()) {
          await client.query(
            `INSERT INTO document_parties (document_id, party_id, role, note, sort_order) VALUES ($1, $2, $3, $4, $5)`,
            [documentId, p.partyId, p.role, p.note, i]);
        }
        await recordAudit(client, {
          actor, action: "document.parties", targetType: "document", targetId: documentId,
          detail: { before: before.rows, after: uniq }
        });
        return new DocumentPartyService(client as unknown as Transactable).list(documentId);
      });
    } catch (error) { throw translate(error); }
  }

  /** この取引先（統合元を含む）が宛名ではなく関係当事者として載っている文書。 */
  async relatedTo(members: number[]): Promise<RelatedDocument[]> {
    try {
      const r = await this.database.query(
        `SELECT d.id, d.document_no, COALESCE(d.manual_inputs->>'title', v.title) AS title, d.status, d.issued_at,
                dp.role, dp.note, v.counterparty AS counterparty_name
           FROM document_parties dp
           JOIN documents d ON d.id = dp.document_id
           JOIN v_document_display v ON v.document_id = d.id
          WHERE dp.party_id = ANY($1::bigint[]) AND d.status NOT IN ('void', 'superseded')
            AND COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                              THEN (d.manual_inputs->>'_payeePartyId')::bigint END, v.counterparty_id) <> ALL($1::bigint[])
          ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [members]);
      return (r.rows as any[]).map((x) => ({
        documentId: Number(x.id), documentNo: str(x.document_no), title: str(x.title), status: String(x.status ?? ""),
        issuedOn: dateStr(x.issued_at), role: roleOf(x.role), note: str(x.note), counterpartyName: str(x.counterparty_name)
      }));
    } catch (error) { throw translate(error); }
  }

  /** 関係当事者の署名者・主担当（CloudSign の署名者の候補に足す）。宛名の取引先は除く。 */
  async signerCandidates(documentId: number): Promise<Array<{ partyName: string; role: DocumentPartyRole; name: string | null; email: string; roles: string[]; department: string | null }>> {
    try {
      const r = await this.database.query(
        `SELECT p.name AS party_name, dp.role, c.name, c.email, c.roles, c.department
           FROM document_parties dp
           JOIN parties p ON p.id = dp.party_id
           JOIN party_contacts c ON c.party_id = dp.party_id
           JOIN documents d ON d.id = dp.document_id
           JOIN v_document_display v ON v.document_id = d.id
          WHERE dp.document_id = $1 AND c.email IS NOT NULL AND btrim(c.email) <> ''
            AND dp.party_id IS DISTINCT FROM COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                                            THEN (d.manual_inputs->>'_payeePartyId')::bigint END, v.counterparty_id)
            AND (c.roles && ARRAY['signer', 'primary']::text[])
          ORDER BY dp.sort_order, dp.id, (c.roles @> ARRAY['signer']::text[]) DESC`, [documentId]);
      const out: Array<{ partyName: string; role: DocumentPartyRole; name: string | null; email: string; roles: string[]; department: string | null }> = [];
      const seen = new Set<string>();
      for (const x of r.rows as any[]) {
        const email = String(x.email).trim().toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);
        out.push({ partyName: String(x.party_name ?? ""), role: roleOf(x.role), name: str(x.name), email: String(x.email).trim(),
                   roles: Array.isArray(x.roles) ? x.roles.map(String) : [], department: str(x.department) });
      }
      return out;
    } catch (error) { throw translate(error); }
  }
}

const roleOf = (v: unknown): DocumentPartyRole => (DOCUMENT_PARTY_ROLES.includes(v as DocumentPartyRole) ? (v as DocumentPartyRole) : "other");
const mapParty = (x: any): DocumentParty => ({
  id: Number(x.id), partyId: Number(x.party_id), partyName: String(x.party_name ?? ""), partyKind: String(x.party_kind ?? ""),
  role: roleOf(x.role), note: str(x.note), addressee: x.addressee === true
});

// ---------------------------------------------------------------------

export interface Succession {
  id: number; agreementId: number; agreementNo: string | null; agreementTitle: string;
  from: { id: number; name: string }; to: { id: number; name: string };
  effectiveOn: string; documentId: number | null; documentNo: string | null; note: string | null;
  appliedAt: string | null; revertedAt: string | null;
  /** 予定（発効日前）／適用済み／取り消し。 */
  state: "pending" | "applied" | "reverted";
}

export interface SuccessionInput {
  toPartyId: number; effectiveOn: string; documentId?: number | null; note?: string | null;
}

const SUCCESSION_SELECT = `
  SELECT s.id, s.agreement_id, a.agreement_no, a.title AS agreement_title,
         s.from_party_id, fp.name AS from_name, s.to_party_id, tp.name AS to_name,
         s.effective_on, s.document_id, d.document_no, s.note, s.applied_at, s.reverted_at
    FROM agreement_successions s
    JOIN agreements a ON a.id = s.agreement_id
    JOIN parties fp ON fp.id = s.from_party_id
    JOIN parties tp ON tp.id = s.to_party_id
    LEFT JOIN documents d ON d.id = s.document_id`;

function mapSuccession(x: any): Succession {
  const appliedAt = x.applied_at ? new Date(x.applied_at).toISOString() : null;
  const revertedAt = x.reverted_at ? new Date(x.reverted_at).toISOString() : null;
  return {
    id: Number(x.id), agreementId: Number(x.agreement_id), agreementNo: str(x.agreement_no), agreementTitle: String(x.agreement_title ?? ""),
    from: { id: Number(x.from_party_id), name: String(x.from_name ?? "") }, to: { id: Number(x.to_party_id), name: String(x.to_name ?? "") },
    effectiveOn: dateStr(x.effective_on) ?? "", documentId: int(x.document_id), documentNo: str(x.document_no), note: str(x.note),
    appliedAt, revertedAt, state: revertedAt ? "reverted" : appliedAt ? "applied" : "pending"
  };
}

export class SuccessionService {
  constructor(private readonly database: Transactable, private readonly today: () => string = () => new Date().toISOString().slice(0, 10)) {}

  async forAgreement(agreementId: number): Promise<Succession[]> {
    try {
      const r = await this.database.query(`${SUCCESSION_SELECT} WHERE s.agreement_id = $1 ORDER BY s.effective_on, s.id`, [agreementId]);
      return (r.rows as any[]).map(mapSuccession);
    } catch (error) { throw translate(error); }
  }

  /** この取引先（統合元を含む）が譲渡人か譲受人の承継。 */
  async forParty(members: number[]): Promise<Succession[]> {
    try {
      const r = await this.database.query(
        `${SUCCESSION_SELECT} WHERE s.from_party_id = ANY($1::bigint[]) OR s.to_party_id = ANY($1::bigint[])
         ORDER BY s.effective_on DESC, s.id DESC`, [members]);
      return (r.rows as any[]).map(mapSuccession);
    } catch (error) { throw translate(error); }
  }

  /**
   * 承継を登録する。発効日が今日以前なら、その場で相手方を切り替える。
   * from は契約の今の相手方。すでに予定が開いていれば 2 つ目は作らない。
   */
  async create(agreementId: number, input: SuccessionInput, actor: string): Promise<Succession> {
    try {
      return await inTransaction(this.database, async (client) => {
        const a = await client.query("SELECT id, counterparty_id, status FROM agreements WHERE id = $1 FOR UPDATE", [agreementId]);
        const row = a.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `契約 ${agreementId} が見つかりません`);
        const from = Number(row.counterparty_id);
        if (from === input.toPartyId) throw new DomainError("VALIDATION", "譲受人が今の相手方と同じです");
        const open = await client.query(
          "SELECT id FROM agreement_successions WHERE agreement_id = $1 AND applied_at IS NULL AND reverted_at IS NULL", [agreementId]);
        if (open.rows.length) throw new DomainError("CONFLICT", "この契約には発効前の承継がすでにあります。先にそれを適用するか消してください");
        const to = await client.query("SELECT id, status FROM parties WHERE id = $1", [input.toPartyId]);
        if (!to.rows[0]) throw new DomainError("NOT_FOUND", `取引先 ${input.toPartyId} が見つかりません`);
        if ((to.rows[0] as any).status === "merged") throw new DomainError("VALIDATION", "統合済みの取引先には承継できません。統合先を選んでください");
        const ins = await client.query(
          `INSERT INTO agreement_successions (agreement_id, from_party_id, to_party_id, effective_on, document_id, note, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [agreementId, from, input.toPartyId, input.effectiveOn, input.documentId ?? null, str(input.note ?? null), actor]);
        const id = Number((ins.rows[0] as any).id);
        await recordAudit(client, {
          actor, action: "agreement.succession", targetType: "agreement", targetId: agreementId,
          detail: { successionId: id, from, to: input.toPartyId, effectiveOn: input.effectiveOn, documentId: input.documentId ?? null }
        });
        if (input.effectiveOn <= this.today()) await this.applyOne(client, id, actor);
        const r = await client.query(`${SUCCESSION_SELECT} WHERE s.id = $1`, [id]);
        return mapSuccession(r.rows[0]);
      });
    } catch (error) { throw translate(error); }
  }

  /** 発効日を待たずに適用する。 */
  async apply(id: number, actor: string): Promise<Succession> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.applyOne(client, id, actor);
        const r = await client.query(`${SUCCESSION_SELECT} WHERE s.id = $1`, [id]);
        return mapSuccession(r.rows[0]);
      });
    } catch (error) { throw translate(error); }
  }

  /** 適用した承継を戻す（相手方を from に戻す）。 */
  async revert(id: number, actor: string): Promise<Succession> {
    try {
      return await inTransaction(this.database, async (client) => {
        const s = await this.lock(client, id);
        if (!s.applied_at) throw new DomainError("CONFLICT", "まだ適用していない承継です。消すなら「消す」");
        if (s.reverted_at) throw new DomainError("CONFLICT", "すでに戻した承継です");
        const moved = await this.swap(client, Number(s.agreement_id), Number(s.to_party_id), Number(s.from_party_id));
        await client.query("UPDATE agreement_successions SET reverted_at = now() WHERE id = $1", [id]);
        await recordAudit(client, {
          actor, action: "agreement.succession_revert", targetType: "agreement", targetId: Number(s.agreement_id),
          detail: { successionId: id, ...moved }
        });
        const r = await client.query(`${SUCCESSION_SELECT} WHERE s.id = $1`, [id]);
        return mapSuccession(r.rows[0]);
      });
    } catch (error) { throw translate(error); }
  }

  /** 発効前の承継を消す。適用済みは消せない（戻す）。 */
  async remove(id: number, actor: string): Promise<void> {
    try {
      await inTransaction(this.database, async (client) => {
        const s = await this.lock(client, id);
        if (s.applied_at && !s.reverted_at) throw new DomainError("CONFLICT", "適用済みの承継は消せません。先に戻してください");
        await client.query("DELETE FROM agreement_successions WHERE id = $1", [id]);
        await recordAudit(client, {
          actor, action: "agreement.succession_remove", targetType: "agreement", targetId: Number(s.agreement_id),
          detail: { successionId: id, from: Number(s.from_party_id), to: Number(s.to_party_id), effectiveOn: dateStr(s.effective_on) }
        });
      });
    } catch (error) { throw translate(error); }
  }

  /** 発効日の来た承継を適用する（日次）。 */
  async applyDue(client: Queryable, actor = "system"): Promise<number[]> {
    const due = await client.query(
      `SELECT id FROM agreement_successions
        WHERE applied_at IS NULL AND reverted_at IS NULL AND effective_on <= $1::date ORDER BY effective_on, id`, [this.today()]);
    const ids: number[] = [];
    for (const row of due.rows as any[]) {
      await this.applyOne(client, Number(row.id), actor);
      ids.push(Number(row.id));
    }
    return ids;
  }

  private async lock(client: Queryable, id: number): Promise<Record<string, any>> {
    const r = await client.query("SELECT * FROM agreement_successions WHERE id = $1 FOR UPDATE", [id]);
    const s = r.rows[0] as Record<string, any> | undefined;
    if (!s) throw new DomainError("NOT_FOUND", `承継 ${id} が見つかりません`);
    return s;
  }

  private async applyOne(client: Queryable, id: number, actor: string): Promise<void> {
    const s = await this.lock(client, id);
    if (s.applied_at) throw new DomainError("CONFLICT", "すでに適用した承継です");
    const moved = await this.swap(client, Number(s.agreement_id), Number(s.from_party_id), Number(s.to_party_id));
    await client.query("UPDATE agreement_successions SET applied_at = now() WHERE id = $1", [id]);
    await recordAudit(client, {
      actor, action: "agreement.succession_apply", targetType: "agreement", targetId: Number(s.agreement_id),
      detail: { successionId: id, effectiveOn: dateStr(s.effective_on), ...moved }
    });
  }

  /**
   * 契約（と、その下の個別契約・解除合意）と、それらに載る条件の相手方を from → to に切り替える。
   * 実績・支払文書・支払は触らない（発効日前のものは from 宛てのまま）。
   */
  private async swap(client: Queryable, agreementId: number, from: number, to: number): Promise<{ from: number; to: number; agreements: number; conditions: number }> {
    const a = await client.query(
      `UPDATE agreements SET counterparty_id = $3, updated_at = now()
        WHERE (id = $1 OR parent_id = $1) AND counterparty_id = $2 RETURNING id`, [agreementId, from, to]);
    const ids = (a.rows as any[]).map((x) => Number(x.id));
    let conditions = 0;
    if (ids.length) {
      const c = await client.query(
        `UPDATE conditions SET counterparty_id = $2, updated_at = now()
          WHERE agreement_id = ANY($3::bigint[]) AND counterparty_id = $1 AND status NOT IN ('superseded', 'void') RETURNING id`,
        [from, to, ids]);
      conditions = c.rows.length;
    }
    return { from, to, agreements: ids.length, conditions };
  }
}
