import type { DatabasePool } from "../db/pool.js";

export type LedgerType = "vendors" | "works" | "materials" | "conditions";
export interface LedgerItem {
  id: string; type: LedgerType; code: string; title: string; subtitle: string;
  status?: string; updatedAt?: string; detail: Record<string, unknown>;
}
export interface LedgerRepository {
  list(type: LedgerType, query: string, limit?: number): Promise<LedgerItem[]>;
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly database: DatabasePool) {}
  async list(type: LedgerType, query: string, limit = 200) {
    const keyword = `%${query.trim()}%`;
    const bounded = Math.min(Math.max(limit, 1), 500);
    if (type === "vendors") {
      const result = await this.database.query(
        `SELECT id, vendor_code, vendor_name, trade_name, pen_name, entity_type,
                address, phone, email, contact_department, contact_name,
                contact_email, signer_email,
                vendor_rep, is_invoice_issuer, invoice_registration_number,
                withholding_enabled, is_active,
                bank_name, branch_name, account_type, account_number, account_holder_kana
           FROM vendors
          WHERE $1 = '%%' OR vendor_code ILIKE $1 OR vendor_name ILIKE $1
             OR COALESCE(trade_name, '') ILIKE $1 OR COALESCE(pen_name, '') ILIKE $1
          ORDER BY is_active DESC, vendor_name LIMIT $2`, [keyword, bounded]);
      return result.rows.map((row) => ({
        id: String(row.id), type, code: row.vendor_code, title: row.vendor_name,
        // 台帳は無効も表示する（再有効化の導線を残す）。ピッカー/横断検索は有効のみ（P1-4）。
        subtitle: [row.is_active === false ? "【無効】" : null, row.trade_name, row.pen_name, row.entity_type]
          .filter(Boolean).join("・"),
        // マスキング撤廃（2026-08-19 利用者決定）: 台帳は住所・電話・メールを実値で表示し、
        // 口座情報も出す（PDF出力・印刷でも実値のまま）。
        detail: {
          状態: row.is_active === false ? "無効" : "有効",
          取引先区分: row.entity_type, 住所: row.address,
          電話番号: row.phone, メール: row.email,
          担当部署: row.contact_department, 担当者: row.contact_name,
          担当者メール: row.contact_email, "署名者メール（電子契約）": row.signer_email,
          代表者: row.vendor_rep, インボイス登録: Boolean(row.is_invoice_issuer),
          インボイス番号: row.invoice_registration_number,
          源泉徴収対象: Boolean(row.withholding_enabled),
          振込先: [row.bank_name, row.branch_name,
            [row.account_type, row.account_number].filter(Boolean).join(" ")]
            .filter(Boolean).join(" ") || null,
          口座名義カナ: row.account_holder_kana
        }
      }));
    }
    if (type === "materials") {
      const result = await this.database.query(
        `SELECT wm.id, wm.material_code, wm.material_name, wm.material_type,
                wm.material_role, wm.rights_type, wm.is_default,
                w.id AS work_id, w.work_code, w.title AS work_title
           FROM work_materials wm
           JOIN works w ON w.id = wm.work_id
          WHERE $1 = '%%'
             OR COALESCE(wm.material_code, '') ILIKE $1
             OR COALESCE(wm.material_name, '') ILIKE $1
             OR w.work_code ILIKE $1
             OR w.title ILIKE $1
          ORDER BY w.title, wm.material_no NULLS LAST, wm.id
          LIMIT $2`,
        [keyword, bounded]
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        type,
        code: row.material_code ?? `MAT-${row.id}`,
        title: row.material_name ?? row.material_code ?? `素材 ${row.id}`,
        subtitle: [row.work_code, row.work_title, row.material_type]
          .filter(Boolean).join("・"),
        detail: {
          作品ID: row.work_id,
          作品コード: row.work_code,
          作品名: row.work_title,
          素材区分: row.material_type,
          構成上の役割: row.material_role,
          権利区分: row.rights_type,
          代表素材: Boolean(row.is_default)
        }
      }));
    }
    if (type === "works") {
      const result = await this.database.query(
        `(SELECT 'work' AS source, id, work_code AS code, title, work_type AS category,
                 kind AS work_kind, status, remarks, updated_at, NULL::text AS rights_holder
            FROM works
           WHERE is_active = TRUE AND ($1 = '%%' OR work_code ILIKE $1 OR title ILIKE $1))
         UNION ALL
         (SELECT 'source_ip' AS source, id, source_code AS code, title,
                 '原作IP' AS category, 'source_ip'::text AS work_kind, 'active' AS status,
                 remarks, updated_at,
                 COALESCE(default_rights_holder, original_publisher) AS rights_holder
            FROM source_ips
           WHERE is_active = TRUE AND ($1 = '%%' OR source_code ILIKE $1 OR title ILIKE $1))
         ORDER BY title LIMIT $2`, [keyword, bounded]);
      return result.rows.map((row) => ({
        id: `${row.source}:${row.id}`, type, code: row.code, title: row.title,
        subtitle: [
          row.source === "source_ip"
            ? "原作IP"
            : row.work_kind === "licensed_in"
              ? "原作・ライセンスイン"
              : row.work_kind === "own"
                ? "自社作品"
                : row.work_kind,
          row.category
        ].filter(Boolean).join("・"),
        status: row.status, updatedAt: iso(row.updated_at),
        detail: { 種別: row.category, 権利者: row.rights_holder, 状態: row.status, 備考: row.remarks }
      }));
    }
    const result = await this.database.query(
      `SELECT cl.id, cl.line_code, cl.condition_name, cl.direction, cl.payment_scheme,
              cl.currency, cl.amount_ex_tax, cl.rate_pct, cl.mg_amount, cl.ag_amount,
              cl.term_start, cl.term_end, cl.payment_date, cl.notes, cl.updated_at,
              d.document_number, d.template_type, d.issue_key
         FROM condition_lines cl
         LEFT JOIN documents d ON d.id = cl.document_id
        WHERE $1 = '%%' OR COALESCE(cl.line_code, '') ILIKE $1
           OR COALESCE(cl.condition_name, '') ILIKE $1
           OR COALESCE(d.document_number, '') ILIKE $1 OR COALESCE(d.issue_key, '') ILIKE $1
        ORDER BY cl.updated_at DESC NULLS LAST, cl.id DESC LIMIT $2`, [keyword, bounded]);
    return result.rows.map((row) => ({
      id: String(row.id), type, code: row.line_code ?? `CL-${row.id}`,
      title: row.condition_name ?? row.document_number ?? "名称未設定",
      subtitle: [row.document_number, row.payment_scheme, row.direction].filter(Boolean).join("・"),
      updatedAt: iso(row.updated_at),
      detail: {
        文書番号: row.document_number, 文書種別: row.template_type, 案件キー: row.issue_key,
        方向: row.direction, 支払方式: row.payment_scheme, 通貨: row.currency,
        金額税抜: row.amount_ex_tax, 料率: row.rate_pct, MG: row.mg_amount, AG: row.ag_amount,
        期間開始: dateOnly(row.term_start), 期間終了: dateOnly(row.term_end),
        支払日: dateOnly(row.payment_date), 備考: row.notes
      }
    }));
  }
}
export class MemoryLedgerRepository implements LedgerRepository {
  constructor(private readonly items: LedgerItem[] = []) {}
  async list(type: LedgerType, query: string, limit = 200) {
    const keyword = query.trim().toLowerCase();
    return this.items.filter((item) => item.type === type)
      .filter((item) => !keyword || `${item.code} ${item.title} ${item.subtitle}`.toLowerCase().includes(keyword))
      .slice(0, limit);
  }
}
function iso(value: unknown) { return value ? new Date(String(value)).toISOString() : undefined; }
export function formatLedgerDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}
function dateOnly(value: unknown) { return formatLedgerDate(value); }
