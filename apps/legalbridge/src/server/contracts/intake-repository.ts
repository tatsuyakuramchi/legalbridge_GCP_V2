import type { PoolClient } from "pg";
import type { DatabasePool } from "../db/pool.js";
import type { ValidatedContractIntake } from "./intake.js";

export interface ContractIntakeBlocker {
  code: string;
  field: string;
  message: string;
  references?: Array<{ id: number; label: string }>;
}

export interface ContractIntakePreflight {
  committable: boolean;
  blockers: ContractIntakeBlocker[];
  references: {
    sourceWorkId: number | null;
    ownWorkId: number | null;
    existingMaterialIds: number[];
  };
}

export interface SavedContractIntake {
  contractId: number;
  documentId: number;
  documentNumber: string;
  sourceWorkId: number;
  ownWorkId: number;
  materialIds: number[];
  materialRightsSourceIds: number[];
  inboundConditionIds: number[];
  outboundConditionsPendingDocument: number;
  createdBy: string;
}

export interface ContractIntakeRepository {
  preflight(input: ValidatedContractIntake): Promise<ContractIntakePreflight>;
  save(input: ValidatedContractIntake, createdBy: string): Promise<SavedContractIntake>;
}

interface ResolvedWork {
  id: number;
  kind: string;
  workCode: string;
  title: string;
  parentWorkId: number | null;
}

interface ResolvedMaterial {
  id: number;
  workId: number;
  materialName: string;
}

interface Inspection {
  preview: ContractIntakePreflight;
  sourceWork: ResolvedWork | null;
  ownWork: ResolvedWork | null;
  materials: Map<number, ResolvedMaterial>;
}

export class PgContractIntakeRepository implements ContractIntakeRepository {
  constructor(private readonly database: DatabasePool) {}

  async preflight(input: ValidatedContractIntake) {
    const client = await this.database.connect();
    try {
      return (await inspect(client, input)).preview;
    } finally {
      client.release();
    }
  }

  async save(input: ValidatedContractIntake, createdBy: string) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('legalbridge-v2-contract-intake'))"
      );

      const inspection = await inspect(client, input);
      if (!inspection.preview.committable) {
        throw new ContractIntakeConflictError(inspection.preview.blockers);
      }

      const sourceWork = inspection.sourceWork ??
        await createWork(client, input.sourceWork, "licensed_in");
      const ownWork = inspection.ownWork ??
        await createWork(client, input.ownWork, "own", sourceWork.id);

      if (sourceWork.id === ownWork.id) {
        throw new ContractIntakeConflictError([{
          code: "SOURCE_AND_OWN_WORK_MUST_DIFFER",
          field: "ownWork.existingWorkId",
          message: "原作と自社作品には異なる作品を指定してください"
        }]);
      }

      await client.query(
        `INSERT INTO work_relations (
           child_work_id, parent_work_id, relation_type
         ) VALUES ($1, $2, 'derived_from')
         ON CONFLICT (child_work_id, parent_work_id) DO NOTHING`,
        [ownWork.id, sourceWork.id]
      );

      const materials: ResolvedMaterial[] = [];
      for (let index = 0; index < input.materials.length; index += 1) {
        const value = input.materials[index];
        const existing = inspection.materials.get(index);
        if (existing) {
          materials.push(existing);
          continue;
        }
        materials.push(await createMaterial(client, sourceWork, value));
      }

      const contractResult = await client.query(
        `INSERT INTO contracts (
           document_number, contract_level, record_type, contract_category,
           contract_type, contract_title, primary_vendor_id, origin,
           lifecycle_stage, executed_at, effective_date, expiration_date,
           auto_renewal, renewal_notice_months, source_system, document_url,
           scope, contract_status
         ) VALUES (
           $1, 'individual', 'license_condition', 'license',
           $2, $3, $4, 'registered',
           'executed', $5::date, $6::date, $7::date,
           $8, $9, $10, $11,
           $12, 'executed'
         )
         RETURNING id`,
        [
          input.contract.documentNumber,
          input.contract.contractType,
          input.contract.contractTitle,
          input.contract.primaryVendorId,
          input.contract.executedAt,
          input.contract.effectiveDate ?? null,
          input.contract.expirationDate ?? null,
          input.contract.autoRenewal,
          input.contract.renewalNoticeMonths ?? null,
          input.contract.sourceSystem,
          input.contract.documentUrl ?? null,
          input.contract.scope ?? null
        ]
      );
      const contractId = Number(contractResult.rows[0].id);

      await client.query(
        `INSERT INTO contract_works (
           contract_id, work_id, role, rights_holder_vendor_id
         ) VALUES
           ($1, $2, 'licensed_source', $4),
           ($1, $3, 'licensed_work', $4)`,
        [
          contractId,
          sourceWork.id,
          ownWork.id,
          input.contract.primaryVendorId
        ]
      );

      const documentResult = await client.query(
        `INSERT INTO documents (
           issue_key, template_type, form_data, drive_link, created_by,
           document_number, document_category, lifecycle_status,
           vendor_id, record_type, contract_category, contract_type,
           contract_title, contract_status, effective_date, expiration_date,
           flow_direction, ledger_ref_id, original_work, work_name,
           document_url, source_system, scope, contract_id
         ) VALUES (
           $1, 'registered_master', $2::jsonb, '', $3,
           $4, 'contract', 'final',
           $5, 'license_condition', 'license', $6,
           $7, 'executed', $8::date, $9::date,
           'in', $10, $11, $12,
           $13, $14, $15, $16
         )
         RETURNING id`,
        [
          `INTAKE-${input.contract.documentNumber}`,
          JSON.stringify(input),
          createdBy,
          input.contract.documentNumber,
          input.contract.primaryVendorId,
          input.contract.contractType,
          input.contract.contractTitle,
          input.contract.effectiveDate ?? null,
          input.contract.expirationDate ?? null,
          ownWork.id,
          sourceWork.title,
          ownWork.title,
          input.contract.documentUrl ?? null,
          input.contract.sourceSystem,
          input.contract.scope ?? null,
          contractId
        ]
      );
      const documentId = Number(documentResult.rows[0].id);

      const materialRightsSourceIds: number[] = [];
      for (let index = 0; index < materials.length; index += 1) {
        const materialInput = input.materials[index];
        const rightsResult = await client.query(
          `INSERT INTO material_rights_sources (
             material_id, source_type, source_work_id,
             rights_holder_vendor_id, source_document_id, source_contract_id,
             source_role, is_primary, valid_from, valid_to
           ) VALUES (
             $1, 'direct_contract', $2,
             $3, $4, $5,
             'other', true, $6::date, $7::date
           )
           RETURNING id`,
          [
            materials[index].id,
            sourceWork.id,
            materialInput.rightsHolderVendorId ??
              input.contract.primaryVendorId,
            documentId,
            contractId,
            input.contract.effectiveDate ?? input.contract.executedAt,
            input.contract.expirationDate ?? null
          ]
        );
        materialRightsSourceIds.push(Number(rightsResult.rows[0].id));
      }

      const inboundConditionIds: number[] = [];
      for (let index = 0; index < input.inboundConditions.length; index += 1) {
        const condition = input.inboundConditions[index];
        const materialIndex = condition.materialIndex;
        const material = materialIndex === undefined ? null : materials[materialIndex];
        const rightsSourceId = materialIndex === undefined
          ? null
          : materialRightsSourceIds[materialIndex];

        const conditionResult = await client.query(
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
             $1, $2, $3, 'payable', $4,
             $5, $6, $7, $8,
             $9::date, $10::date, $11, $12, $13, $14,
             $15, false, 'in', $16,
             $17, $18, $19,
             $1, $20, $21, $22,
             $23, $24, $25,
             $26, $27, $28,
             $29, $30, $31
           )
           RETURNING id`,
          [
            documentId,
            index + 1,
            ownWork.id,
            condition.paymentScheme,
            condition.rightsAttribution ?? "license_only",
            condition.currency,
            condition.notes ?? null,
            condition.amountExTax ?? null,
            condition.termStart ?? input.contract.effectiveDate ?? null,
            condition.termEnd ?? input.contract.expirationDate ?? null,
            condition.reportingCycle ?? null,
            condition.ratePct ?? null,
            condition.mgAmount ?? null,
            condition.advanceAmount ?? null,
            condition.paymentTerms ?? null,
            condition.transactionKind,
            sourceWork.id,
            material?.id ?? null,
            condition.counterpartyVendorId ??
              input.contract.primaryVendorId,
            condition.conditionName,
            condition.territory,
            condition.languages.join(", "),
            rightsSourceId,
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
        const conditionId = Number(conditionResult.rows[0].id);
        inboundConditionIds.push(conditionId);

        await client.query(
          `INSERT INTO condition_line_regions (
             condition_line_id, country_name, sort_order
           ) VALUES ($1, $2, 0)`,
          [conditionId, condition.territory]
        );
        for (let languageIndex = 0;
          languageIndex < condition.languages.length;
          languageIndex += 1) {
          await client.query(
            `INSERT INTO condition_line_languages (
               condition_line_id, language_name, sort_order
             ) VALUES ($1, $2, $3)`,
            [conditionId, condition.languages[languageIndex], languageIndex]
          );
        }
      }

      await client.query("COMMIT");
      return {
        contractId,
        documentId,
        documentNumber: input.contract.documentNumber,
        sourceWorkId: sourceWork.id,
        ownWorkId: ownWork.id,
        materialIds: materials.map((item) => item.id),
        materialRightsSourceIds,
        inboundConditionIds,
        outboundConditionsPendingDocument: input.outboundConditions.length,
        createdBy
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ContractIntakeConflictError([{
          code: "CONCURRENT_DUPLICATE",
          field: "contract.documentNumber",
          message: "同じ識別子のデータが同時に登録されました。再度プリフライトしてください"
        }]);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function inspect(
  client: PoolClient,
  input: ValidatedContractIntake
): Promise<Inspection> {
  const blockers: ContractIntakeBlocker[] = [];
  const vendorIds = new Set<number>([input.contract.primaryVendorId]);
  if (input.sourceWork.rightsHolderVendorId) {
    vendorIds.add(input.sourceWork.rightsHolderVendorId);
  }
  if (input.ownWork.rightsHolderVendorId) {
    vendorIds.add(input.ownWork.rightsHolderVendorId);
  }
  for (const material of input.materials) {
    if (material.rightsHolderVendorId) vendorIds.add(material.rightsHolderVendorId);
  }
  for (const condition of input.inboundConditions) {
    if (condition.counterpartyVendorId) vendorIds.add(condition.counterpartyVendorId);
  }
  for (const condition of input.outboundConditions) {
    vendorIds.add(condition.counterpartyVendorId);
  }

  const vendors = await client.query(
    "SELECT id FROM vendors WHERE id = ANY($1::int[])",
    [[...vendorIds]]
  );
  const foundVendors = new Set(vendors.rows.map((row) => Number(row.id)));
  for (const id of vendorIds) {
    if (!foundVendors.has(id)) {
      blockers.push({
        code: "VENDOR_NOT_FOUND",
        field: "contract.primaryVendorId",
        message: `取引先ID ${id} は存在しません`
      });
    }
  }

  const sourceWork = input.sourceWork.existingWorkId
    ? await findWork(client, input.sourceWork.existingWorkId)
    : null;
  const ownWork = input.ownWork.existingWorkId
    ? await findWork(client, input.ownWork.existingWorkId)
    : null;

  if (input.sourceWork.existingWorkId && !sourceWork) {
    blockers.push({
      code: "SOURCE_WORK_NOT_FOUND",
      field: "sourceWork.existingWorkId",
      message: "指定された原作は存在しません"
    });
  } else if (sourceWork && sourceWork.kind !== "licensed_in") {
    blockers.push({
      code: "SOURCE_WORK_KIND_MISMATCH",
      field: "sourceWork.existingWorkId",
      message: "原作には licensed_in の作品を指定してください"
    });
  }

  if (input.ownWork.existingWorkId && !ownWork) {
    blockers.push({
      code: "OWN_WORK_NOT_FOUND",
      field: "ownWork.existingWorkId",
      message: "指定された自社作品は存在しません"
    });
  } else if (ownWork && ownWork.kind !== "own") {
    blockers.push({
      code: "OWN_WORK_KIND_MISMATCH",
      field: "ownWork.existingWorkId",
      message: "自社作品には own の作品を指定してください"
    });
  }

  if (sourceWork && ownWork?.parentWorkId &&
      ownWork.parentWorkId !== sourceWork.id) {
    blockers.push({
      code: "OWN_WORK_PARENT_CONFLICT",
      field: "ownWork.existingWorkId",
      message: "自社作品には別の親作品が設定されています"
    });
  }

  if (!input.sourceWork.existingWorkId && input.sourceWork.title) {
    await addDuplicateWorkBlocker(
      client, blockers, input.sourceWork.title, "licensed_in", "sourceWork.title"
    );
  }
  if (!input.ownWork.existingWorkId && input.ownWork.title) {
    await addDuplicateWorkBlocker(
      client, blockers, input.ownWork.title, "own", "ownWork.title"
    );
  }

  const numberConflict = await client.query(
    `SELECT id, 'contracts' AS source
       FROM contracts WHERE document_number = $1
     UNION ALL
     SELECT id, 'documents' AS source
       FROM documents WHERE document_number = $1`,
    [input.contract.documentNumber]
  );
  if (numberConflict.rows.length) {
    blockers.push({
      code: "DOCUMENT_NUMBER_EXISTS",
      field: "contract.documentNumber",
      message: "同じ契約書番号が既に登録されています",
      references: numberConflict.rows.map((row) => ({
        id: Number(row.id),
        label: String(row.source)
      }))
    });
  }

  const materials = new Map<number, ResolvedMaterial>();
  for (let index = 0; index < input.materials.length; index += 1) {
    const material = input.materials[index];
    if (material.existingMaterialId) {
      const result = await client.query(
        `SELECT id, work_id, COALESCE(material_name, material_code, id::text) AS material_name
           FROM work_materials
          WHERE id = $1`,
        [material.existingMaterialId]
      );
      const row = result.rows[0];
      if (!row) {
        blockers.push({
          code: "MATERIAL_NOT_FOUND",
          field: `materials.${index}.existingMaterialId`,
          message: "指定された素材は存在しません"
        });
      } else {
        const resolved = {
          id: Number(row.id),
          workId: Number(row.work_id),
          materialName: String(row.material_name)
        };
        materials.set(index, resolved);
        if (!sourceWork) {
          blockers.push({
            code: "EXISTING_MATERIAL_REQUIRES_EXISTING_SOURCE",
            field: `materials.${index}.existingMaterialId`,
            message: "既存素材を使用する場合は既存の原作を選択してください"
          });
        } else if (resolved.workId !== sourceWork.id) {
          blockers.push({
            code: "MATERIAL_WORK_MISMATCH",
            field: `materials.${index}.existingMaterialId`,
            message: "指定素材は選択された原作に属していません"
          });
        }
      }
    } else if (sourceWork && material.materialName) {
      const duplicate = await client.query(
        `SELECT id, COALESCE(material_name, material_code, id::text) AS label
           FROM work_materials
          WHERE work_id = $1
            AND lb_norm_name(COALESCE(material_name, '')) =
                lb_norm_name($2)`,
        [sourceWork.id, material.materialName]
      );
      if (duplicate.rows.length) {
        blockers.push({
          code: "DUPLICATE_MATERIAL_NAME",
          field: `materials.${index}.materialName`,
          message: "同じ原作に同名の素材があります。既存素材を選択してください",
          references: duplicate.rows.map((row) => ({
            id: Number(row.id),
            label: String(row.label)
          }))
        });
      }
    }
  }

  return {
    preview: {
      committable: blockers.length === 0,
      blockers,
      references: {
        sourceWorkId: sourceWork?.id ?? null,
        ownWorkId: ownWork?.id ?? null,
        existingMaterialIds: [...materials.values()].map((item) => item.id)
      }
    },
    sourceWork,
    ownWork,
    materials
  };
}

async function findWork(client: PoolClient, id: number) {
  const result = await client.query(
    `SELECT id, kind, work_code, title, parent_work_id
       FROM works
      WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: String(row.kind),
    workCode: String(row.work_code),
    title: String(row.title),
    parentWorkId: row.parent_work_id === null
      ? null
      : Number(row.parent_work_id)
  } satisfies ResolvedWork;
}

async function addDuplicateWorkBlocker(
  client: PoolClient,
  blockers: ContractIntakeBlocker[],
  title: string,
  kind: "licensed_in" | "own",
  field: string
) {
  const result = await client.query(
    `SELECT id, title
       FROM works
      WHERE kind = $1
        AND lb_norm_name(title) = lb_norm_name($2)`,
    [kind, title]
  );
  if (!result.rows.length) return;
  blockers.push({
    code: "DUPLICATE_WORK_TITLE",
    field,
    message: "同種別・同名の作品があります。既存作品を選択してください",
    references: result.rows.map((row) => ({
      id: Number(row.id),
      label: String(row.title)
    }))
  });
}

async function createWork(
  client: PoolClient,
  value: ValidatedContractIntake["sourceWork"],
  kind: "licensed_in" | "own",
  parentWorkId: number | null = null
): Promise<ResolvedWork> {
  const code = await nextWorkCode(client, kind);
  const result = await client.query(
    `INSERT INTO works (
       work_code, title, title_kana, work_type, status,
       is_original, remarks, parent_work_id, derivation_type, kind,
       rights_holder_vendor_id, creator_name, publisher_name
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13
     )
     RETURNING id, kind, work_code, title, parent_work_id`,
    [
      code,
      value.title,
      value.titleKana ?? null,
      value.workType ?? null,
      value.status ?? null,
      kind === "licensed_in",
      value.remarks ?? null,
      parentWorkId,
      parentWorkId ? "licensed_derivative" : null,
      kind,
      value.rightsHolderVendorId ?? null,
      value.creatorName ?? null,
      value.publisherName ?? null
    ]
  );
  const row = result.rows[0];
  return {
    id: Number(row.id),
    kind: String(row.kind),
    workCode: String(row.work_code),
    title: String(row.title),
    parentWorkId: row.parent_work_id === null
      ? null
      : Number(row.parent_work_id)
  };
}

async function nextWorkCode(
  client: PoolClient,
  kind: "licensed_in" | "own"
) {
  const year = currentYearInTokyo();
  const prefix = kind === "licensed_in" ? "LO" : "W";
  const sequenceKind = kind === "licensed_in"
    ? "licensed_in_work"
    : "own_work";
  const pattern = `^${prefix}-${year}-([0-9]+)$`;
  const maximum = await client.query(
    `SELECT COALESCE(MAX((substring(work_code FROM $1))::integer), 0) AS value
       FROM works
      WHERE work_code ~ $1`,
    [pattern]
  );
  const nextFromData = Number(maximum.rows[0]?.value ?? 0) + 1;
  const sequence = await client.query(
    `INSERT INTO document_sequences (kind, year, current_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, year) DO UPDATE
       SET current_value = GREATEST(
         document_sequences.current_value + 1,
         EXCLUDED.current_value
       )
     RETURNING current_value`,
    [sequenceKind, year, nextFromData]
  );
  return `${prefix}-${year}-${String(sequence.rows[0].current_value).padStart(4, "0")}`;
}

async function createMaterial(
  client: PoolClient,
  sourceWork: ResolvedWork,
  value: ValidatedContractIntake["materials"][number]
): Promise<ResolvedMaterial> {
  await client.query(
    `INSERT INTO material_categories (
       work_id, genre, name, rights_holder_vendor_id,
       rights_holder_label, sort_order, is_active
     ) VALUES ($1, $2, $3, $4, $5, 0, true)
     ON CONFLICT (work_id, genre) DO NOTHING`,
    [
      sourceWork.id,
      value.materialType,
      value.materialType,
      value.rightsHolderVendorId ?? null,
      value.rightsHolderLabel ?? null
    ]
  );
  const category = await client.query(
    "SELECT id FROM material_categories WHERE work_id = $1 AND genre = $2",
    [sourceWork.id, value.materialType]
  );
  const numberResult = await client.query(
    `SELECT COALESCE(MAX(material_no), 0) + 1 AS material_no
       FROM work_materials
      WHERE work_id = $1`,
    [sourceWork.id]
  );
  const materialNo = Number(numberResult.rows[0].material_no);
  const materialCode =
    `${sourceWork.workCode}-${String(materialNo).padStart(3, "0")}`;
  const result = await client.query(
    `INSERT INTO work_materials (
       work_id, material_name, material_type, rights_type,
       rights_holder_vendor_id, is_royalty_bearing, remarks,
       rights_holder_label, material_no, material_code, is_default,
       acquisition_type, material_role, category_id, territory, language
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15, $16
     )
     RETURNING id, work_id, material_name`,
    [
      sourceWork.id,
      value.materialName,
      value.materialType,
      value.rightsType ?? "license",
      value.rightsHolderVendorId ?? null,
      value.isRoyaltyBearing,
      value.remarks ?? null,
      value.rightsHolderLabel ?? null,
      materialNo,
      materialCode,
      value.isDefault,
      value.acquisitionType,
      value.materialRole,
      Number(category.rows[0].id),
      value.territory ?? null,
      value.language ?? null
    ]
  );
  return {
    id: Number(result.rows[0].id),
    workId: Number(result.rows[0].work_id),
    materialName: String(result.rows[0].material_name)
  };
}

function currentYearInTokyo() {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric"
  }).format(new Date()));
}

export class MemoryContractIntakeRepository implements ContractIntakeRepository {
  readonly saved: SavedContractIntake[] = [];
  preview: ContractIntakePreflight = {
    committable: true,
    blockers: [],
    references: {
      sourceWorkId: null,
      ownWorkId: null,
      existingMaterialIds: []
    }
  };

  async preflight(_input: ValidatedContractIntake) {
    return this.preview;
  }

  async save(input: ValidatedContractIntake, createdBy: string) {
    if (!this.preview.committable) {
      throw new ContractIntakeConflictError(this.preview.blockers);
    }
    const sequence = this.saved.length + 1;
    const saved: SavedContractIntake = {
      contractId: sequence,
      documentId: sequence,
      documentNumber: input.contract.documentNumber,
      sourceWorkId: input.sourceWork.existingWorkId ?? sequence * 10,
      ownWorkId: input.ownWork.existingWorkId ?? sequence * 10 + 1,
      materialIds: input.materials.map((item, index) =>
        item.existingMaterialId ?? sequence * 100 + index
      ),
      materialRightsSourceIds: input.materials.map((_, index) =>
        sequence * 1000 + index
      ),
      inboundConditionIds: input.inboundConditions.map((_, index) =>
        sequence * 10000 + index
      ),
      outboundConditionsPendingDocument: input.outboundConditions.length,
      createdBy
    };
    this.saved.push(saved);
    return saved;
  }
}

export class ContractIntakeConflictError extends Error {
  constructor(readonly blockers: ContractIntakeBlocker[]) {
    super("contract intake preflight failed");
  }
}
