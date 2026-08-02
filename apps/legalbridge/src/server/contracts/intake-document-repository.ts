import type { DatabasePool } from "../db/pool.js";
import {
  contractIntakeSchema,
  type ValidatedContractIntake
} from "./intake.js";

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
}

export interface ContractIntakeDocumentSourceRepository {
  find(documentId: number): Promise<ContractIntakeDocumentSource | null>;
}

export class PgContractIntakeDocumentSourceRepository
implements ContractIntakeDocumentSourceRepository {
  constructor(private readonly database: DatabasePool) {}

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
      vendors
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

  async find(documentId: number) {
    return this.sources.get(documentId) ?? null;
  }
}
