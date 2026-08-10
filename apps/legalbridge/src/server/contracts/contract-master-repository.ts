import type { DatabasePool } from "../db/pool.js";
import type { ContractUpdateInput, ContractStatusInput } from "./contract-master-schema.js";

// 契約マスタ リポジトリ（Phase 11-4・grant 038）。既存 contracts の list/update/状態変更。
// 登録(INSERT)は contract-intake が担当。ここは中核フィールド＋lifecycle の更新のみ。

export interface ContractSummary {
  id: number;
  documentNumber: string | null;
  contractTitle: string | null;
  contractCategory: string | null;
  contractType: string | null;
  lifecycleStage: string | null;
  contractStatus: string | null;
  primaryVendorId: number | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  autoRenewal: boolean;
  renewalNoticeMonths: number | null;
  alertLeadMonths: number | null;
  reviewDueDate: string | null;
}

export class ContractMasterError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface ContractMasterRepository {
  list(query: string, limit?: number): Promise<ContractSummary[]>;
  find(id: number): Promise<ContractSummary | null>;
  update(id: number, input: ContractUpdateInput): Promise<ContractSummary>;
  setStatus(id: number, input: ContractStatusInput): Promise<ContractSummary>;
}

const SELECT = `id, document_number, contract_title, contract_category, contract_type,
  lifecycle_stage, contract_status, primary_vendor_id,
  effective_date, expiration_date, auto_renewal, renewal_notice_months, alert_lead_months, review_due_date`;

function toDate(v: unknown): string | null {
  return v ? new Date(v as string).toISOString().slice(0, 10) : null;
}
function mapRow(row: Record<string, any>): ContractSummary {
  return {
    id: Number(row.id),
    documentNumber: row.document_number ?? null,
    contractTitle: row.contract_title ?? null,
    contractCategory: row.contract_category ?? null,
    contractType: row.contract_type ?? null,
    lifecycleStage: row.lifecycle_stage ?? null,
    contractStatus: row.contract_status ?? null,
    primaryVendorId: row.primary_vendor_id == null ? null : Number(row.primary_vendor_id),
    effectiveDate: toDate(row.effective_date),
    expirationDate: toDate(row.expiration_date),
    autoRenewal: row.auto_renewal === true,
    renewalNoticeMonths: row.renewal_notice_months == null ? null : Number(row.renewal_notice_months),
    alertLeadMonths: row.alert_lead_months == null ? null : Number(row.alert_lead_months),
    reviewDueDate: toDate(row.review_due_date)
  };
}

const FIELD_COLUMNS: Record<string, string> = {
  contractTitle: "contract_title",
  effectiveDate: "effective_date",
  expirationDate: "expiration_date",
  autoRenewal: "auto_renewal",
  renewalNoticeMonths: "renewal_notice_months",
  alertLeadMonths: "alert_lead_months",
  reviewDueDate: "review_due_date"
};

export class PgContractMasterRepository implements ContractMasterRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query: string, limit = 100): Promise<ContractSummary[]> {
    const keyword = `%${query.trim()}%`;
    const r = await this.database.query(
      `SELECT ${SELECT} FROM contracts
        WHERE ($1 = '%%'
          OR COALESCE(document_number, '') ILIKE $1
          OR COALESCE(contract_title, '') ILIKE $1
          OR COALESCE(contract_type, '') ILIKE $1)
        ORDER BY COALESCE(executed_at, requested_at, now()) DESC, id DESC
        LIMIT $2`,
      [keyword, Math.min(Math.max(limit, 1), 200)]
    );
    return r.rows.map(mapRow);
  }

  async find(id: number): Promise<ContractSummary | null> {
    const r = await this.database.query(`SELECT ${SELECT} FROM contracts WHERE id = $1`, [id]);
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  }

  async update(id: number, input: ContractUpdateInput): Promise<ContractSummary> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(FIELD_COLUMNS)) {
      if (key in input) { values.push((input as Record<string, unknown>)[key]); assignments.push(`${column} = $${values.length}`); }
    }
    if (!assignments.length) throw new ContractMasterError("CONTRACT_NO_FIELDS", "更新する項目がありません");
    values.push(id);
    const r = await this.database.query(
      `UPDATE contracts SET ${assignments.join(", ")} WHERE id = $${values.length} RETURNING ${SELECT}`,
      values
    );
    if (!r.rows[0]) throw new ContractMasterError("CONTRACT_NOT_FOUND", "契約が見つかりません");
    return mapRow(r.rows[0]);
  }

  async setStatus(id: number, input: ContractStatusInput): Promise<ContractSummary> {
    // lifecycle_stage のみ更新する。contract_status は V1 の文書レベル語彙（draft/awaiting_signature/
    // executed/expired/terminated）を持つ legacy 互換列で、V2 の lifecycle 語彙（requested/reviewing 等）を
    // 書くと V1 に無い値で汚染される（監査 P0-7）。V1 も contracts.contract_status は読まないため据え置き。
    const r = await this.database.query(
      `UPDATE contracts SET lifecycle_stage = $2 WHERE id = $1 RETURNING ${SELECT}`,
      [id, input.lifecycleStage]
    );
    if (!r.rows[0]) throw new ContractMasterError("CONTRACT_NOT_FOUND", "契約が見つかりません");
    return mapRow(r.rows[0]);
  }
}

export class MemoryContractMasterRepository implements ContractMasterRepository {
  constructor(private readonly rows: ContractSummary[] = [], private readonly forbidden = false) {}
  async list(query: string, limit = 100) {
    const k = query.trim().toLowerCase();
    return this.rows.filter((c) => !k ||
      [c.documentNumber, c.contractTitle, c.contractType].some((v) => v?.toLowerCase().includes(k))).slice(0, limit);
  }
  async find(id: number) { return this.rows.find((c) => c.id === id) ?? null; }
  private guard() { if (this.forbidden) { const e = new Error("forbidden"); (e as { code?: string }).code = "42501"; throw e; } }
  async update(id: number, input: ContractUpdateInput) {
    this.guard();
    const c = this.rows.find((r) => r.id === id);
    if (!c) throw new ContractMasterError("CONTRACT_NOT_FOUND", "契約が見つかりません");
    if ("contractTitle" in input) c.contractTitle = input.contractTitle ?? null;
    if ("effectiveDate" in input) c.effectiveDate = input.effectiveDate ?? null;
    if ("expirationDate" in input) c.expirationDate = input.expirationDate ?? null;
    if (input.autoRenewal !== undefined) c.autoRenewal = input.autoRenewal;
    if ("renewalNoticeMonths" in input) c.renewalNoticeMonths = input.renewalNoticeMonths ?? null;
    if ("alertLeadMonths" in input) c.alertLeadMonths = input.alertLeadMonths ?? null;
    if ("reviewDueDate" in input) c.reviewDueDate = input.reviewDueDate ?? null;
    return c;
  }
  async setStatus(id: number, input: ContractStatusInput) {
    this.guard();
    const c = this.rows.find((r) => r.id === id);
    if (!c) throw new ContractMasterError("CONTRACT_NOT_FOUND", "契約が見つかりません");
    c.lifecycleStage = input.lifecycleStage;   // contract_status は legacy 語彙のため触らない（P0-7）
    return c;
  }
}
