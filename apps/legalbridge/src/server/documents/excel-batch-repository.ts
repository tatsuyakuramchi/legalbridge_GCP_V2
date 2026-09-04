import type { DatabasePool } from "../db/pool.js";
import type { RawExcelDoc } from "./excel-batch-engine.js";

// Excel 一括出力の対象読取＋発行済み台帳（Phase 10-5・grant 035）。読取は SELECT のみ。
// markExported は隔離台帳 lb_v2_excel_export_ledger への INSERT（本番業務表は不変）。

export interface ExcelBatchRepository {
  // 未発行（＝台帳に無い）の検収書/利用許諾料計算書（final・正本・void でない）を読む。
  loadPending(limit: number): Promise<RawExcelDoc[]>;
  // 発行済みとして記録（ON CONFLICT DO NOTHING）。記録できた件数を返す。
  markExported(documentNumbers: string[], batchKey: string, actor: string): Promise<number>;
}

// 相手先の取引先マスタ（経理提出用レイアウトの取引先コード・カナ・源泉・T番号）。
const VENDOR_COLUMNS = `
         v.vendor_code, v.vendor_name, v.account_holder_kana, v.entity_type,
         v.withholding_enabled, v.invoice_registration_number`;

const PENDING_SQL = `
  SELECT d.document_number, d.template_type, d.form_data, d.created_at, ${VENDOR_COLUMNS}
    FROM documents d
    LEFT JOIN lb_v2_excel_export_ledger l ON l.document_number = d.document_number
    LEFT JOIN vendors v ON v.id = d.vendor_id
   WHERE l.document_number IS NULL
     AND COALESCE(d.is_primary, true) = true
     AND COALESCE(d.lifecycle_status, 'final') = 'final'
     AND d.document_number IS NOT NULL
     AND (d.template_type LIKE 'inspection_certificate%' OR d.template_type = 'royalty_statement')
   ORDER BY d.created_at ASC NULLS FIRST, d.id ASC
   LIMIT $1`;

// 台帳がまだ無い環境向けフォールバック（発行済み除外なし・全件を保留として返す）。
const PENDING_SQL_NO_LEDGER = `
  SELECT d.document_number, d.template_type, d.form_data, d.created_at, ${VENDOR_COLUMNS}
    FROM documents d
    LEFT JOIN vendors v ON v.id = d.vendor_id
   WHERE COALESCE(d.is_primary, true) = true
     AND COALESCE(d.lifecycle_status, 'final') = 'final'
     AND d.document_number IS NOT NULL
     AND (d.template_type LIKE 'inspection_certificate%' OR d.template_type = 'royalty_statement')
   ORDER BY d.created_at ASC NULLS FIRST, d.id ASC
   LIMIT $1`;

function mapRow(row: Record<string, any>): RawExcelDoc {
  return {
    documentNumber: String(row.document_number),
    templateType: String(row.template_type),
    formData: (row.form_data ?? {}) as Record<string, unknown>,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    vendor: row.vendor_code == null && row.vendor_name == null ? null : {
      vendorCode: row.vendor_code ?? null,
      vendorName: row.vendor_name ?? null,
      vendorNameKana: row.account_holder_kana ?? null,
      entityType: row.entity_type ?? null,
      withholdingEnabled: row.withholding_enabled == null ? null : Boolean(row.withholding_enabled),
      invoiceRegistrationNumber: row.invoice_registration_number ?? null
    }
  };
}

export class PgExcelBatchRepository implements ExcelBatchRepository {
  constructor(private readonly database: DatabasePool) {}

  async loadPending(limit: number): Promise<RawExcelDoc[]> {
    const capped = Math.min(Math.max(limit, 1), 1000);
    try {
      const r = await this.database.query(PENDING_SQL, [capped]);
      return r.rows.map(mapRow);
    } catch (error) {
      // 台帳未整備（42P01）なら発行済み除外なしで縮退（capability OFF でも一覧は見える）。
      if ((error as { code?: string })?.code === "42P01") {
        const r = await this.database.query(PENDING_SQL_NO_LEDGER, [capped]);
        return r.rows.map(mapRow);
      }
      throw error;
    }
  }

  async markExported(documentNumbers: string[], batchKey: string, actor: string): Promise<number> {
    const unique = [...new Set(documentNumbers.map((n) => n.trim()).filter(Boolean))];
    if (!unique.length) return 0;
    const r = await this.database.query(
      `INSERT INTO lb_v2_excel_export_ledger (document_number, batch_key, exported_by)
       SELECT unnest($1::text[]), $2, $3
       ON CONFLICT (document_number) DO NOTHING`,
      [unique, batchKey || null, actor]
    );
    return r.rowCount ?? 0;
  }
}

export class MemoryExcelBatchRepository implements ExcelBatchRepository {
  readonly exported = new Set<string>();
  constructor(private readonly docs: RawExcelDoc[] = []) {}

  async loadPending(limit: number): Promise<RawExcelDoc[]> {
    return this.docs
      .filter((d) => (d.templateType.startsWith("inspection_certificate") || d.templateType === "royalty_statement"))
      .filter((d) => !this.exported.has(d.documentNumber))
      .slice(0, Math.max(limit, 1));
  }

  async markExported(documentNumbers: string[], _batchKey: string, _actor: string): Promise<number> {
    let n = 0;
    for (const num of documentNumbers) {
      const key = num.trim();
      if (key && !this.exported.has(key)) { this.exported.add(key); n++; }
    }
    return n;
  }
}
