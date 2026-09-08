import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";

export interface PartyInput {
  name: string;
  kind: "corporate" | "individual";
  nameKana?: string | null;
  aliases?: string[];
  invoiceNo?: string | null;
  corporateNo?: string | null;
  withholding?: boolean;
  /** 指定しなければ採番する。 */
  partyCode?: string | null;
}

export interface PartyContactInput {
  role: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  department?: string | null;
}

const NUMBER = { prefix: "PTY", table: "parties", column: "party_code" };

/** 同じ相手先を二重に作らないための照合。表記ゆれは拾えないので完全一致だけ見る。 */
async function findSameName(client: Queryable, name: string) {
  const r = await client.query(
    `SELECT id, party_code, name, status FROM parties
      WHERE btrim(name) = btrim($1) AND status <> 'merged' LIMIT 5`, [name]);
  return r.rows as Array<{ id: number; party_code: string | null; name: string; status: string }>;
}

export class PartyWriteService {
  constructor(private readonly database: Transactable) {}

  /**
   * 取引先の登録。
   *
   * 同名の相手先が既にいれば既定では作らない。V1 の取引先が2,552件まで膨らんだ
   * のは、同じ相手を登録し直す経路が塞がれていなかったことが一因なので、
   * 作る前に必ず突き当てる。意図して別法人を作るときだけ allowDuplicate を渡す。
   */
  async create(
    input: PartyInput, actor: string, options: { allowDuplicate?: boolean } = {}
  ): Promise<{ id: number; partyCode: string | null; duplicates?: Array<{ id: number; name: string }> }> {
    const name = String(input.name ?? "").trim();
    if (!name) throw new DomainError("VALIDATION", "取引先名は必須です");

    try {
      return await inTransaction(this.database, async (client) => {
        if (!options.allowDuplicate) {
          const same = await findSameName(client, name);
          if (same.length) {
            throw new DomainError(
              "CONFLICT",
              `同じ名前の取引先が既にあります（${same.map((s) => s.party_code ?? `#${s.id}`).join(", ")}）。` +
              "同一なら既存を使い、別法人なら「同名でも新規に作る」を選んでください",
              { duplicates: same.map((s) => ({ id: Number(s.id), name: s.name })) });
          }
        }

        const code = String(input.partyCode ?? "").trim()
          || await allocateNumber(client, NUMBER);

        const inserted = await client.query(
          `INSERT INTO parties (party_code, kind, name, name_kana, aliases,
                                invoice_no, corporate_no, withholding, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
           RETURNING id, party_code`,
          [code, input.kind, name, input.nameKana ?? null,
           input.aliases ?? [], input.invoiceNo ?? null, input.corporateNo ?? null,
           input.withholding === true]);
        const row = inserted.rows[0] as { id: number; party_code: string | null };

        await recordAudit(client, {
          actor, action: "party.create", targetType: "party", targetId: Number(row.id),
          detail: { name, kind: input.kind, partyCode: row.party_code }
        });
        return { id: Number(row.id), partyCode: row.party_code };
      });
    } catch (error) { throw translate(error); }
  }

  /** 連絡先の登録・差し替え。役割ごとに1件（UNIQUE (party_id, role)）。 */
  async upsertContact(partyId: number, input: PartyContactInput, actor: string) {
    const role = String(input.role ?? "").trim();
    if (!role) throw new DomainError("VALIDATION", "連絡先の役割は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const party = await client.query("SELECT id FROM parties WHERE id = $1", [partyId]);
        if (!party.rows[0]) throw new DomainError("NOT_FOUND", `取引先 ${partyId} が見つかりません`);

        await client.query(
          `INSERT INTO party_contacts (party_id, role, name, email, phone, department)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (party_id, role) DO UPDATE SET
             name = EXCLUDED.name, email = EXCLUDED.email,
             phone = EXCLUDED.phone, department = EXCLUDED.department`,
          [partyId, role, input.name ?? null, input.email ?? null,
           input.phone ?? null, input.department ?? null]);

        await recordAudit(client, {
          actor, action: "party.upsert_contact", targetType: "party", targetId: partyId,
          detail: { role, email: input.email ?? null }
        });
        return { partyId, role };
      });
    } catch (error) { throw translate(error); }
  }
}
