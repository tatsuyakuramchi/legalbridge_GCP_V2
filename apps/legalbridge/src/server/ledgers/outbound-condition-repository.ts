import type { DatabasePool } from "../db/pool.js";
import type { outboundConditionSchema } from "./outbound-conditions.js";
import { mapOutboundConditionForStorage } from "./outbound-condition-storage.js";
import type { z } from "zod";

type ValidatedOutboundCondition = z.output<typeof outboundConditionSchema>;

export interface SavedOutboundCondition {
  id: number;
  documentId: number;
  documentNumber: string;
  lineNo: number;
  workId: number;
  counterpartyVendorId: number;
  transactionKind: "license" | "product";
  direction: "receivable";
  conditionName: string;
}

export interface OutboundConditionRepository {
  save(condition: ValidatedOutboundCondition): Promise<SavedOutboundCondition>;
}

export class PgOutboundConditionRepository implements OutboundConditionRepository {
  constructor(private readonly database: DatabasePool) {}

  async save(condition: ValidatedOutboundCondition) {
    const value = mapOutboundConditionForStorage(condition);
    if (!value.documentNumber) {
      throw new OutboundConditionReferenceError("document number is required");
    }

    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const document = await client.query(
        `SELECT id, document_number
           FROM documents
          WHERE document_number = $1
          FOR UPDATE`,
        [value.documentNumber]
      );
      if (!document.rows[0]) {
        throw new OutboundConditionReferenceError("document not found");
      }

      const [work, vendor] = await Promise.all([
        client.query("SELECT id FROM works WHERE id = $1", [value.workId]),
        client.query("SELECT id FROM vendors WHERE id = $1", [value.counterpartyVendorId])
      ]);
      if (!work.rows[0]) throw new OutboundConditionReferenceError("work not found");
      if (!vendor.rows[0]) throw new OutboundConditionReferenceError("counterparty not found");

      const documentId = Number(document.rows[0].id);
      const line = await client.query(
        `SELECT COALESCE(MAX(line_no), 0) + 1 AS line_no
           FROM condition_lines
          WHERE document_id = $1`,
        [documentId]
      );
      const lineNo = Number(line.rows[0]?.line_no ?? 1);

      const inserted = await client.query(
        `INSERT INTO condition_lines (
           document_id, line_no, work_id, counterparty_vendor_id,
           transaction_kind, direction, flow_direction, condition_name,
           region_territory, region_language, exclusivity,
           sublicense_allowed, term_start, term_end, currency,
           payment_scheme, rate_pct, amount_ex_tax, mg_amount, ag_amount,
           cycle, payment_terms, royalty_base, incoterms,
           minimum_quantity, sell_off_months, withholding_tax_treatment,
           notes
         ) VALUES (
           $1, $2, $3, $4,
           $5, 'receivable', 'out', $6,
           $7, $8, $9,
           $10, $11, $12, $13,
           $14, $15, $16, $17, $18,
           $19, $20, $21, $22,
           $23, $24, $25,
           $26
         )
         RETURNING id`,
        [
          documentId,
          lineNo,
          value.workId,
          value.counterpartyVendorId,
          value.transactionKind,
          value.conditionName,
          value.territory,
          value.language,
          value.exclusivity,
          value.sublicenseAllowed,
          value.termStart,
          value.termEnd,
          value.currency,
          value.paymentScheme,
          value.ratePct,
          value.amountExTax,
          value.mgAmount,
          value.agAmount,
          value.reportingCycle,
          value.paymentTerms,
          value.royaltyBase,
          value.incoterms,
          value.minimumQuantity,
          value.sellOffMonths,
          value.withholdingTaxTreatment,
          value.notes
        ]
      );

      const conditionLineId = Number(inserted.rows[0].id);
      const canonicalRegions = value.regions.filter((item) => !item.code.startsWith("LEGACY-"));
      const canonicalLanguages = value.languages.filter((item) => !item.code.startsWith("LEGACY-"));

      for (let index = 0; index < canonicalRegions.length; index += 1) {
        const region = canonicalRegions[index];
        await client.query(
          `INSERT INTO condition_line_regions (
             condition_line_id, country_code, country_name, sort_order
           ) VALUES ($1, $2, $3, $4)`,
          [conditionLineId, region.code, region.name, index + 1]
        );
      }
      for (let index = 0; index < canonicalLanguages.length; index += 1) {
        const language = canonicalLanguages[index];
        await client.query(
          `INSERT INTO condition_line_languages (
             condition_line_id, language_code, language_name, sort_order
           ) VALUES ($1, $2, $3, $4)`,
          [conditionLineId, language.code, language.name, index + 1]
        );
      }

      await client.query("COMMIT");
      return {
        id: Number(inserted.rows[0].id),
        documentId,
        documentNumber: String(document.rows[0].document_number),
        lineNo,
        workId: value.workId,
        counterpartyVendorId: value.counterpartyVendorId,
        transactionKind: value.transactionKind,
        direction: "receivable" as const,
        conditionName: value.conditionName
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new OutboundConditionConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export class MemoryOutboundConditionRepository implements OutboundConditionRepository {
  private sequence = 1;
  readonly conditions: SavedOutboundCondition[] = [];

  constructor(
    private readonly documents = new Map([["ARC-LIC-2026-0001", 1]]),
    private readonly workIds = new Set([42]),
    private readonly vendorIds = new Set([18])
  ) {}

  async save(condition: ValidatedOutboundCondition) {
    const value = mapOutboundConditionForStorage(condition);
    if (!value.documentNumber) {
      throw new OutboundConditionReferenceError("document number is required");
    }
    const documentId = this.documents.get(value.documentNumber);
    if (!documentId) throw new OutboundConditionReferenceError("document not found");
    if (!this.workIds.has(value.workId)) {
      throw new OutboundConditionReferenceError("work not found");
    }
    if (!this.vendorIds.has(value.counterpartyVendorId)) {
      throw new OutboundConditionReferenceError("counterparty not found");
    }
    const saved: SavedOutboundCondition = {
      id: this.sequence,
      documentId,
      documentNumber: value.documentNumber,
      lineNo: this.conditions.filter((item) => item.documentId === documentId).length + 1,
      workId: value.workId,
      counterpartyVendorId: value.counterpartyVendorId,
      transactionKind: value.transactionKind,
      direction: "receivable",
      conditionName: value.conditionName
    };
    this.sequence += 1;
    this.conditions.push(saved);
    return saved;
  }
}

export class OutboundConditionReferenceError extends Error {}
export class OutboundConditionConflictError extends Error {
  constructor() {
    super("outbound condition changed before it could be saved");
  }
}
