import type { DatabasePool } from "../db/pool.js";

export type SettlementTrigger =
  | "manufacturing"
  | "sale"
  | "sublicense_receipt";

export interface SettlementCondition {
  id: number;
  name: string;
  workId: number | null;
  workCode: string | null;
  workTitle: string | null;
  direction: string | null;
  flowDirection: string | null;
  paymentScheme: string | null;
  calcType: string | null;
  ratePct: number | null;
  amountExTax: number | null;
  unitAmount: number | null;
  mgAmount: number | null;
  agAmount: number | null;
  currency: string;
  paymentTerms: string | null;
  royaltyBase: string | null;
  deductibleCosts: string | null;
  parentLicenseConditionId: number | null;
  counterpartyVendorId: number | null;
  counterparty: string | null;
  documentNumber: string | null;
  contractId: number | null;
  contractTitle: string | null;
}

export interface SettlementPreviewInput {
  conditionLineId: number;
  trigger: SettlementTrigger;
  occurredAt: string;
  productName?: string;
  edition?: string;
  quantity?: number;
  sampleQuantity?: number;
  unitBase?: number;
  grossAmount?: number;
  deductions?: number;
  useNetBasis?: boolean;
}

export interface SettlementPreview {
  sourceCondition: SettlementCondition;
  settlementCondition: SettlementCondition;
  trigger: SettlementTrigger;
  occurredAt: string;
  productName: string;
  edition: string;
  quantity: number;
  sampleQuantity: number;
  billableQuantity: number;
  unitBase: number;
  grossEventAmount: number;
  deductions: number;
  basisAmount: number;
  ratePct: number | null;
  grossRoyalty: number;
  actualRoyalty: number;
  currency: string;
  formula: string;
  warnings: string[];
}

export interface LicenseSettlementRepository {
  listConditions(query?: string, limit?: number): Promise<SettlementCondition[]>;
  findCondition(id: number): Promise<SettlementCondition | null>;
  preview(input: SettlementPreviewInput): Promise<SettlementPreview>;
}

export class PgLicenseSettlementRepository implements LicenseSettlementRepository {
  constructor(private readonly database: DatabasePool) {}

  async listConditions(query = "", limit = 200) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `${CONDITION_SELECT}
        WHERE (cl.transaction_kind = 'license'
            OR cl.flow_direction IN ('in','out')
            OR cl.is_inbound = true)
          AND cl.cancelled_at IS NULL
          AND ($1 = '%%'
            OR COALESCE(cl.condition_name, '') ILIKE $1
            OR COALESCE(w.title, '') ILIKE $1
            OR COALESCE(v.vendor_name, '') ILIKE $1
            OR COALESCE(d.document_number, '') ILIKE $1)
        ORDER BY w.title NULLS LAST, cl.flow_direction NULLS LAST, cl.id DESC
        LIMIT $2`,
      [keyword, Math.min(Math.max(limit, 1), 500)]
    );
    return result.rows.map(mapCondition);
  }

  async findCondition(id: number) {
    const result = await this.database.query(
      `${CONDITION_SELECT} WHERE cl.id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] ? mapCondition(result.rows[0]) : null;
  }

  async preview(input: SettlementPreviewInput) {
    const source = await this.findCondition(input.conditionLineId);
    if (!source) throw new SettlementError("CONDITION_NOT_FOUND", "対象条件が見つかりません");

    let target = source;
    if (source.direction === "receivable" && source.parentLicenseConditionId) {
      const parent = await this.findCondition(source.parentLicenseConditionId);
      if (parent) target = parent;
    }

    const quantity = nonNegative(input.quantity);
    const sampleQuantity = Math.min(quantity, nonNegative(input.sampleQuantity));
    const billableQuantity = Math.max(0, quantity - sampleQuantity);
    const unitBase = nonNegative(input.unitBase);
    const grossAmount = nonNegative(input.grossAmount);
    const deductions = Math.min(grossAmount, nonNegative(input.deductions));

    let grossEventAmount = grossAmount;
    if (input.trigger === "manufacturing" || input.trigger === "sale") {
      if (grossEventAmount <= 0 && billableQuantity > 0 && unitBase > 0) {
        grossEventAmount = billableQuantity * unitBase;
      }
    }
    const basisAmount = input.useNetBasis ? Math.max(0, grossEventAmount - deductions) : grossEventAmount;

    const warnings: string[] = [];
    if (target.mgAmount && target.mgAmount > 0) {
      warnings.push("MG条件があります。今回精算への充当・上乗せは既存精算履歴を確認して確定してください。");
    }
    if (target.agAmount && target.agAmount > 0) {
      warnings.push("AG条件があります。今回精算への充当額は既存精算履歴を確認して確定してください。");
    }
    if (source.id !== target.id) {
      warnings.push(`OUT条件 #${source.id} を起点に、根拠IN条件 #${target.id} で支払額を計算しています。`);
    }

    const scheme = String(target.calcType ?? target.paymentScheme ?? "").toLowerCase();
    const rate = target.ratePct;
    let grossRoyalty = 0;
    let formula = "";

    if (scheme.includes("fixed") || scheme.includes("lump")) {
      grossRoyalty = nonNegative(target.amountExTax);
      formula = `固定額 ${grossRoyalty}`;
    } else if (scheme.includes("per_unit") || target.unitAmount) {
      const unit = nonNegative(target.unitAmount);
      grossRoyalty = billableQuantity * unit;
      formula = `${billableQuantity} × ${unit}`;
    } else if (rate !== null && rate !== undefined) {
      grossRoyalty = basisAmount * rate / 100;
      formula = `${basisAmount} × ${rate}%`;
    } else if (target.amountExTax !== null) {
      grossRoyalty = nonNegative(target.amountExTax);
      formula = `条件金額 ${grossRoyalty}`;
    } else {
      warnings.push("料率・単価・固定額のいずれも設定されていません。法務確認が必要です。");
    }

    return {
      sourceCondition: source,
      settlementCondition: target,
      trigger: input.trigger,
      occurredAt: input.occurredAt,
      productName: input.productName?.trim() || source.workTitle || target.workTitle || "対象取引",
      edition: input.edition?.trim() || "",
      quantity,
      sampleQuantity,
      billableQuantity,
      unitBase,
      grossEventAmount,
      deductions,
      basisAmount,
      ratePct: rate,
      grossRoyalty,
      actualRoyalty: grossRoyalty,
      currency: target.currency || source.currency || "JPY",
      formula,
      warnings
    };
  }
}

const CONDITION_SELECT = `
  SELECT cl.id, cl.condition_name, cl.work_id, cl.direction, cl.flow_direction,
         cl.payment_scheme, cl.calc_type, cl.rate_pct, cl.amount_ex_tax,
         cl.unit_amount, cl.mg_amount, cl.ag_amount, cl.currency,
         cl.payment_terms, cl.royalty_base, cl.deductible_costs,
         cl.parent_license_condition_id, cl.counterparty_vendor_id,
         w.work_code, w.title AS work_title,
         v.vendor_name AS counterparty,
         d.document_number, d.contract_id,
         c.contract_title
    FROM condition_lines cl
    LEFT JOIN works w ON w.id = cl.work_id
    LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
    LEFT JOIN documents d ON d.id = cl.document_id
    LEFT JOIN contracts c ON c.id = d.contract_id
`;

function mapCondition(row: Record<string, any>): SettlementCondition {
  return {
    id: Number(row.id),
    name: String(row.condition_name ?? ""),
    workId: row.work_id === null ? null : Number(row.work_id),
    workCode: row.work_code ?? null,
    workTitle: row.work_title ?? null,
    direction: row.direction ?? null,
    flowDirection: row.flow_direction ?? null,
    paymentScheme: row.payment_scheme ?? null,
    calcType: row.calc_type ?? null,
    ratePct: num(row.rate_pct),
    amountExTax: num(row.amount_ex_tax),
    unitAmount: num(row.unit_amount),
    mgAmount: num(row.mg_amount),
    agAmount: num(row.ag_amount),
    currency: String(row.currency ?? "JPY"),
    paymentTerms: row.payment_terms ?? null,
    royaltyBase: row.royalty_base ?? null,
    deductibleCosts: row.deductible_costs ?? null,
    parentLicenseConditionId: row.parent_license_condition_id === null
      ? null : Number(row.parent_license_condition_id),
    counterpartyVendorId: row.counterparty_vendor_id === null
      ? null : Number(row.counterparty_vendor_id),
    counterparty: row.counterparty ?? null,
    documentNumber: row.document_number ?? null,
    contractId: row.contract_id === null ? null : Number(row.contract_id),
    contractTitle: row.contract_title ?? null
  };
}
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function nonNegative(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class SettlementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class MemoryLicenseSettlementRepository implements LicenseSettlementRepository {
  constructor(private readonly conditions: SettlementCondition[] = []) {}
  async listConditions(query = "", limit = 200) {
    const keyword = query.trim().toLowerCase();
    return this.conditions
      .filter((c) => !keyword || [c.name, c.workTitle ?? "", c.counterparty ?? ""]
        .some((v) => v.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }
  async findCondition(id: number) {
    return this.conditions.find((c) => c.id === id) ?? null;
  }
  async preview(input: SettlementPreviewInput) {
    const source = await this.findCondition(input.conditionLineId);
    if (!source) throw new SettlementError("CONDITION_NOT_FOUND", "対象条件が見つかりません");
    const target = source.parentLicenseConditionId
      ? (await this.findCondition(source.parentLicenseConditionId)) ?? source
      : source;
    const quantity = nonNegative(input.quantity);
    const sampleQuantity = Math.min(quantity, nonNegative(input.sampleQuantity));
    const billableQuantity = Math.max(0, quantity - sampleQuantity);
    const unitBase = nonNegative(input.unitBase);
    const grossEventAmount = nonNegative(input.grossAmount) || billableQuantity * unitBase;
    const deductions = Math.min(grossEventAmount, nonNegative(input.deductions));
    const basisAmount = input.useNetBasis ? grossEventAmount - deductions : grossEventAmount;
    const rate = target.ratePct;
    const grossRoyalty = rate === null ? nonNegative(target.amountExTax) : basisAmount * rate / 100;
    return {
      sourceCondition: source, settlementCondition: target, trigger: input.trigger,
      occurredAt: input.occurredAt, productName: input.productName ?? target.workTitle ?? "対象取引",
      edition: input.edition ?? "", quantity, sampleQuantity, billableQuantity, unitBase,
      grossEventAmount, deductions, basisAmount, ratePct: rate, grossRoyalty,
      actualRoyalty: grossRoyalty, currency: target.currency, formula: rate === null
        ? `条件金額 ${grossRoyalty}` : `${basisAmount} × ${rate}%`, warnings: []
    };
  }
}
