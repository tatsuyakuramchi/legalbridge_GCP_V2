import type { PoolClient } from "pg";
import type { DatabasePool } from "../db/pool.js";
import type { ValidatedContractOutboundCondition } from "./intake.js";

// Shape consumed by the document bridge to build 個別利用許諾条件書.
export interface OutboundBridgeCondition {
  conditionName: string;
  counterpartyVendorId: number;
  materialIndex?: number;
  territory: string;
  languages: string[];
  exclusivity?: string;
  sublicenseAllowed: boolean;
  termStart?: string;
  currency: string;
  paymentScheme: string;
  ratePct?: number;
  amountExTax?: number;
  mgAmount?: number;
  advanceAmount?: number;
  royaltyBase?: string;
  deductibleCosts?: string;
  paymentTerms?: string;
  notes?: string;
}

export interface ContractOutboundView extends OutboundBridgeCondition {
  conditionLineId: number;
  lineNo: number;
  transactionKind: string;
  counterpartyName: string;
}

export interface AppendedOutboundCondition {
  conditionLineId: number;
  lineNo: number;
  conditionName: string;
  counterpartyVendorId: number;
}

export class ContractOutboundReferenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface ContractOutboundRepository {
  list(documentId: number): Promise<ContractOutboundView[]>;
  append(
    documentId: number,
    conditions: ValidatedContractOutboundCondition[],
    createdBy: string
  ): Promise<AppendedOutboundCondition[]>;
}

interface OutboundContext {
  documentId: number;
  contractId: number;
  ownWorkId: number;
  sourceWorkId: number;
  effectiveDate: string | null;
  expirationDate: string | null;
  executedAt: string | null;
  materialIds: number[];
  maxLineNo: number;
}

async function orderedMaterialIds(
  client: PoolClient | DatabasePool,
  documentId: number
): Promise<number[]> {
  const result = await client.query(
    `SELECT wm.id
       FROM material_rights_sources mrs
       JOIN work_materials wm ON wm.id = mrs.material_id
      WHERE mrs.source_document_id = $1
      ORDER BY mrs.id`,
    [documentId]
  );
  return result.rows.map((row) => Number(row.id));
}

export async function listContractOutboundConditions(
  database: DatabasePool,
  documentId: number
): Promise<ContractOutboundView[]> {
  const materialIds = await orderedMaterialIds(database, documentId);
  const result = await database.query(
    `SELECT cl.id, cl.line_no, cl.condition_name, cl.transaction_kind,
            cl.counterparty_vendor_id, cl.source_material_id,
            cl.region_territory, cl.exclusivity, cl.sublicense_allowed,
            cl.term_start, cl.currency, cl.payment_scheme, cl.rate_pct,
            cl.amount_ex_tax, cl.mg_amount, cl.ag_amount, cl.royalty_base,
            cl.deductible_costs, cl.payment_terms, cl.notes,
            COALESCE(v.vendor_name, '') AS counterparty_name,
            COALESCE(
              (SELECT array_agg(cll.language_name ORDER BY cll.sort_order)
                 FROM condition_line_languages cll
                WHERE cll.condition_line_id = cl.id),
              ARRAY[]::text[]
            ) AS languages
       FROM condition_lines cl
       LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
      WHERE cl.document_id = $1
        AND cl.flow_direction = 'out'
      ORDER BY cl.line_no`,
    [documentId]
  );

  return result.rows.map((row) => {
    const materialId = row.source_material_id === null
      ? null
      : Number(row.source_material_id);
    const materialIndex = materialId === null
      ? undefined
      : (() => {
          const index = materialIds.indexOf(materialId);
          return index >= 0 ? index : undefined;
        })();
    return {
      conditionLineId: Number(row.id),
      lineNo: Number(row.line_no),
      conditionName: String(row.condition_name ?? ""),
      transactionKind: String(row.transaction_kind ?? "license"),
      counterpartyVendorId: Number(row.counterparty_vendor_id),
      counterpartyName: String(row.counterparty_name ?? ""),
      materialIndex,
      territory: String(row.region_territory ?? ""),
      languages: Array.isArray(row.languages)
        ? row.languages.map((value: unknown) => String(value))
        : [],
      exclusivity: row.exclusivity ? String(row.exclusivity) : undefined,
      sublicenseAllowed: Boolean(row.sublicense_allowed),
      termStart: row.term_start ? isoDate(row.term_start) : undefined,
      currency: String(row.currency ?? "JPY"),
      paymentScheme: String(row.payment_scheme ?? ""),
      ratePct: numeric(row.rate_pct),
      amountExTax: numeric(row.amount_ex_tax),
      mgAmount: numeric(row.mg_amount),
      advanceAmount: numeric(row.ag_amount),
      royaltyBase: row.royalty_base ? String(row.royalty_base) : undefined,
      deductibleCosts: row.deductible_costs
        ? String(row.deductible_costs)
        : undefined,
      paymentTerms: row.payment_terms ? String(row.payment_terms) : undefined,
      notes: row.notes ? String(row.notes) : undefined
    } satisfies ContractOutboundView;
  });
}

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export class PgContractOutboundRepository implements ContractOutboundRepository {
  constructor(private readonly database: DatabasePool) {}

  list(documentId: number) {
    return listContractOutboundConditions(this.database, documentId);
  }

  async append(
    documentId: number,
    conditions: ValidatedContractOutboundCondition[],
    _createdBy: string
  ): Promise<AppendedOutboundCondition[]> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('legalbridge-v2-contract-outbound'))"
      );

      const context = await loadContext(client, documentId);
      await assertVendorsExist(client, conditions);

      const appended: AppendedOutboundCondition[] = [];
      let lineNo = context.maxLineNo;
      for (const condition of conditions) {
        lineNo += 1;
        appended.push(
          await insertOutboundConditionLine(client, context, condition, lineNo)
        );
      }

      await client.query("COMMIT");
      return appended;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadContext(
  client: PoolClient,
  documentId: number
): Promise<OutboundContext> {
  const document = await client.query(
    `SELECT d.id, d.contract_id, d.ledger_ref_id,
            c.effective_date, c.expiration_date, c.executed_at
       FROM documents d
       JOIN contracts c ON c.id = d.contract_id
      WHERE d.id = $1
        AND d.template_type = 'registered_master'
        AND d.record_type = 'license_condition'
        AND d.contract_id IS NOT NULL
      LIMIT 1`,
    [documentId]
  );
  const row = document.rows[0];
  if (!row) {
    throw new ContractOutboundReferenceError(
      "CONTRACT_INTAKE_DOCUMENT_NOT_FOUND",
      "登録済み契約取込が見つかりません"
    );
  }

  const sourceWork = await client.query(
    `SELECT work_id FROM contract_works
      WHERE contract_id = $1 AND role = 'licensed_source' LIMIT 1`,
    [Number(row.contract_id)]
  );
  if (!sourceWork.rows[0]) {
    throw new ContractOutboundReferenceError(
      "CONTRACT_SOURCE_WORK_MISSING",
      "契約の原作参照が不完全です"
    );
  }

  const lineNoResult = await client.query(
    "SELECT COALESCE(MAX(line_no), 0) AS max_line_no FROM condition_lines WHERE document_id = $1",
    [documentId]
  );

  return {
    documentId,
    contractId: Number(row.contract_id),
    ownWorkId: Number(row.ledger_ref_id),
    sourceWorkId: Number(sourceWork.rows[0].work_id),
    effectiveDate: row.effective_date ? isoDate(row.effective_date) : null,
    expirationDate: row.expiration_date ? isoDate(row.expiration_date) : null,
    executedAt: row.executed_at ? isoDate(row.executed_at) : null,
    materialIds: await orderedMaterialIds(client, documentId),
    maxLineNo: Number(lineNoResult.rows[0]?.max_line_no ?? 0)
  };
}

async function assertVendorsExist(
  client: PoolClient,
  conditions: ValidatedContractOutboundCondition[]
) {
  const vendorIds = [...new Set(conditions.map((item) => item.counterpartyVendorId))];
  const found = await client.query(
    "SELECT id FROM vendors WHERE id = ANY($1::int[])",
    [vendorIds]
  );
  const present = new Set(found.rows.map((item) => Number(item.id)));
  for (const id of vendorIds) {
    if (!present.has(id)) {
      throw new ContractOutboundReferenceError(
        "OUTBOUND_VENDOR_NOT_FOUND",
        `許諾先ID ${id} は存在しません`
      );
    }
  }
}

async function insertOutboundConditionLine(
  client: PoolClient,
  context: OutboundContext,
  condition: ValidatedContractOutboundCondition,
  lineNo: number
): Promise<AppendedOutboundCondition> {
  const materialIndex = condition.materialIndex;
  if (materialIndex !== undefined && materialIndex >= context.materialIds.length) {
    throw new ContractOutboundReferenceError(
      "OUTBOUND_MATERIAL_OUT_OF_RANGE",
      "存在しない素材番号です"
    );
  }
  const materialId = materialIndex === undefined
    ? null
    : context.materialIds[materialIndex];

  const result = await client.query(
    `INSERT INTO condition_lines (
       capability_id, line_no, work_id, direction, payment_scheme,
       rights_attribution, currency, notes, amount_ex_tax,
       term_start, term_end, cycle, rate_pct, mg_amount, ag_amount,
       payment_terms, is_inbound, flow_direction, transaction_kind,
       source_work_id, source_material_id, counterparty_vendor_id,
       document_id, condition_name, region_territory, region_language,
       material_rights_source_id, exclusivity, sublicense_allowed,
       minimum_quantity, sell_off_months, incoterms,
       withholding_tax_treatment, royalty_base, deductible_costs
     ) VALUES (
       $1, $2, $3, 'receivable', $4,
       $5, $6, $7, $8,
       $9::date, $10::date, $11, $12, $13, $14,
       $15, false, 'out', $16,
       $17, $18, $19,
       $1, $20, $21, $22,
       NULL, $23, $24,
       $25, $26, $27,
       $28, $29, $30
     )
     RETURNING id`,
    [
      context.documentId,
      lineNo,
      context.ownWorkId,
      condition.paymentScheme,
      condition.rightsAttribution ?? "license_only",
      condition.currency,
      condition.notes ?? null,
      condition.amountExTax ?? null,
      condition.termStart ?? context.effectiveDate ?? null,
      condition.termEnd ?? context.expirationDate ?? null,
      condition.reportingCycle ?? null,
      condition.ratePct ?? null,
      condition.mgAmount ?? null,
      condition.advanceAmount ?? null,
      condition.paymentTerms ?? null,
      condition.transactionKind,
      context.sourceWorkId,
      materialId,
      condition.counterpartyVendorId,
      condition.conditionName,
      condition.territory,
      condition.languages.join(", "),
      condition.exclusivity ?? null,
      condition.sublicenseAllowed,
      condition.minimumQuantity ?? null,
      condition.sellOffMonths ?? null,
      condition.incoterms ?? null,
      condition.withholdingTaxTreatment ?? null,
      condition.royaltyBase ?? null,
      condition.deductibleCosts ?? null
    ]
  );
  const conditionLineId = Number(result.rows[0].id);

  await client.query(
    `INSERT INTO condition_line_regions (
       condition_line_id, country_name, sort_order
     ) VALUES ($1, $2, 0)`,
    [conditionLineId, condition.territory]
  );
  for (let index = 0; index < condition.languages.length; index += 1) {
    await client.query(
      `INSERT INTO condition_line_languages (
         condition_line_id, language_name, sort_order
       ) VALUES ($1, $2, $3)`,
      [conditionLineId, condition.languages[index], index]
    );
  }

  return {
    conditionLineId,
    lineNo,
    conditionName: condition.conditionName,
    counterpartyVendorId: condition.counterpartyVendorId
  };
}

export class MemoryContractOutboundRepository implements ContractOutboundRepository {
  readonly store = new Map<number, ContractOutboundView[]>();

  constructor(private readonly knownDocuments = new Set<number>()) {}

  async list(documentId: number) {
    return this.store.get(documentId) ?? [];
  }

  async append(
    documentId: number,
    conditions: ValidatedContractOutboundCondition[],
    _createdBy: string
  ) {
    if (this.knownDocuments.size && !this.knownDocuments.has(documentId)) {
      throw new ContractOutboundReferenceError(
        "CONTRACT_INTAKE_DOCUMENT_NOT_FOUND",
        "登録済み契約取込が見つかりません"
      );
    }
    const existing = this.store.get(documentId) ?? [];
    let lineNo = existing.reduce((max, item) => Math.max(max, item.lineNo), 0);
    const appended: AppendedOutboundCondition[] = [];
    for (const condition of conditions) {
      lineNo += 1;
      const conditionLineId = lineNo * 1000 + documentId;
      existing.push({
        conditionLineId,
        lineNo,
        conditionName: condition.conditionName,
        transactionKind: condition.transactionKind,
        counterpartyVendorId: condition.counterpartyVendorId,
        counterpartyName: "",
        materialIndex: condition.materialIndex,
        territory: condition.territory,
        languages: condition.languages,
        exclusivity: condition.exclusivity,
        sublicenseAllowed: condition.sublicenseAllowed,
        termStart: condition.termStart,
        currency: condition.currency,
        paymentScheme: condition.paymentScheme,
        ratePct: condition.ratePct,
        amountExTax: condition.amountExTax,
        mgAmount: condition.mgAmount,
        advanceAmount: condition.advanceAmount,
        royaltyBase: condition.royaltyBase,
        deductibleCosts: condition.deductibleCosts,
        paymentTerms: condition.paymentTerms,
        notes: condition.notes
      });
      appended.push({
        conditionLineId,
        lineNo,
        conditionName: condition.conditionName,
        counterpartyVendorId: condition.counterpartyVendorId
      });
    }
    this.store.set(documentId, existing);
    return appended;
  }
}
