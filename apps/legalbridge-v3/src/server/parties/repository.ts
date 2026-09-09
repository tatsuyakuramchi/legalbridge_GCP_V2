import type { Transactable } from "../core/db.js";
import { str } from "../core/db.js";
import { translate } from "../core/errors.js";

export interface PartySummary {
  id: number; partyCode: string | null; name: string; kind: "corporate" | "individual";
  aliases: string[]; withholding: boolean; status: string; mergedIntoId: number | null;
}

export interface PartyDetail extends PartySummary {
  nameKana: string | null; invoiceNo: string | null; corporateNo: string | null;
  contacts: Array<{ role: string; name: string | null; email: string | null; phone: string | null; department: string | null }>;
  /** 参照している実体の数。名寄せの影響範囲を見るのに使う。 */
  references: { conditions: number; payments: number; documents: number; matters: number };
  /** 口座は権限が無ければ null。表ごと GRANT していないので普通は null。 */
  bankAccount: { bankName: string | null; branchName: string | null; accountType: string | null } | null;
}

const mapSummary = (row: Record<string, any>): PartySummary => ({
  id: Number(row.id),
  partyCode: str(row.party_code),
  name: String(row.name ?? ""),
  kind: row.kind as "corporate" | "individual",
  aliases: (row.aliases as string[] | null) ?? [],
  withholding: row.withholding === true,
  status: String(row.status),
  mergedIntoId: row.merged_into_id === null || row.merged_into_id === undefined
    ? null : Number(row.merged_into_id)
});

export class PartyRepository {
  constructor(private readonly database: Transactable) {}

  async list(keyword = "", limit = 200): Promise<PartySummary[]> {
    try {
      const r = await this.database.query(
        `SELECT id, party_code, name, kind, aliases, withholding, status, merged_into_id
           FROM parties
          WHERE ($1 = '' OR name ILIKE '%' || $1 || '%'
                 OR COALESCE(party_code,'') ILIKE '%' || $1 || '%'
                 OR COALESCE(name_kana,'') ILIKE '%' || $1 || '%'
                 OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE '%' || $1 || '%'))
          ORDER BY status, party_code NULLS LAST, id
          LIMIT $2`,
        [keyword.trim(), Math.min(Math.max(limit, 1), 500)]);
      return r.rows.map(mapSummary);
    } catch (error) { throw translate(error); }
  }

  async find(id: number): Promise<PartyDetail | null> {
    try {
      const head = await this.database.query(
        `SELECT id, party_code, name, name_kana, kind, aliases, withholding, status,
                merged_into_id, invoice_no, corporate_no
           FROM parties WHERE id = $1`, [id]);
      const row = head.rows[0] as Record<string, any> | undefined;
      if (!row) return null;

      const [contacts, refs, bank] = await Promise.all([
        this.database.query(
          "SELECT role, name, email, phone, department FROM party_contacts WHERE party_id = $1 ORDER BY role", [id]),
        this.database.query(
          `SELECT (SELECT count(*)::int FROM conditions WHERE counterparty_id = $1) AS conditions,
                  (SELECT count(*)::int FROM payments   WHERE party_id = $1)        AS payments,
                  (SELECT count(*)::int FROM agreements WHERE counterparty_id = $1) AS agreements,
                  (SELECT count(*)::int FROM matters    WHERE counterparty_id = $1) AS matters`, [id]),
        // 口座は表ごと GRANT していないので、権限不足はそのまま null にする。
        this.database.query(
          "SELECT bank_name, branch_name, account_type FROM party_bank_accounts WHERE party_id = $1", [id])
          .catch(() => ({ rows: [] as Array<Record<string, unknown>>, rowCount: 0 }))
      ]);
      const counts = refs.rows[0] as Record<string, number>;
      const bankRow = bank.rows[0] as Record<string, any> | undefined;

      return {
        ...mapSummary(row),
        nameKana: str(row.name_kana),
        invoiceNo: str(row.invoice_no),
        corporateNo: str(row.corporate_no),
        contacts: contacts.rows.map((c: Record<string, any>) => ({
          role: String(c.role), name: str(c.name), email: str(c.email),
          phone: str(c.phone), department: str(c.department)
        })),
        references: {
          conditions: Number(counts.conditions ?? 0),
          payments: Number(counts.payments ?? 0),
          documents: Number(counts.agreements ?? 0),
          matters: Number(counts.matters ?? 0)
        },
        bankAccount: bankRow
          ? { bankName: str(bankRow.bank_name), branchName: str(bankRow.branch_name), accountType: str(bankRow.account_type) }
          : null
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 口座の全項目。取引先の詳細（誰でも見られる）には口座番号も名義も出さない
   * ので、直すときだけこちらを引く。呼び出し側で admin/legal に絞ってある。
   */
  async bankAccount(partyId: number) {
    try {
      const r = await this.database.query(
        `SELECT bank_name, branch_name, account_type, account_number, account_holder_kana
           FROM party_bank_accounts WHERE party_id = $1`, [partyId]);
      const row = r.rows[0] as Record<string, any> | undefined;
      return {
        bankName: str(row?.bank_name), branchName: str(row?.branch_name),
        accountType: str(row?.account_type), accountNumber: str(row?.account_number),
        accountHolderKana: str(row?.account_holder_kana),
        exists: Boolean(row)
      };
    } catch (error) { throw translate(error); }
  }

  async staff(limit = 200) {
    try {
      const r = await this.database.query(
        `SELECT id, staff_code, name, email, department, phone, status FROM staff
          ORDER BY status, department NULLS LAST, name LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)]);
      return r.rows.map((s: Record<string, any>) => ({
        id: Number(s.id), staffCode: str(s.staff_code), name: String(s.name),
        email: str(s.email), department: str(s.department),
        // 検収書・発注書は STAFF_PHONE も差す。一覧で欠けが見えないと直せない。
        phone: str(s.phone), status: String(s.status)
      }));
    } catch (error) { throw translate(error); }
  }
}
