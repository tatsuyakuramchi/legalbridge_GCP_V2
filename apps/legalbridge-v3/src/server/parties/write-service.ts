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

export interface StaffInput {
  name?: string;
  email?: string | null;
  department?: string | null;
  phone?: string | null;
  status?: "active" | "retired";
}

export interface BankAccountInput {
  bankName?: string | null;
  branchName?: string | null;
  accountType?: string | null;
  accountNumber?: string | null;
  accountHolderKana?: string | null;
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

  /**
   * 取引先の口座を直す。
   *
   * 移行してきた 2498 件のうち 460 件が口座番号か名義を欠いていて、そのまま
   * では振り込めない（うち 383 件は名義だけが無い）。V1 の元データが同じ形で、
   * 移行の取りこぼしではない。直す先が要る。
   *
   * 触れる経路はここ1つだけ。表への書込権限も INSERT と UPDATE しか無い
   * （行ごと消す道は用意しない。使わない口座は各欄を空にする）。
   *
   * 監査には「どの項目を触ったか」だけ残す。口座番号や名義そのものは書かない。
   * audit_events は運用の画面から誰でも読めるので、そこへ写すと、表を
   * SELECT だけに絞ってある意味が無くなる。
   */
  async saveBankAccount(partyId: number, input: BankAccountInput, actor: string) {
    const clean = (v: string | null | undefined) =>
      v === null || v === undefined ? null : (String(v).trim() || null);
    const values = {
      bank_name: clean(input.bankName),
      branch_name: clean(input.branchName),
      account_type: clean(input.accountType),
      account_number: clean(input.accountNumber),
      account_holder_kana: clean(input.accountHolderKana)
    };

    try {
      return await inTransaction(this.database, async (client) => {
        const party = await client.query(
          "SELECT id, name FROM parties WHERE id = $1", [partyId]);
        const row = party.rows[0] as { name: string } | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `取引先 ${partyId} が見つかりません`);

        await client.query(
          `INSERT INTO party_bank_accounts
             (party_id, bank_name, branch_name, account_type,
              account_number, account_holder_kana)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (party_id) DO UPDATE SET
             bank_name = EXCLUDED.bank_name, branch_name = EXCLUDED.branch_name,
             account_type = EXCLUDED.account_type,
             account_number = EXCLUDED.account_number,
             account_holder_kana = EXCLUDED.account_holder_kana,
             updated_at = now()`,
          [partyId, values.bank_name, values.branch_name, values.account_type,
           values.account_number, values.account_holder_kana]);

        await recordAudit(client, {
          actor, action: "party.save_bank_account", targetType: "party", targetId: partyId,
          // 値は残さない。入れたか空にしたかだけ。
          detail: {
            partyName: row.name,
            filled: Object.entries(values).filter(([, v]) => v !== null).map(([k]) => k),
            cleared: Object.entries(values).filter(([, v]) => v === null).map(([k]) => k)
          }
        });
        return { partyId };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 自社の担当者を直す。
   *
   * 検収書は【ご連絡先】に担当者の部署・氏名・メールを差し、そこに
   * 「5営業日以内に異議を」と書く。メールが空だと、期限だけ書いてあって
   * 連絡先が無い紙になる。それなのに staff は移行で入れたきり、
   * V3 から直す経路がどこにも無かった。
   */
  async updateStaff(id: number, input: StaffInput, actor: string) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const changed: string[] = [];
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
      changed.push(column);
    };

    if (input.name !== undefined) {
      const name = String(input.name).trim();
      // 氏名は書類に出るので空にはできない。退職者は status で外す。
      if (!name) throw new DomainError("VALIDATION", "担当者の氏名は空にできません");
      put("name", name);
    }
    // 空文字は「消す」。NULL で持たないと、書類側の空欄判定が効かない。
    const blankToNull = (v: string | null | undefined) =>
      v === null || v === undefined ? null : (String(v).trim() || null);
    if (input.email !== undefined) put("email", blankToNull(input.email));
    if (input.department !== undefined) put("department", blankToNull(input.department));
    if (input.phone !== undefined) put("phone", blankToNull(input.phone));
    if (input.status !== undefined) put("status", input.status);
    if (!sets.length) throw new DomainError("VALIDATION", "直す項目がありません");

    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE staff SET ${sets.join(", ")} WHERE id = $1
           RETURNING id, staff_code, name, email, department, phone, status`, params);
        const row = r.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `担当者 ${id} が見つかりません`);

        await recordAudit(client, {
          actor, action: "staff.update", targetType: "staff", targetId: id,
          detail: { fields: changed, name: row.name }
        });
        return {
          id: Number(row.id), staffCode: row.staff_code ?? null, name: String(row.name),
          email: row.email ?? null, department: row.department ?? null,
          phone: row.phone ?? null, status: String(row.status)
        };
      });
    } catch (error) { throw translate(error); }
  }
}
