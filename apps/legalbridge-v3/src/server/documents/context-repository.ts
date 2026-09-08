import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";

/**
 * テンプレート変数の供給元になる文脈を、条件・合意・当事者・作品から組み立てる。
 * ここが V2 の form_data に相当する位置だが、値は全部ドメインから来る。
 */
export interface DocumentContextInput {
  conditionIds: number[];
  agreementId?: number | null;
  matterId?: number | null;
  documentNumber?: string | null;
  issuedOn?: string | null;
  /** 実績。検収書・納品書はここの日付と金額が要る。 */
  eventIds?: number[];
  /** 計算結果。利用許諾料計算書は、発行の時点でこれが要る。 */
  royalty?: Record<string, unknown> | null;
}

const MINOR: Record<string, number> = { JPY: 1, KRW: 1, VND: 1 };
/** 最小通貨単位から表示用の額へ戻す。 */
export const toMajor = (amount: number | null, currency: string): number | null =>
  amount === null || amount === undefined ? null : amount / (MINOR[currency] ?? 100);

const honorificFor = (kind: string | null) => (kind === "individual" ? "様" : "御中");

export class DocumentContextRepository {
  constructor(private readonly database: Transactable) {}

  async build(input: DocumentContextInput, client: Queryable = this.database) {
    try {
      const conditions = await this.conditions(client, input.conditionIds);
      if (input.conditionIds.length && !conditions.length) {
        throw new DomainError("NOT_FOUND", "指定された条件が見つかりません");
      }
      const agreementId = input.agreementId ?? conditions[0]?.agreementId ?? null;
      // client はトランザクションの接続で渡ってくることがある。1本の接続に
      // 同時に問い合わせられないので、順に読む。
      const agreement = agreementId ? await this.agreement(client, agreementId) : null;
      const matter = input.matterId ? await this.matter(client, input.matterId) : null;
      const company = await this.company(client);
      const events = input.eventIds?.length ? await this.events(client, input.eventIds) : [];
      // 取引先の担当者（署名者・請求先）と、案件の担当スタッフ。
      // 書類の宛名や検収者はここから引ける。
      const partyId = conditions[0]?.counterpartyId ?? null;
      const contacts = partyId ? await this.contacts(client, partyId) : [];
      const bank = partyId ? await this.bank(client, partyId) : null;
      const owner = input.matterId ? await this.owner(client, input.matterId) : null;

      const currency = conditions[0]?.currency ?? "JPY";
      const exTax = conditions.reduce((sum, c) => sum + (c.flatAmountMinor ?? 0), 0);
      const taxable = conditions
        .filter((c) => c.taxCategory !== "exempt")
        .reduce((sum, c) => sum + (c.flatAmountMinor ?? 0), 0);
      const tax = Math.ceil(taxable * 0.1);

      return {
        document: {
          number: input.documentNumber ?? null,
          issuedOn: input.issuedOn ?? dateStr(new Date())
        },
        company,
        matter,
        agreement,
        conditions,
        /** 単一条件のテンプレートはこちらを使う。 */
        condition: conditions[0] ?? null,
        events,
        /** 取引先の担当者。role ごとに引ける（primary / signer / billing）。 */
        contacts,
        /** 振込先。支払通知書・請求書はこれが無いと成立しない。 */
        bank,
        /** 案件の担当スタッフ。検収者の既定になりうる。 */
        owner,
        /** 実績が1件のときはこちら。検収書はこの日付と金額を使う。 */
        event: events[0] ?? null,
        /** その実績の予定明細。支払期日はここから来る。 */
        schedule: events[0]?.schedule ?? null,
        /** 計算書の金額。試算の結果をそのまま渡す。無ければ null。 */
        royalty: input.royalty ?? null,
        totals: {
          exTax: toMajor(exTax, currency),
          tax: toMajor(tax, currency),
          incTax: toMajor(exTax + tax, currency),
          currency
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 実績。検収書の「実納品日」「納品額」はここから来る。
   * これまでコンテキストに入っておらず、実績から検収書を作っても
   * 日付も金額も人が打ち直すことになっていた。
   */
  /** 取引先の担当者。役割ごとに1件までなので、そのまま並べる。 */
  private async contacts(client: Queryable, partyId: number) {
    const r = await client.query(
      `SELECT role, name, email, phone, department FROM party_contacts
        WHERE party_id = $1 ORDER BY role`, [partyId]);
    return (r.rows as Array<Record<string, any>>).map((row) => ({
      role: String(row.role),
      name: str(row.name), email: str(row.email),
      phone: str(row.phone), department: str(row.department)
    }));
  }

  /**
   * 振込先。読み取りだけ許可してある（003_grants）。
   * 権限が無い環境でも書類の作成そのものは止めないよう、失敗は握って null を返す。
   */
  private async bank(client: Queryable, partyId: number) {
    try {
      const r = await client.query(
        `SELECT bank_name, branch_name, account_type, account_number, account_holder_kana
           FROM party_bank_accounts WHERE party_id = $1`, [partyId]);
      const row = r.rows[0] as Record<string, any> | undefined;
      if (!row) return null;
      return {
        bankName: str(row.bank_name), branchName: str(row.branch_name),
        accountType: str(row.account_type), accountNumber: str(row.account_number),
        holderKana: str(row.account_holder_kana)
      };
    } catch {
      // 口座表への権限が無い環境（閉じたまま運用する場合）。書類は作れる。
      return null;
    }
  }

  /** 案件の担当者。検収書の「検収者」はたいていこの人。 */
  private async owner(client: Queryable, matterId: number) {
    const r = await client.query(
      `SELECT s.name, s.email, s.department, s.staff_code
         FROM matters m JOIN staff s ON s.id = m.owner_staff_id
        WHERE m.id = $1`, [matterId]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return {
      name: String(row.name), email: str(row.email),
      department: str(row.department), staffCode: str(row.staff_code)
    };
  }

  private async events(client: Queryable, ids: number[]) {
    const r = await client.query(
      `SELECT e.id, e.event_type, e.occurred_on, e.period, e.quantity,
              e.gross_amount, e.deductions, e.amount, e.note,
              c.currency, s.label AS schedule_label, s.seq AS schedule_seq,
              s.due_on AS schedule_due_on, s.pay_on AS schedule_pay_on
         FROM condition_events e
         JOIN conditions c ON c.id = e.condition_id
         LEFT JOIN condition_schedules s ON s.id = e.schedule_id
        WHERE e.id = ANY($1::bigint[]) AND e.status = 'active'
        ORDER BY e.occurred_on, e.id`, [ids]);
    return (r.rows as Array<Record<string, any>>).map((row) => {
      const currency = String(row.currency ?? "JPY");
      return {
        id: Number(row.id),
        eventType: String(row.event_type),
        occurredOn: dateStr(row.occurred_on),
        period: str(row.period) ?? str(row.schedule_label),
        seq: int(row.schedule_seq),
        quantity: int(row.quantity),
        grossAmount: toMajor(int(row.gross_amount), currency),
        deductions: toMajor(int(row.deductions), currency),
        amount: toMajor(int(row.amount), currency),
        amountMinor: int(row.amount) ?? 0,
        note: str(row.note),
        currency,
        /** その回の予定。支払期日は支払通知書に要る。 */
        schedule: row.schedule_seq === null ? null : {
          seq: int(row.schedule_seq), label: str(row.schedule_label),
          dueOn: dateStr(row.schedule_due_on), payOn: dateStr(row.schedule_pay_on)
        }
      };
    });
  }

  private async conditions(client: Queryable, ids: number[]) {
    if (!ids.length) return [];
    const result = await client.query(
      `SELECT c.id, c.condition_no, c.name, c.direction, c.kind, c.currency, c.pricing_model,
              c.rate_ppm, c.unit_amount, c.flat_amount, c.mg_amount, c.ag_amount,
              c.term_start, c.term_end, c.tax_category, c.payment_terms, c.cycle,
              c.agreement_id, c.exclusivity, c.sublicensable, c.notes,
              c.counterparty_id,
              p.name AS party_name, p.name_kana AS party_kana, p.kind AS party_kind,
              p.invoice_no AS party_invoice_no, p.corporate_no AS party_corporate_no,
              w.title AS work_title, w.work_code, wp.name AS part_name
         FROM conditions c
         LEFT JOIN parties p    ON p.id = c.counterparty_id
         LEFT JOIN works w      ON w.id = c.work_id
         LEFT JOIN work_parts wp ON wp.id = c.work_part_id
        WHERE c.id = ANY($1::bigint[])
        ORDER BY array_position($1::bigint[], c.id)`,
      [ids]
    );
    return result.rows.map((row: Record<string, any>) => {
      const currency = String(row.currency ?? "JPY");
      return {
        id: Number(row.id),
        conditionNo: str(row.condition_no),
        name: String(row.name ?? ""),
        direction: String(row.direction),
        kind: String(row.kind),
        currency,
        pricingModel: String(row.pricing_model),
        ratePct: row.rate_ppm === null || row.rate_ppm === undefined
          ? null : Number(row.rate_ppm) / 10000,
        unitAmount: toMajor(int(row.unit_amount), currency),
        flatAmount: toMajor(int(row.flat_amount), currency),
        mgAmount: toMajor(int(row.mg_amount), currency),
        agAmount: toMajor(int(row.ag_amount), currency),
        flatAmountMinor: int(row.flat_amount) ?? 0,
        termStart: dateStr(row.term_start),
        termEnd: dateStr(row.term_end),
        taxCategory: String(row.tax_category ?? "taxable"),
        paymentTerms: str(row.payment_terms),
        cycle: str(row.cycle),
        exclusivity: str(row.exclusivity),
        sublicensable: row.sublicensable,
        notes: str(row.notes),
        agreementId: int(row.agreement_id),
        counterpartyId: int(row.counterparty_id),
        counterparty: {
          name: str(row.party_name) ?? "",
          kana: str(row.party_kana),
          kind: str(row.party_kind),
          invoiceNo: str(row.party_invoice_no),
          corporateNo: str(row.party_corporate_no),
          honorific: honorificFor(str(row.party_kind))
        },
        work: { title: str(row.work_title), code: str(row.work_code), part: str(row.part_name) },
        scopes: { region: [] as string[], language: [] as string[], media: [] as string[] }
      };
    }).map((condition, index, all) => ({ ...condition, index: index + 1, total: all.length }));
  }

  private async agreement(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT a.id, a.agreement_no, a.title, a.direction, a.status,
              a.executed_on, a.effective_on, a.expires_on,
              a.auto_renewal, a.renewal_notice_months,
              p.name AS party_name, p.name_kana AS party_kana, p.kind AS party_kind,
              p.invoice_no, p.corporate_no
         FROM agreements a LEFT JOIN parties p ON p.id = a.counterparty_id
        WHERE a.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      no: str(row.agreement_no),
      title: String(row.title ?? ""),
      direction: String(row.direction),
      status: String(row.status),
      executedOn: dateStr(row.executed_on),
      effectiveOn: dateStr(row.effective_on),
      expiresOn: dateStr(row.expires_on),
      autoRenewal: row.auto_renewal === true,
      renewalNoticeMonths: int(row.renewal_notice_months),
      counterparty: {
        name: str(row.party_name) ?? "",
        kana: str(row.party_kana),
        kind: str(row.party_kind),
        honorific: honorificFor(str(row.party_kind)),
        invoiceNo: str(row.invoice_no),
        corporateNo: str(row.corporate_no)
      }
    };
  }

  private async matter(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT m.id, m.matter_no, m.title, m.kind, s.name AS owner_name
         FROM matters m LEFT JOIN staff s ON s.id = m.owner_staff_id
        WHERE m.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id), no: str(row.matter_no), title: String(row.title ?? ""),
      kind: String(row.kind), ownerName: str(row.owner_name)
    };
  }

  /** 自社情報は settings から（V2 の会社プロファイルに相当）。 */
  private async company(client: Queryable) {
    const r = await client.query("SELECT value FROM settings WHERE key = 'company_profile'");
    const value = (r.rows[0] as { value?: Record<string, unknown> } | undefined)?.value;
    return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  }

  /** 範囲は行数が多いので条件をまとめて1回で引く。 */
  async attachScopes(client: Queryable, conditions: Array<{ id: number; scopes: Record<string, string[]> }>) {
    if (!conditions.length) return;
    const r = await client.query(
      `SELECT condition_id, scope_type, label FROM condition_scopes
        WHERE condition_id = ANY($1::bigint[]) ORDER BY sort_order, label`,
      [conditions.map((c) => c.id)]
    );
    for (const row of r.rows as Array<Record<string, any>>) {
      const target = conditions.find((c) => c.id === Number(row.condition_id));
      const bucket = target?.scopes[String(row.scope_type)];
      if (bucket) bucket.push(String(row.label));
    }
  }
}
