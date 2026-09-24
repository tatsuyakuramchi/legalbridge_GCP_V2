import type { DatabasePool } from "../db/pool.js";
import type { VendorCreateInput, VendorUpdateInput } from "./write-schema.js";

export interface SavedVendor {
  id: number;
  vendorCode: string | null;
}

export class VendorWriteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// Editable vendor record (admin/legal only) for prefilling the edit form.
export interface VendorRecord {
  id: number;
  vendorName: string;
  vendorCode: string | null;
  tradeName: string | null;
  penName: string | null;
  entityType: string | null;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  contactDepartment: string | null;
  contactEmail: string | null;
  signerEmail: string | null;
  address: string | null;
  invoiceRegistrationNumber: string | null;
  vendorRep: string | null;
  corporateNumber: string | null;
  // 口座情報は管理者にのみ返す（find の includeBank=false のとき undefined）。
  bankName?: string | null;
  branchName?: string | null;
  accountType?: string | null;
  accountNumber?: string | null;
  accountHolderKana?: string | null;
  accountScope?: "domestic" | "overseas";
  swiftBic?: string | null;
  iban?: string | null;
  routingNumber?: string | null;
  accountHolderName?: string | null;
  bankCountry?: string | null;
  bankAddress?: string | null;
  bankCurrency?: string | null;
  intermediaryBankSwift?: string | null;
  intermediaryBankName?: string | null;
  bankInfo?: string | null;
  isInvoiceIssuer: boolean;
  withholdingEnabled: boolean;
  isActive: boolean;
}

export interface VendorWriteRepository {
  createVendor(input: VendorCreateInput, createdBy: string): Promise<SavedVendor>;
  updateVendor(id: number, input: VendorUpdateInput): Promise<SavedVendor>;
  // includeBank=true のときだけ口座情報を含める（既定は含めない＝機微情報の既定非開示）。
  find(id: number, options?: { includeBank?: boolean }): Promise<VendorRecord | null>;
}

// vendors 本体には帳票互換用の代表口座（国内項目）だけをミラーする。
// 海外送金固有項目は vendor_bank_accounts の primary 行を正とする。
const COLUMNS: Record<string, string> = {
  vendorName: "vendor_name",
  vendorCode: "vendor_code",
  tradeName: "trade_name",
  penName: "pen_name",
  entityType: "entity_type",
  email: "email",
  phone: "phone",
  contactName: "contact_name",
  contactDepartment: "contact_department",
  contactEmail: "contact_email",
  signerEmail: "signer_email",
  address: "address",
  invoiceRegistrationNumber: "invoice_registration_number",
  vendorRep: "vendor_rep",
  corporateNumber: "corporate_number",
  bankName: "bank_name",
  branchName: "branch_name",
  accountType: "account_type",
  accountNumber: "account_number",
  accountHolderKana: "account_holder_kana",
  bankInfo: "bank_info",
  isInvoiceIssuer: "is_invoice_issuer",
  withholdingEnabled: "withholding_enabled",
  isActive: "is_active"
};

const CHILD_BANK_KEYS = [
  "bankName", "branchName", "accountType", "accountNumber", "accountHolderKana",
  "accountScope", "swiftBic", "iban", "routingNumber", "accountHolderName",
  "bankCountry", "bankAddress", "bankCurrency", "intermediaryBankSwift",
  "intermediaryBankName"
] as const;

type BankInput = VendorCreateInput | VendorUpdateInput;
type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

function hasBankPayload(input: BankInput) {
  const source = input as Record<string, unknown>;
  return CHILD_BANK_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function hasMeaningfulBankValue(input: BankInput) {
  const source = input as Record<string, unknown>;
  return CHILD_BANK_KEYS
    .filter((key) => key !== "accountScope")
    .some((key) => {
      const value = source[key];
      return value !== undefined && value !== null && String(value).trim() !== "";
    });
}

function choose<T>(input: Record<string, unknown>, key: string, current: T | null): T | null {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? (input[key] as T | null)
    : current;
}

async function upsertPrimaryBankAccount(q: Queryable, vendorId: number, input: BankInput) {
  const source = input as Record<string, unknown>;
  const existingResult = await q.query(
    `SELECT id, bank_name, branch_name, account_type, account_number, account_holder_kana,
            account_scope, swift_bic, iban, routing_number, account_holder_name,
            bank_country, bank_address, currency, intermediary_bank_swift, intermediary_bank_name
       FROM vendor_bank_accounts
      WHERE vendor_id = $1
      ORDER BY is_primary DESC, sort_order ASC, id ASC
      LIMIT 1
      FOR UPDATE`,
    [vendorId]
  );
  const existing = existingResult.rows[0] ?? null;

  // 新規取引先で口座欄が全て空の場合は、空の子テーブル行を作らない。
  if (!existing && !hasMeaningfulBankValue(input)) return;

  const accountScope =
    choose<string>(source, "accountScope", existing?.account_scope ?? null)
    || (["swiftBic", "iban", "routingNumber", "accountHolderName", "bankCountry", "bankAddress",
         "bankCurrency", "intermediaryBankSwift", "intermediaryBankName"]
      .some((key) => {
        const value = source[key];
        return value !== undefined && value !== null && String(value).trim() !== "";
      }) ? "overseas" : "domestic");

  const isOverseas = accountScope === "overseas";
  const values = {
    bankName: choose<string>(source, "bankName", existing?.bank_name ?? null),
    branchName: choose<string>(source, "branchName", existing?.branch_name ?? null),
    accountType: choose<string>(source, "accountType", existing?.account_type ?? null),
    accountNumber: choose<string>(source, "accountNumber", existing?.account_number ?? null),
    accountHolderKana: choose<string>(source, "accountHolderKana", existing?.account_holder_kana ?? null),
    accountScope: isOverseas ? "overseas" : "domestic",
    // 国内へ切り替えたとき海外固有値を残すと、後日の帳票引用で古いSWIFT/IBANが
    // 混入するため明示的に消す。海外のときだけ既存値/入力値を保持する。
    swiftBic: isOverseas ? choose<string>(source, "swiftBic", existing?.swift_bic ?? null) : null,
    iban: isOverseas ? choose<string>(source, "iban", existing?.iban ?? null) : null,
    routingNumber: isOverseas ? choose<string>(source, "routingNumber", existing?.routing_number ?? null) : null,
    accountHolderName: isOverseas ? choose<string>(source, "accountHolderName", existing?.account_holder_name ?? null) : null,
    bankCountry: isOverseas ? choose<string>(source, "bankCountry", existing?.bank_country ?? null) : null,
    bankAddress: isOverseas ? choose<string>(source, "bankAddress", existing?.bank_address ?? null) : null,
    bankCurrency: isOverseas ? choose<string>(source, "bankCurrency", existing?.currency ?? null) : null,
    intermediaryBankSwift: isOverseas
      ? choose<string>(source, "intermediaryBankSwift", existing?.intermediary_bank_swift ?? null) : null,
    intermediaryBankName: isOverseas
      ? choose<string>(source, "intermediaryBankName", existing?.intermediary_bank_name ?? null) : null
  };

  let bankId: number;
  if (existing) {
    const updated = await q.query(
      `UPDATE vendor_bank_accounts
          SET bank_name = $1, branch_name = $2, account_type = $3, account_number = $4,
              account_holder_kana = $5, account_scope = $6, swift_bic = $7, iban = $8,
              routing_number = $9, account_holder_name = $10, bank_country = $11,
              bank_address = $12, currency = $13, intermediary_bank_swift = $14,
              intermediary_bank_name = $15, is_primary = TRUE, updated_at = CURRENT_TIMESTAMP
        WHERE id = $16
        RETURNING id`,
      [
        values.bankName, values.branchName, values.accountType, values.accountNumber,
        values.accountHolderKana, values.accountScope, values.swiftBic, values.iban,
        values.routingNumber, values.accountHolderName, values.bankCountry,
        values.bankAddress, values.bankCurrency, values.intermediaryBankSwift,
        values.intermediaryBankName, existing.id
      ]
    );
    bankId = Number(updated.rows[0].id);
  } else {
    const inserted = await q.query(
      `INSERT INTO vendor_bank_accounts
        (vendor_id, bank_name, branch_name, account_type, account_number, account_holder_kana,
         is_primary, sort_order, account_scope, swift_bic, iban, routing_number,
         account_holder_name, bank_country, bank_address, currency,
         intermediary_bank_swift, intermediary_bank_name)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        vendorId, values.bankName, values.branchName, values.accountType, values.accountNumber,
        values.accountHolderKana, values.accountScope, values.swiftBic, values.iban,
        values.routingNumber, values.accountHolderName, values.bankCountry,
        values.bankAddress, values.bankCurrency, values.intermediaryBankSwift,
        values.intermediaryBankName
      ]
    );
    bankId = Number(inserted.rows[0].id);
  }

  // V2 は現時点では「メイン振込先」1口座の編集UI。既存の複数口座は残しつつ、
  // 編集した行だけを primary として帳票・マスタ引用の優先口座にする。
  await q.query(
    "UPDATE vendor_bank_accounts SET is_primary = FALSE WHERE vendor_id = $1 AND id <> $2 AND is_primary = TRUE",
    [vendorId, bankId]
  );

  // 国内帳票との後方互換のため vendors の代表単一列にもミラーする。
  // 海外固有値（SWIFT/IBAN等）は子テーブルにのみ保持する。
  await q.query(
    `UPDATE vendors
        SET bank_name = $1, branch_name = $2, account_type = $3,
            account_number = $4, account_holder_kana = $5
      WHERE id = $6`,
    [
      values.bankName, values.branchName, values.accountType,
      values.accountNumber, values.accountHolderKana, vendorId
    ]
  );
}

export class PgVendorWriteRepository implements VendorWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async createVendor(input: VendorCreateInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const columns: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        columns.push(column);
        values.push(value);
      }
      // vendor_code is NOT NULL UNIQUE; auto-number when the caller omits it.
      const hasCode = columns.includes("vendor_code");
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const inserted = await client.query(
        `INSERT INTO vendors (${columns.join(", ")}${hasCode ? "" : ", vendor_code"})
         VALUES (${placeholders.join(", ")}${hasCode ? "" : ", 'PENDING'"})
         RETURNING id, vendor_code`,
        values
      );
      const id = Number(inserted.rows[0].id);
      let vendorCode: string | null = inserted.rows[0].vendor_code ?? null;
      if (!hasCode) {
        const numbered = await client.query(
          `UPDATE vendors SET vendor_code = 'VEN-' || lpad(id::text, GREATEST(length(id::text), 5), '0')
            WHERE id = $1 RETURNING vendor_code`,
          [id]
        );
        vendorCode = numbered.rows[0]?.vendor_code ?? vendorCode;
      }
      // 新規作成時は実際の口座値がある場合だけ子テーブルへ書く。
      // UI は口座区分(domestic)だけ送ることがあるため、それだけで空行を作らない。
      if (hasMeaningfulBankValue(input)) {
        await upsertPrimaryBankAccount(client as unknown as Queryable, id, input);
      }
      await client.query("COMMIT");
      return { id, vendorCode };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async updateVendor(id: number, input: VendorUpdateInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      }

      let row: { id: number; vendor_code: string | null } | undefined;
      if (assignments.length) {
        values.push(id);
        const result = await client.query(
          `UPDATE vendors SET ${assignments.join(", ")}
            WHERE id = $${values.length}
            RETURNING id, vendor_code`,
          values
        );
        row = result.rows[0];
      } else {
        const result = await client.query(
          "SELECT id, vendor_code FROM vendors WHERE id = $1 FOR UPDATE",
          [id]
        );
        row = result.rows[0];
      }

      if (!row) {
        throw new VendorWriteError("VENDOR_NOT_FOUND", "指定した取引先が見つかりません");
      }

      if (hasBankPayload(input)) {
        await upsertPrimaryBankAccount(client as unknown as Queryable, id, input);
      }

      await client.query("COMMIT");
      return { id: Number(row.id), vendorCode: row.vendor_code ?? null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async find(id: number, options: { includeBank?: boolean } = {}) {
    const result = await this.database.query(
      `SELECT id, vendor_name, vendor_code, trade_name, pen_name, entity_type,
              email, phone, contact_name, contact_department,
              contact_email, signer_email, address,
              invoice_registration_number, vendor_rep, corporate_number,
              bank_name, branch_name, account_type, account_number,
              account_holder_kana, bank_info,
              is_invoice_issuer, withholding_enabled,
              COALESCE(is_active, true) AS is_active
         FROM vendors WHERE id = $1`,
      [id]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];

    let primary: any = null;
    if (options.includeBank) {
      try {
        const bankResult = await this.database.query(
          `SELECT bank_name, branch_name, account_type, account_number, account_holder_kana,
                  account_scope, swift_bic, iban, routing_number, account_holder_name,
                  bank_country, bank_address, currency, intermediary_bank_swift,
                  intermediary_bank_name
             FROM vendor_bank_accounts
            WHERE vendor_id = $1
            ORDER BY is_primary DESC, sort_order ASC, id ASC
            LIMIT 1`,
          [id]
        );
        primary = bankResult.rows[0] ?? null;
      } catch (error) {
        // 082 適用前でも国内レガシー口座の参照は壊さない。
        const code = (error as { code?: string })?.code;
        if (code !== "42P01" && code !== "42703" && code !== "42501") throw error;
      }
    }

    const bank = options.includeBank ? {
      bankName: primary?.bank_name ?? row.bank_name ?? null,
      branchName: primary?.branch_name ?? row.branch_name ?? null,
      accountType: primary?.account_type ?? row.account_type ?? null,
      accountNumber: primary?.account_number ?? row.account_number ?? null,
      accountHolderKana: primary?.account_holder_kana ?? row.account_holder_kana ?? null,
      accountScope: primary?.account_scope === "overseas" ? "overseas" as const : "domestic" as const,
      swiftBic: primary?.swift_bic ?? null,
      iban: primary?.iban ?? null,
      routingNumber: primary?.routing_number ?? null,
      accountHolderName: primary?.account_holder_name ?? null,
      bankCountry: primary?.bank_country ?? null,
      bankAddress: primary?.bank_address ?? null,
      bankCurrency: primary?.currency ?? null,
      intermediaryBankSwift: primary?.intermediary_bank_swift ?? null,
      intermediaryBankName: primary?.intermediary_bank_name ?? null,
      bankInfo: row.bank_info ?? null
    } : {};

    return {
      ...bank,
      id: Number(row.id),
      vendorName: String(row.vendor_name ?? ""),
      vendorCode: row.vendor_code ?? null,
      tradeName: row.trade_name ?? null,
      penName: row.pen_name ?? null,
      entityType: row.entity_type ?? null,
      email: row.email ?? null,
      phone: row.phone ?? null,
      contactName: row.contact_name ?? null,
      contactDepartment: row.contact_department ?? null,
      contactEmail: row.contact_email ?? null,
      signerEmail: row.signer_email ?? null,
      address: row.address ?? null,
      invoiceRegistrationNumber: row.invoice_registration_number ?? null,
      vendorRep: row.vendor_rep ?? null,
      corporateNumber: row.corporate_number ?? null,
      isInvoiceIssuer: Boolean(row.is_invoice_issuer),
      withholdingEnabled: Boolean(row.withholding_enabled),
      isActive: row.is_active !== false
    };
  }
}

function translate(error: unknown): Error {
  if (error instanceof VendorWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505") return new VendorWriteError("VENDOR_CONFLICT", "取引先コードが既に存在します");
  if (code === "23502") return new VendorWriteError("VENDOR_REQUIRED", "必須項目が不足しています");
  if (code === "42P01" || code === "42703") {
    return new VendorWriteError(
      "VENDOR_BANK_SCHEMA_MISSING",
      "海外口座用DB列が未適用です。082_vendor_overseas_bank_accounts.sql を先に適用してください"
    );
  }
  if (code === "42501") {
    return new VendorWriteError(
      "VENDOR_BANK_PERMISSION_MISSING",
      "海外口座テーブルへのDB権限が未適用です。082_vendor_overseas_bank_accounts.sql を先に適用してください"
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryVendorWriteRepository implements VendorWriteRepository {
  private seq = 0;
  readonly vendors = new Map<number, Record<string, unknown>>();
  async createVendor(input: VendorCreateInput) {
    const id = ++this.seq;
    const vendorCode = input.vendorCode ?? `VEN-${String(id).padStart(5, "0")}`;
    this.vendors.set(id, { ...input, id, vendorCode });
    return { id, vendorCode };
  }
  async updateVendor(id: number, input: VendorUpdateInput) {
    const existing = this.vendors.get(id);
    if (!existing) throw new VendorWriteError("VENDOR_NOT_FOUND", "指定した取引先が見つかりません");
    Object.assign(existing, input);
    return { id, vendorCode: (existing.vendorCode as string | null) ?? null };
  }
  async find(id: number, options: { includeBank?: boolean } = {}) {
    const v = this.vendors.get(id);
    if (!v) return null;
    const bank = options.includeBank ? {
      bankName: (v.bankName as string | null) ?? null,
      branchName: (v.branchName as string | null) ?? null,
      accountType: (v.accountType as string | null) ?? null,
      accountNumber: (v.accountNumber as string | null) ?? null,
      accountHolderKana: (v.accountHolderKana as string | null) ?? null,
      accountScope: v.accountScope === "overseas" ? "overseas" as const : "domestic" as const,
      swiftBic: (v.swiftBic as string | null) ?? null,
      iban: (v.iban as string | null) ?? null,
      routingNumber: (v.routingNumber as string | null) ?? null,
      accountHolderName: (v.accountHolderName as string | null) ?? null,
      bankCountry: (v.bankCountry as string | null) ?? null,
      bankAddress: (v.bankAddress as string | null) ?? null,
      bankCurrency: (v.bankCurrency as string | null) ?? null,
      intermediaryBankSwift: (v.intermediaryBankSwift as string | null) ?? null,
      intermediaryBankName: (v.intermediaryBankName as string | null) ?? null,
      bankInfo: (v.bankInfo as string | null) ?? null
    } : {};
    return {
      ...bank,
      id, vendorName: String(v.vendorName ?? ""), vendorCode: (v.vendorCode as string | null) ?? null,
      tradeName: (v.tradeName as string | null) ?? null, penName: (v.penName as string | null) ?? null,
      entityType: (v.entityType as string | null) ?? null, email: (v.email as string | null) ?? null,
      phone: (v.phone as string | null) ?? null, contactName: (v.contactName as string | null) ?? null,
      contactDepartment: (v.contactDepartment as string | null) ?? null,
      contactEmail: (v.contactEmail as string | null) ?? null,
      signerEmail: (v.signerEmail as string | null) ?? null,
      address: (v.address as string | null) ?? null,
      invoiceRegistrationNumber: (v.invoiceRegistrationNumber as string | null) ?? null,
      vendorRep: (v.vendorRep as string | null) ?? null,
      corporateNumber: (v.corporateNumber as string | null) ?? null,
      isInvoiceIssuer: Boolean(v.isInvoiceIssuer), withholdingEnabled: Boolean(v.withholdingEnabled),
      isActive: v.isActive !== false
    };
  }
}
