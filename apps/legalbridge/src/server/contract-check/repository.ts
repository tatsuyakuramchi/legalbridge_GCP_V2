import type { DatabasePool } from "../db/pool.js";
import { normalizeName, type VendorDocumentRow } from "./engine.js";

// 契約チェック（Phase 16-2）読取リポジトリ。documents / vendors への SELECT のみ（新規 grant 不要）。
// V1 の外部結合（external_assets・cloudsign_requests・稟議）と decision log は移植しない（port spec §6）。

export interface VendorCandidate {
  id: number; vendorCode: string | null; vendorName: string | null; entityType: string | null;
  tradeName: string | null; penName: string | null;
}

export interface ContractCheckRepository {
  findVendorById(id: number): Promise<VendorCandidate | null>;
  searchVendors(input: string, limit?: number): Promise<VendorCandidate[]>;
  findVendorDocuments(vendorId: number): Promise<VendorDocumentRow[]>;
  lookupByNumber(documentNumber: string): Promise<Record<string, string> | null>;
}

const VENDOR_SELECT = `id, vendor_code, vendor_name, entity_type, trade_name, pen_name`;
function mapVendor(r: Record<string, unknown>): VendorCandidate {
  return {
    id: Number(r.id), vendorCode: (r.vendor_code as string) ?? null, vendorName: (r.vendor_name as string) ?? null,
    entityType: (r.entity_type as string) ?? null, tradeName: (r.trade_name as string) ?? null,
    penName: (r.pen_name as string) ?? null
  };
}
function mapDoc(r: Record<string, unknown>): VendorDocumentRow {
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    recordType: s("record_type"), contractCategory: s("contract_category"), contractTitle: s("contract_title"),
    documentNumber: s("document_number"), contractStatus: s("contract_status"), effectiveDate: s("effective_date"),
    expirationDate: s("expiration_date"), autoRenewal: r.auto_renewal === true, documentUrl: s("document_url"),
    legalonUrl: s("legalon_url"), cloudsignUrl: s("cloudsign_url"), driveUrl: s("drive_url"),
    conditionNumber: s("condition_number"), originalWork: s("original_work"), workName: s("work_name"),
    productName: s("product_name"), media: s("media"), territory: s("territory"), language: s("language"),
    scope: s("scope"), isPrimary: r.is_primary == null ? null : r.is_primary === true,
    lifecycleStatus: s("lifecycle_status")
  };
}

export class PgContractCheckRepository implements ContractCheckRepository {
  constructor(private readonly database: DatabasePool) {}

  async findVendorById(id: number): Promise<VendorCandidate | null> {
    const r = await this.database.query(`SELECT ${VENDOR_SELECT} FROM vendors WHERE id = $1`, [id]);
    return r.rows[0] ? mapVendor(r.rows[0]) : null;
  }

  // V1 の3段ランキング（完全一致→原文部分一致→正規化部分一致）。NFKC は JS 側で正規化した
  // パラメータで代替（V1 の normalize() SQL は PG13+ 依存・42883 フォールバック持ちだった）。
  async searchVendors(input: string, limit = 10): Promise<VendorCandidate[]> {
    const nfkc = input.normalize("NFKC").trim();
    const normalized = normalizeName(input);
    if (!normalized) return [];
    const r = await this.database.query(
      `SELECT ${VENDOR_SELECT},
              CASE
                WHEN vendor_name ILIKE $1 OR COALESCE(trade_name,'') ILIKE $1
                  OR COALESCE(pen_name,'') ILIKE $1 OR COALESCE(aliases,'') ILIKE $1
                  OR COALESCE(vendor_code,'') ILIKE $1 THEN 0
                WHEN vendor_name ILIKE $2 OR COALESCE(trade_name,'') ILIKE $2
                  OR COALESCE(pen_name,'') ILIKE $2 OR COALESCE(aliases,'') ILIKE $2
                  OR COALESCE(vendor_code,'') ILIKE $2 THEN 1
                WHEN vendor_name ILIKE $3 OR COALESCE(trade_name,'') ILIKE $3
                  OR COALESCE(pen_name,'') ILIKE $3 OR COALESCE(aliases,'') ILIKE $3 THEN 2
                ELSE 9
              END AS match_priority
         FROM vendors
        WHERE is_active
          AND (vendor_name ILIKE $2 OR COALESCE(trade_name,'') ILIKE $2
            OR COALESCE(pen_name,'') ILIKE $2 OR COALESCE(aliases,'') ILIKE $2
            OR COALESCE(vendor_code,'') ILIKE $2
            OR vendor_name ILIKE $3 OR COALESCE(trade_name,'') ILIKE $3
            OR COALESCE(pen_name,'') ILIKE $3 OR COALESCE(aliases,'') ILIKE $3)
        ORDER BY match_priority ASC, vendor_name ASC, id ASC
        LIMIT $4`,
      [nfkc, `%${nfkc}%`, `%${normalized}%`, Math.min(Math.max(limit, 1), 10)]
    );
    const seen = new Set<number>();
    return r.rows.map(mapVendor).filter((v) => !seen.has(v.id) && seen.add(v.id));
  }

  async findVendorDocuments(vendorId: number): Promise<VendorDocumentRow[]> {
    const r = await this.database.query(
      `SELECT record_type, contract_category, contract_title, document_number, contract_status,
              effective_date, expiration_date, auto_renewal, document_url, legalon_url,
              cloudsign_url, drive_url, condition_number, original_work, work_name, product_name,
              media, territory, language, scope, is_primary, lifecycle_status
         FROM documents
        WHERE vendor_id = $1
          AND record_type IN ('master_contract', 'license_condition', 'publication_condition')
          AND COALESCE(lifecycle_status, 'final') <> 'voided'`,
      [vendorId]
    );
    return r.rows.map(mapDoc);
  }

  async lookupByNumber(documentNumber: string): Promise<Record<string, string> | null> {
    const r = await this.database.query(
      `SELECT cc.document_number, cc.record_type, cc.contract_title, cc.contract_status,
              COALESCE(v.vendor_name, '') AS vendor_name, COALESCE(v.vendor_code, '') AS vendor_code,
              COALESCE(v.entity_type, '') AS entity_type, COALESCE(cc.issue_key, '') AS issue_key
         FROM documents cc
         LEFT JOIN vendors v ON v.id = cc.vendor_id
        WHERE UPPER(cc.document_number) = UPPER($1)
          AND COALESCE(cc.is_primary, TRUE) = TRUE
          AND COALESCE(cc.lifecycle_status, 'final') = 'final'
        ORDER BY cc.created_at DESC NULLS LAST
        LIMIT 1`,
      [documentNumber]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      documentNumber: String(row.document_number ?? ""), recordType: String(row.record_type ?? ""),
      contractTitle: String(row.contract_title ?? ""), contractStatus: String(row.contract_status ?? ""),
      vendorName: String(row.vendor_name ?? ""), vendorCode: String(row.vendor_code ?? ""),
      entityType: String(row.entity_type ?? ""), issueKey: String(row.issue_key ?? "")
    };
  }
}

export class MemoryContractCheckRepository implements ContractCheckRepository {
  constructor(
    private readonly vendors: VendorCandidate[] = [],
    private readonly docs = new Map<number, VendorDocumentRow[]>(),
    private readonly numbers = new Map<string, Record<string, string>>()
  ) {}
  async findVendorById(id: number) { return this.vendors.find((v) => v.id === id) ?? null; }
  async searchVendors(input: string, limit = 10) {
    const norm = normalizeName(input);
    if (!norm) return [];
    const hay = (v: VendorCandidate) =>
      [v.vendorName, v.tradeName, v.penName, v.vendorCode].map((x) => normalizeName(x ?? "")).join("|");
    return this.vendors.filter((v) => hay(v).includes(norm)).slice(0, limit);
  }
  async findVendorDocuments(vendorId: number) { return this.docs.get(vendorId) ?? []; }
  async lookupByNumber(documentNumber: string) {
    return this.numbers.get(documentNumber.toUpperCase()) ?? null;
  }
}
