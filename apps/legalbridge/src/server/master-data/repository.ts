import type { DatabasePool } from "../db/pool.js";

export type MasterDataType = "vendor" | "staff" | "document" | "work" | "company";

export interface MasterDataItem {
  id: string;
  type: MasterDataType;
  label: string;
  description?: string;
  values: Record<string, unknown>;
}

export interface MasterDataRepository {
  search(type: MasterDataType, query: string, limit?: number): Promise<MasterDataItem[]>;
}

export class PgMasterDataRepository implements MasterDataRepository {
  constructor(private readonly database: DatabasePool) {}

  async search(type: MasterDataType, query: string, limit = 20) {
    if (type === "company") return companyProfile();
    const keyword = `%${query.trim()}%`;
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    if (type === "vendor") {
      const result = await this.database.query(
        `SELECT id, vendor_code, vendor_name, trade_name, pen_name, vendor_suffix,
                entity_type, address, phone, email, contact_department, contact_name,
                vendor_rep, bank_info, bank_name, branch_name, account_type,
                account_number, account_holder_kana, is_invoice_issuer,
                invoice_registration_number, withholding_enabled
           FROM vendors
          WHERE is_active
            AND ($1 = '%%'
             OR vendor_name ILIKE $1
             OR vendor_code ILIKE $1
             OR COALESCE(trade_name, '') ILIKE $1
             OR COALESCE(pen_name, '') ILIKE $1)
          ORDER BY vendor_name
          LIMIT $2`,
        [keyword, boundedLimit]
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        type,
        label: row.vendor_name,
        description: [row.vendor_code, row.entity_type, row.contact_name].filter(Boolean).join("・"),
        values: row
      }));
    }
    if (type === "staff") {
      const result = await this.database.query(
        `SELECT id, slack_user_id, staff_name, email, phone, department, department_code
           FROM staff
          WHERE $1 = '%%'
             OR staff_name ILIKE $1
             OR COALESCE(email, '') ILIKE $1
             OR COALESCE(department, '') ILIKE $1
          ORDER BY department NULLS LAST, staff_name
          LIMIT $2`,
        [keyword, boundedLimit]
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        type,
        label: row.staff_name,
        description: [row.department, row.email].filter(Boolean).join("・"),
        values: row
      }));
    }
    if (type === "document") {
      const result = await this.database.query(
        `SELECT id, document_number, template_type, issue_key, vendor_name_snapshot,
                created_at, form_data
           FROM documents
          WHERE document_number IS NOT NULL
            AND ($1 = '%%'
              OR document_number ILIKE $1
              OR template_type ILIKE $1
              OR COALESCE(vendor_name_snapshot, '') ILIKE $1
              OR COALESCE(form_data->>'CONTRACT_TITLE', form_data->>'基本契約名', '') ILIKE $1)
          ORDER BY created_at DESC
          LIMIT $2`,
        [keyword, boundedLimit]
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        type,
        label: row.document_number,
        description: [
          row.form_data?.CONTRACT_TITLE ?? row.form_data?.基本契約名 ?? row.template_type,
          row.vendor_name_snapshot
        ].filter(Boolean).join("・"),
        values: {
          id: row.id,
          document_number: row.document_number,
          template_type: row.template_type,
          issue_key: row.issue_key,
          vendor_name: row.vendor_name_snapshot,
          created_at: row.created_at,
          ...(row.form_data ?? {})
        }
      }));
    }
    const result = await this.database.query(
      `(SELECT 'work' AS source_type, id, work_code AS code, title,
               work_type AS category, remarks
         FROM works
         WHERE is_active = TRUE
           AND ($1 = '%%' OR title ILIKE $1 OR work_code ILIKE $1))
       UNION ALL
       (SELECT 'source_ip' AS source_type, id, source_code AS code, title,
               'source_ip' AS category, remarks
         FROM source_ips
         WHERE is_active = TRUE
           AND ($1 = '%%' OR title ILIKE $1 OR source_code ILIKE $1))
       ORDER BY title
       LIMIT $2`,
      [keyword, boundedLimit]
    );
    return result.rows.map((row) => ({
      id: `${row.source_type}:${row.id}`,
      type,
      label: row.title,
      description: [row.code, row.category].filter(Boolean).join("・"),
      values: row
    }));
  }
}

export class MemoryMasterDataRepository implements MasterDataRepository {
  constructor(private readonly items: MasterDataItem[] = companyProfile()) {}

  async search(type: MasterDataType, query: string, limit = 20) {
    const keyword = query.trim().toLowerCase();
    return this.items
      .filter((item) => item.type === type)
      .filter((item) => !keyword || `${item.label} ${item.description ?? ""}`.toLowerCase().includes(keyword))
      .slice(0, limit);
  }
}

function companyProfile(): MasterDataItem[] {
  return [{
    id: "arclight",
    type: "company",
    label: "株式会社アークライト",
    description: "自社プロファイル",
    values: {
      name: "株式会社アークライト",
      address: "東京都千代田区神田小川町1-2 風雲堂ビル2階",
      rep: "代表取締役　青柳 昌行"
    }
  }];
}
