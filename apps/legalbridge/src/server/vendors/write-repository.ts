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

export interface VendorWriteRepository {
  createVendor(input: VendorCreateInput, createdBy: string): Promise<SavedVendor>;
  updateVendor(id: number, input: VendorUpdateInput): Promise<SavedVendor>;
}

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
  address: "address",
  invoiceRegistrationNumber: "invoice_registration_number",
  isInvoiceIssuer: "is_invoice_issuer",
  withholdingEnabled: "withholding_enabled"
};

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
          `UPDATE vendors SET vendor_code = 'VEN-' || lpad(id::text, 5, '0')
            WHERE id = $1 RETURNING vendor_code`,
          [id]
        );
        vendorCode = numbered.rows[0]?.vendor_code ?? vendorCode;
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
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(id);
    try {
      const result = await this.database.query(
        `UPDATE vendors SET ${assignments.join(", ")}
          WHERE id = $${values.length}
          RETURNING id, vendor_code`,
        values
      );
      if (!result.rows[0]) {
        throw new VendorWriteError("VENDOR_NOT_FOUND", "指定した取引先が見つかりません");
      }
      return { id: Number(result.rows[0].id), vendorCode: result.rows[0].vendor_code ?? null };
    } catch (error) {
      throw translate(error);
    }
  }
}

function translate(error: unknown): Error {
  if (error instanceof VendorWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505") return new VendorWriteError("VENDOR_CONFLICT", "取引先コードが既に存在します");
  if (code === "23502") return new VendorWriteError("VENDOR_REQUIRED", "必須項目が不足しています");
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
}
