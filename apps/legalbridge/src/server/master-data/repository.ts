import type { DatabasePool } from "../db/pool.js";
import type { AppSettingsRepository } from "../settings/settings-repository.js";
import { loadCompanyProfile, type CompanyProfile } from "../settings/company-profile.js";

export type MasterDataType = "vendor" | "staff" | "document" | "work" | "company";

export interface MasterDataItem {
  id: string;
  type: MasterDataType;
  label: string;
  description?: string;
  values: Record<string, unknown>;
}

export interface MasterDataRepository {
  search(
    type: MasterDataType, query: string, limit?: number,
    // 文書検索のみ有効：template_type の前方一致で絞る（空＝全文書）。
    templatePrefixes?: string[]
  ): Promise<MasterDataItem[]>;
}

export class PgMasterDataRepository implements MasterDataRepository {
  constructor(
    private readonly database: DatabasePool,
    // 会社プロファイル（1-6）。app_settings の COMPANY_* を差込に使う（未整備は既定へ縮退）。
    private readonly settings?: AppSettingsRepository
  ) {}

  async search(type: MasterDataType, query: string, limit = 20, templatePrefixes: string[] = []) {
    if (type === "company") return companyProfile(await loadCompanyProfile(this.settings));
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
      const prefixPatterns = templatePrefixes.map((prefix) => `${prefix}%`);
      const result = await this.database.query(
        `SELECT id, document_number, template_type, issue_key, vendor_name_snapshot,
                created_at, form_data
           FROM documents
          WHERE document_number IS NOT NULL
            AND ($3::text[] = '{}' OR template_type LIKE ANY($3))
            AND ($1 = '%%'
              OR document_number ILIKE $1
              OR template_type ILIKE $1
              OR COALESCE(vendor_name_snapshot, '') ILIKE $1
              OR COALESCE(form_data->>'CONTRACT_TITLE', form_data->>'基本契約名', '') ILIKE $1
              OR COALESCE(form_data->>'title', '') ILIKE $1
              OR COALESCE(form_data->>'counterparty', '') ILIKE $1)
          ORDER BY created_at DESC
          LIMIT $2`,
        [keyword, boundedLimit, prefixPatterns]
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        type,
        label: row.document_number,
        description: [
          // title / counterparty は過去文書取込が form_data に記録するキー。
          row.form_data?.CONTRACT_TITLE ?? row.form_data?.基本契約名 ?? row.form_data?.title ?? row.template_type,
          row.vendor_name_snapshot ?? row.form_data?.counterparty
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

  async search(type: MasterDataType, query: string, limit = 20, templatePrefixes: string[] = []) {
    const keyword = query.trim().toLowerCase();
    return this.items
      .filter((item) => item.type === type)
      .filter((item) => !templatePrefixes.length ||
        templatePrefixes.some((prefix) => String(item.values.template_type ?? "").startsWith(prefix)))
      .filter((item) => !keyword || `${item.label} ${item.description ?? ""}`.toLowerCase().includes(keyword))
      .slice(0, limit);
  }
}

function companyProfile(profile?: CompanyProfile): MasterDataItem[] {
  const p = profile ?? { name: "株式会社アークライト", nameKana: "", postalCode: "",
    address: "東京都千代田区神田小川町1-2 風雲堂ビル2階", tel: "", fax: "",
    rep: "代表取締役　青柳 昌行", invoiceNo: "", bankInfo: "", sealNote: "" };
  return [{
    id: "company",
    type: "company",
    label: p.name,
    description: "自社プロファイル（マスタ・設定＞システム設定で編集）",
    values: {
      name: p.name,
      name_kana: p.nameKana,
      postal_code: p.postalCode,
      address: p.address,
      tel: p.tel,
      fax: p.fax,
      rep: p.rep,
      invoice_no: p.invoiceNo,
      bank_info: p.bankInfo,
      seal_note: p.sealNote
    }
  }];
}
