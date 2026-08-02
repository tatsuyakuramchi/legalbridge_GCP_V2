import type { DatabasePool } from "../db/pool.js";
import {
  contractIntakeSchema,
  type ValidatedContractIntake
} from "./intake.js";
import {
  listContractOutboundConditions,
  type OutboundBridgeCondition
} from "./intake-outbound-repository.js";

export interface IntakeBridgeWork {
  id: number;
  workCode: string;
  title: string;
}

export interface IntakeBridgeMaterial {
  id: number;
  materialCode: string;
  materialName: string;
  rightsHolderLabel: string;
}

export interface IntakeBridgeVendor {
  id: number;
  vendorName: string;
  entityType: string;
  address: string;
  representative: string;
  contactName: string;
  phone: string;
  email: string;
}

export interface ContractIntakeDocumentSource {
  documentId: number;
  contractId: number;
  documentNumber: string;
  intake: ValidatedContractIntake;
  sourceWork: IntakeBridgeWork;
  ownWork: IntakeBridgeWork;
  materials: IntakeBridgeMaterial[];
  vendors: Record<number, IntakeBridgeVendor>;
  // Outbound conditions are registered later and stored as condition_lines,
  // not inside the intake form_data. The bridge reads them from here.
  outboundConditions: OutboundBridgeCondition[];
}

export interface ContractIntakeRegistrySummary {
  documentId: number;
  contractId: number;
  documentNumber: string;
  contractTitle: string;
  contractType: string;
  primaryVendorId: number;
  primaryVendorName: string;
  sourceWorkTitle: string;
  ownWorkTitle: string;
  executedAt: string;
  inboundConditionCount: number;
  outboundConditionCount: number;
}

export interface ContractIntakeDocumentSourceRepository {
  find(documentId: number): Promise<ContractIntakeDocumentSource | null>;
  list(limit?: number): Promise<ContractIntakeRegistrySummary[]>;
}

export class PgContractIntakeDocumentSourceRepository
implements ContractIntakeDocumentSourceRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(limit = 50) {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const result = await this.database.query(
      `SELECT d.id, d.contract_id, d.document_number, d.form_data,
              COALESCE(v.vendor_name, '') AS primary_vendor_name,
              COALESCE(sw.title, '') AS source_work_title,
              COALESCE(ow.title, '') AS own_work_title,
              (SELECT COUNT(*) FROM condition_lines cl
                WHERE cl.document_id = d.id AND cl.flow_direction = 'out')
                AS outbound_condition_count
         FROM documents d
         LEFT JOIN vendors v
           ON v.id = NULLIF(d.form_data->'contract'->>'primaryVendorId', '')::integer
         LEFT JOIN contract_works cws
           ON cws.contract_id = d.contract_id AND cws.role = 'licensed_source'
         LEFT JOIN works sw ON sw.id = cws.work_id
         LEFT JOIN contract_works cwo
           ON cwo.contract_id = d.contract_id AND cwo.role = 'licensed_work'
         LEFT JOIN works ow ON ow.id = cwo.work_id
        WHERE d.template_type = 'registered_master'
          AND d.record_type = 'license_condition'
          AND d.contract_id IS NOT NULL
        ORDER BY d.id DESC
        LIMIT $1`,
      [boundedLimit]
    );

    const summaries: ContractIntakeRegistrySummary[] = [];
    for (const row of result.rows) {
      const parsed = contractIntakeSchema.safeParse(row.form_data);
      if (!parsed.success) continue;
      summaries.push({
        documentId: Number(row.id),
        contractId: Number(row.contract_id),
        documentNumber: String(row.document_number),
        contractTitle: parsed.data.contract.contractTitle,
        contractType: parsed.data.contract.contractType,
        primaryVendorId: parsed.data.contract.primaryVendorId,
        primaryVendorName: String(row.primary_vendor_name),
        sourceWorkTitle: String(row.source_work_title) ||
          parsed.data.sourceWork.title || "",
        ownWorkTitle: String(row.own_work_title) ||
          parsed.data.ownWork.title || "",
        executedAt: parsed.data.contract.executedAt,
        inboundConditionCount: parsed.data.inboundConditions.length,
        outboundConditionCount: Number(row.outbound_condition_count ?? 0)
      });
    }
    return summaries;
  }

  async find(documentId: number) {
    const document = await this.database.query(
      `SELECT id, contract_id, document_number, form_data
         FROM documents
        WHERE id = $1
          AND template_type = 'registered_master'
          AND record_type = 'license_condition'
          AND contract_id IS NOT NULL
        LIMIT 1`,
      [documentId]
    );
    const row = document.rows[0];
    if (!row) return null;

    const parsed = contractIntakeSchema.safeParse(row.form_data);
    if (!parsed.success) {
      throw new Error("registered contract intake form data is invalid");
    }

    const contractId = Number(row.contract_id);
    const [workResult, materialResult] = await Promise.all([
      this.database.query(
        `SELECT cw.role, w.id, w.work_code, w.title
           FROM contract_works cw
           JOIN works w ON w.id = cw.work_id
          WHERE cw.contract_id = $1
            AND cw.role IN ('licensed_source', 'licensed_work')`,
        [contractId]
      ),
      this.database.query(
        `SELECT wm.id, COALESCE(wm.material_code, '') AS material_code,
                COALESCE(wm.material_name, wm.material_code, wm.id::text) AS material_name,
                COALESCE(wm.rights_holder_label, '') AS rights_holder_label
           FROM material_rights_sources mrs
           JOIN work_materials wm ON wm.id = mrs.material_id
          WHERE mrs.source_document_id = $1
          ORDER BY mrs.id`,
        [documentId]
      )
    ]);

    const sourceRow = workResult.rows.find((item) => item.role === "licensed_source");
    const ownRow = workResult.rows.find((item) => item.role === "licensed_work");
    if (!sourceRow || !ownRow) {
      throw new Error("registered contract intake work links are incomplete");
    }

    const vendorIds = new Set<number>([parsed.data.contract.primaryVendorId]);
    for (const condition of parsed.data.inboundConditions) {
      if (condition.counterpartyVendorId) vendorIds.add(condition.counterpartyVendorId);
    }
    for (const condition of parsed.data.outboundConditions) {
      vendorIds.add(condition.counterpartyVendorId);
    }
    for (const material of parsed.data.materials) {
      if (material.rightsHolderVendorId) vendorIds.add(material.rightsHolderVendorId);
    }

    const outboundConditions =
      await listContractOutboundConditions(this.database, documentId);
    for (const condition of outboundConditions) {
      vendorIds.add(condition.counterpartyVendorId);
    }

    const vendorResult = await this.database.query(
      `SELECT id, vendor_name, entity_type, address, vendor_rep,
              contact_name, phone, email
         FROM vendors
        WHERE id = ANY($1::integer[])`,
      [[...vendorIds]]
    );
    const vendors = Object.fromEntries(vendorResult.rows.map((vendor) => [
      Number(vendor.id),
      {
        id: Number(vendor.id),
        vendorName: String(vendor.vendor_name ?? ""),
        entityType: String(vendor.entity_type ?? ""),
        address: String(vendor.address ?? ""),
        representative: String(vendor.vendor_rep ?? ""),
        contactName: String(vendor.contact_name ?? ""),
        phone: String(vendor.phone ?? ""),
        email: String(vendor.email ?? "")
      } satisfies IntakeBridgeVendor
    ]));

    return {
      documentId: Number(row.id),
      contractId,
      documentNumber: String(row.document_number),
      intake: parsed.data,
      sourceWork: mapWork(sourceRow),
      ownWork: mapWork(ownRow),
      materials: materialResult.rows.map((material) => ({
        id: Number(material.id),
        materialCode: String(material.material_code),
        materialName: String(material.material_name),
        rightsHolderLabel: String(material.rights_holder_label)
      })),
      vendors,
      outboundConditions
    } satisfies ContractIntakeDocumentSource;
  }
}

function mapWork(row: Record<string, unknown>): IntakeBridgeWork {
  return {
    id: Number(row.id),
    workCode: String(row.work_code),
    title: String(row.title)
  };
}

export class MemoryContractIntakeDocumentSourceRepository
implements ContractIntakeDocumentSourceRepository {
  constructor(
    readonly sources = new Map<number, ContractIntakeDocumentSource>()
  ) {}

  async list(limit = 50) {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return [...this.sources.values()]
      .sort((left, right) => right.documentId - left.documentId)
      .slice(0, boundedLimit)
      .map((source) => ({
        documentId: source.documentId,
        contractId: source.contractId,
        documentNumber: source.documentNumber,
        contractTitle: source.intake.contract.contractTitle,
        contractType: source.intake.contract.contractType,
        primaryVendorId: source.intake.contract.primaryVendorId,
        primaryVendorName:
          source.vendors[source.intake.contract.primaryVendorId]?.vendorName ?? "",
        sourceWorkTitle: source.sourceWork.title,
        ownWorkTitle: source.ownWork.title,
        executedAt: source.intake.contract.executedAt,
        inboundConditionCount: source.intake.inboundConditions.length,
        outboundConditionCount: source.outboundConditions.length
      } satisfies ContractIntakeRegistrySummary));
  }

  async find(documentId: number) {
    return this.sources.get(documentId) ?? null;
  }
}
