import type { PoolClient } from "pg";
import type { DatabasePool } from "../db/pool.js";

export type ConditionAttachmentFlow = "in" | "out";
export type ConditionAttachmentMode = "create" | "link_existing";

export interface ConditionAttachmentInput {
  mode: ConditionAttachmentMode;
  existingConditionLineId?: number;
  workId: number;
  sourceWorkId?: number;
  sourceMaterialId?: number;
  contractId?: number;
  parentLicenseConditionId?: number;
  counterpartyVendorId?: number;
  conditionName?: string;
  flowDirection: ConditionAttachmentFlow;
  transactionKind: string;
  paymentScheme?: string;
  calcType?: string;
  currency?: string;
  ratePct?: number;
  amountExTax?: number;
  mgAmount?: number;
  agAmount?: number;
  termStart?: string;
  termEnd?: string;
  territory?: string;
  languages?: string[];
  exclusivity?: string;
  sublicenseAllowed?: boolean;
  royaltyBase?: string;
  deductibleCosts?: string;
  notes?: string;
}

export interface AttachedCondition {
  id: number;
  lineNo: number;
  conditionName: string;
  workId: number | null;
  workTitle: string | null;
  sourceWorkId: number | null;
  sourceWorkTitle: string | null;
  sourceMaterialId: number | null;
  sourceMaterialName: string | null;
  flowDirection: string | null;
  direction: string | null;
  transactionKind: string | null;
  paymentScheme: string | null;
  ratePct: number | null;
  currency: string | null;
  parentLicenseConditionId: number | null;
}

export interface DocumentConditionAttachmentContext {
  document: {
    id: number;
    documentNumber: string | null;
    templateType: string;
    title: string;
    contractId: number | null;
    workId: number | null;
    materialId: number | null;
  };
  conditions: AttachedCondition[];
}

export interface ConditionAttachmentResult {
  condition: AttachedCondition;
  createdMaterialRightsSourceId: number | null;
  warnings: string[];
}

export interface DocumentConditionAttachmentRepository {
  context(documentId: number): Promise<DocumentConditionAttachmentContext | null>;
  attach(documentId: number, input: ConditionAttachmentInput): Promise<ConditionAttachmentResult>;
}

export class ConditionAttachmentError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class PgDocumentConditionAttachmentRepository
implements DocumentConditionAttachmentRepository {
  constructor(private readonly database: DatabasePool) {}

  async context(documentId: number) {
    const document = await this.database.query(
      `SELECT d.id,d.document_number,d.template_type,d.contract_id,
              d.ledger_ref_id,d.material_ref_id,
              COALESCE(NULLIF(d.contract_title,''),NULLIF(d.work_name,''),
                       NULLIF(d.product_name,''),d.document_number,d.issue_key) AS title
         FROM documents d WHERE d.id=$1`,
      [documentId]
    );
    if (!document.rows[0]) return null;
    const conditions = await listAttached(this.database, documentId);
    const row = document.rows[0];
    return {
      document: {
        id: Number(row.id),
        documentNumber: row.document_number ?? null,
        templateType: String(row.template_type ?? ""),
        title: String(row.title ?? ""),
        contractId: nullableInt(row.contract_id),
        workId: nullableInt(row.ledger_ref_id),
        materialId: nullableInt(row.material_ref_id)
      },
      conditions
    };
  }

  async attach(documentId: number, input: ConditionAttachmentInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock(922102, $1)", [documentId]);

      const document = await lockDocument(client, documentId);
      const effectiveInput: ConditionAttachmentInput = {
        ...input,
        contractId: effectiveInput.contractId ?? nullableInt(document.contract_id) ?? undefined
      };

      await assertWork(client, effectiveInput.workId);
      if (effectiveInput.sourceWorkId) await assertWork(client, effectiveInput.sourceWorkId);
      if (effectiveInput.sourceMaterialId) {
        await assertMaterial(client, effectiveInput.sourceMaterialId, effectiveInput.workId);
      }
      if (effectiveInput.counterpartyVendorId) await assertVendor(client, effectiveInput.counterpartyVendorId);
      if (effectiveInput.contractId) await assertContract(client, effectiveInput.contractId);

      const warnings: string[] = [];
      if (effectiveInput.transactionKind === "license" && effectiveInput.flowDirection === "out") {
        if (effectiveInput.parentLicenseConditionId) {
          await assertParentInboundCondition(
            client, effectiveInput.parentLicenseConditionId, effectiveInput.workId
          );
        } else {
          warnings.push("OUT利用許諾条件に根拠IN条件が未設定です。後から設定できますが、利用許諾料精算前に紐付けてください。");
        }
      }

      await linkDocumentContext(client, document, effectiveInput);

      const materialRightsSourceId =
        effectiveInput.transactionKind === "license" &&
        effectiveInput.flowDirection === "in" &&
        effectiveInput.sourceMaterialId
          ? await ensureMaterialRightsSource(client, documentId, effectiveInput)
          : null;

      const conditionId = input.mode === "link_existing"
        ? await linkExistingCondition(client, documentId, effectiveInput, materialRightsSourceId)
        : await createCondition(client, documentId, effectiveInput, materialRightsSourceId);

      await replaceRegionsAndLanguages(client, conditionId, effectiveInput);
      await client.query("COMMIT");

      const condition = await findAttachedCondition(this.database, documentId, conditionId);
      if (!condition) throw new Error("attached condition disappeared after commit");
      return { condition, createdMaterialRightsSourceId: materialRightsSourceId, warnings };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translate(error);
    } finally {
      client.release();
    }
  }
}

async function lockDocument(client: PoolClient, id: number) {
  const result = await client.query(
    `SELECT id,contract_id,ledger_ref_id,material_ref_id
       FROM documents WHERE id=$1 FOR UPDATE`,
    [id]
  );
  if (!result.rows[0]) throw new ConditionAttachmentError("DOCUMENT_NOT_FOUND","文書が見つかりません");
  return result.rows[0];
}

async function assertWork(client: PoolClient, id: number) {
  const r=await client.query("SELECT id FROM works WHERE id=$1 AND is_active=true",[id]);
  if (!r.rows[0]) throw new ConditionAttachmentError("WORK_NOT_FOUND","対象作品が見つかりません");
}
async function assertMaterial(client: PoolClient, id: number, workId: number) {
  const r=await client.query("SELECT id FROM work_materials WHERE id=$1 AND work_id=$2",[id,workId]);
  if (!r.rows[0]) throw new ConditionAttachmentError(
    "MATERIAL_WORK_MISMATCH","指定素材は対象作品に属していません"
  );
}
async function assertVendor(client: PoolClient, id: number) {
  const r=await client.query("SELECT id FROM vendors WHERE id=$1",[id]);
  if (!r.rows[0]) throw new ConditionAttachmentError("VENDOR_NOT_FOUND","相手方が見つかりません");
}
async function assertContract(client: PoolClient, id: number) {
  const r=await client.query("SELECT id FROM contracts WHERE id=$1",[id]);
  if (!r.rows[0]) throw new ConditionAttachmentError("CONTRACT_NOT_FOUND","契約台帳が見つかりません");
}

async function assertParentInboundCondition(client: PoolClient, id: number, workId: number) {
  const r=await client.query(
    `SELECT id FROM condition_lines
      WHERE id=$1 AND work_id=$2
        AND (flow_direction='in' OR is_inbound=true OR direction='payable')`,
    [id,workId]
  );
  if (!r.rows[0]) throw new ConditionAttachmentError(
    "PARENT_IN_CONDITION_INVALID",
    "根拠IN条件は同一対象作品のIN条件を指定してください"
  );
}

async function linkDocumentContext(
  client: PoolClient,
  document: Record<string,unknown>,
  input: ConditionAttachmentInput
) {
  const currentContractId=nullableInt(document.contract_id);
  if (input.contractId && currentContractId && currentContractId !== input.contractId) {
    throw new ConditionAttachmentError(
      "DOCUMENT_CONTRACT_CONFLICT",
      "文書には別の契約台帳が既に紐付いています"
    );
  }
  const currentWorkId=nullableInt(document.ledger_ref_id);
  if (currentWorkId && currentWorkId !== input.workId) {
    // A legacy document can contain multiple condition lines, but ledger_ref_id is
    // only a primary work hint. Keep the existing hint instead of overwriting it.
  }
  const currentMaterialId=nullableInt(document.material_ref_id);

  await client.query(
    `UPDATE documents SET
       contract_id=COALESCE(contract_id,$2),
       ledger_ref_id=COALESCE(ledger_ref_id,$3),
       material_ref_id=COALESCE(material_ref_id,$4),
       flow_direction=COALESCE(flow_direction,$5),
       updated_at=now()
     WHERE id=$1`,
    [
      Number(document.id),
      input.contractId ?? null,
      input.workId,
      currentMaterialId ?? effectiveInput.sourceMaterialId ?? null,
      input.flowDirection
    ]
  );

  if (input.contractId) {
    await ensureContractWork(client,input.contractId,input.workId,"licensed_work",input.counterpartyVendorId);
    if (input.sourceWorkId && input.sourceWorkId !== input.workId) {
      await ensureContractWork(client,input.contractId,input.sourceWorkId,"licensed_source",input.counterpartyVendorId);
    }
  }
}

async function ensureContractWork(
  client: PoolClient,
  contractId: number,
  workId: number,
  role: string,
  rightsHolderVendorId?: number
) {
  const existing=await client.query(
    `SELECT id FROM contract_works
      WHERE contract_id=$1 AND work_id=$2 AND COALESCE(role,'')=$3
      ORDER BY id LIMIT 1`,
    [contractId,workId,role]
  );
  if (existing.rows[0]) return;
  await client.query(
    `INSERT INTO contract_works(contract_id,work_id,role,rights_holder_vendor_id)
     VALUES($1,$2,$3,$4)`,
    [contractId,workId,role,rightsHolderVendorId ?? null]
  );
}

async function ensureMaterialRightsSource(
  client: PoolClient,
  documentId: number,
  input: ConditionAttachmentInput
) {
  const materialId=effectiveInput.sourceMaterialId!;
  const existing=await client.query(
    `SELECT id FROM material_rights_sources
      WHERE material_id=$1
        AND source_document_id=$2
        AND source_contract_id IS NOT DISTINCT FROM $3
      ORDER BY is_primary DESC,id
      LIMIT 1`,
    [materialId,documentId,effectiveInput.contractId ?? null]
  );
  if (existing.rows[0]) return Number(existing.rows[0].id);

  const hasPrimary=await client.query(
    "SELECT 1 FROM material_rights_sources WHERE material_id=$1 AND is_primary=true LIMIT 1",
    [materialId]
  );
  const inserted=await client.query(
    `INSERT INTO material_rights_sources(
       material_id,source_type,source_work_id,rights_holder_vendor_id,
       source_document_id,source_contract_id,source_role,is_primary,
       valid_from,valid_to
     ) VALUES($1,'legacy_document',$2,$3,$4,$5,'license_in',$6,$7::date,$8::date)
     RETURNING id`,
    [
      materialId,input.sourceWorkId ?? effectiveInput.workId,
      effectiveInput.counterpartyVendorId ?? null,documentId,effectiveInput.contractId ?? null,
      !hasPrimary.rows[0],input.termStart ?? null,input.termEnd ?? null
    ]
  );
  return Number(inserted.rows[0].id);
}

async function nextLineNo(client: PoolClient, documentId: number) {
  const r=await client.query(
    "SELECT COALESCE(MAX(line_no),0)+1 AS next_no FROM condition_lines WHERE document_id=$1",
    [documentId]
  );
  return Number(r.rows[0].next_no);
}

async function createCondition(
  client: PoolClient,
  documentId: number,
  input: ConditionAttachmentInput,
  materialRightsSourceId: number|null
) {
  const lineNo=await nextLineNo(client,documentId);
  const result=await client.query(
    `INSERT INTO condition_lines(
       capability_id,line_no,work_id,direction,payment_scheme,rights_attribution,
       currency,notes,amount_ex_tax,term_start,term_end,rate_pct,mg_amount,ag_amount,
       payment_terms,is_inbound,flow_direction,transaction_kind,source_work_id,
       source_material_id,counterparty_vendor_id,document_id,condition_name,
       calc_type,region_territory,region_language,material_rights_source_id,
       exclusivity,sublicense_allowed,royalty_base,deductible_costs,
       parent_license_condition_id,condition_kind,line_kind
     ) VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,
       NULL,$15,$16,$17,$18,$19,$20,$1,$21,$22,$23,$24,$25,$26,$27,$28,$29,
       $30,$31,$32
     ) RETURNING id`,
    [
      documentId,lineNo,effectiveInput.workId,
      effectiveInput.flowDirection==="in" ? "payable" : "receivable",
      input.paymentScheme ?? "royalty",
      effectiveInput.transactionKind==="license" ? "license_only" : null,
      input.currency ?? "JPY",input.notes ?? null,input.amountExTax ?? null,
      input.termStart ?? null,input.termEnd ?? null,input.ratePct ?? null,
      input.mgAmount ?? null,input.agAmount ?? null,effectiveInput.flowDirection==="in",
      effectiveInput.flowDirection,effectiveInput.transactionKind,input.sourceWorkId ?? null,
      effectiveInput.sourceMaterialId ?? null,effectiveInput.counterpartyVendorId ?? null,
      input.conditionName ?? "後付け条件",input.calcType ?? null,
      input.territory ?? null,(input.languages ?? []).join(", ") || null,
      materialRightsSourceId,input.exclusivity ?? null,
      input.sublicenseAllowed ?? null,input.royaltyBase ?? null,
      input.deductibleCosts ?? null,effectiveInput.parentLicenseConditionId ?? null,
      effectiveInput.transactionKind,effectiveInput.transactionKind==="license" ? "rights" : "payment"
    ]
  );
  return Number(result.rows[0].id);
}

async function linkExistingCondition(
  client: PoolClient,
  documentId: number,
  input: ConditionAttachmentInput,
  materialRightsSourceId: number|null
) {
  if (!input.existingConditionLineId) {
    throw new ConditionAttachmentError("CONDITION_ID_REQUIRED","既存条件IDが必要です");
  }
  const row=await client.query(
    `SELECT id,document_id,capability_id,work_id,source_work_id,source_material_id,
            parent_license_condition_id
       FROM condition_lines WHERE id=$1 FOR UPDATE`,
    [input.existingConditionLineId]
  );
  if (!row.rows[0]) throw new ConditionAttachmentError("CONDITION_NOT_FOUND","既存条件が見つかりません");
  const c=row.rows[0];
  if (c.document_id !== null && Number(c.document_id)!==documentId) {
    throw new ConditionAttachmentError("CONDITION_DOCUMENT_CONFLICT","既存条件は別文書に紐付いています");
  }
  if (c.capability_id !== null && Number(c.capability_id)!==documentId) {
    throw new ConditionAttachmentError("CONDITION_CAPABILITY_CONFLICT","既存条件は別の元データに紐付いています");
  }
  if (c.work_id !== null && Number(c.work_id)!==effectiveInput.workId) {
    throw new ConditionAttachmentError("CONDITION_WORK_CONFLICT","既存条件は別作品に紐付いています");
  }
  const lineNo=await nextLineNo(client,documentId);
  await client.query(
    `UPDATE condition_lines SET
       document_id=$2,capability_id=COALESCE(capability_id,$2),line_no=$3,
       work_id=COALESCE(work_id,$4),
       source_work_id=COALESCE(source_work_id,$5),
       source_material_id=COALESCE(source_material_id,$6),
       material_rights_source_id=COALESCE(material_rights_source_id,$7),
       parent_license_condition_id=COALESCE(parent_license_condition_id,$8),
       counterparty_vendor_id=COALESCE(counterparty_vendor_id,$9),
       flow_direction=COALESCE(flow_direction,$10),
       is_inbound=CASE WHEN flow_direction IS NULL THEN $11 ELSE is_inbound END,
       updated_at=now()
     WHERE id=$1`,
    [
      input.existingConditionLineId,documentId,lineNo,effectiveInput.workId,
      input.sourceWorkId ?? null,effectiveInput.sourceMaterialId ?? null,
      materialRightsSourceId,effectiveInput.parentLicenseConditionId ?? null,
      effectiveInput.counterpartyVendorId ?? null,effectiveInput.flowDirection,
      effectiveInput.flowDirection==="in"
    ]
  );
  return input.existingConditionLineId;
}

async function replaceRegionsAndLanguages(
  client: PoolClient,
  conditionId: number,
  input: ConditionAttachmentInput
) {
  if (input.territory !== undefined) {
    await client.query("DELETE FROM condition_line_regions WHERE condition_line_id=$1",[conditionId]);
    if (input.territory.trim()) {
      await client.query(
        "INSERT INTO condition_line_regions(condition_line_id,country_name,sort_order) VALUES($1,$2,0)",
        [conditionId,input.territory.trim()]
      );
    }
  }
  if (input.languages !== undefined) {
    await client.query("DELETE FROM condition_line_languages WHERE condition_line_id=$1",[conditionId]);
    for (let i=0;i<input.languages.length;i+=1) {
      const language=input.languages[i].trim();
      if (!language) continue;
      await client.query(
        "INSERT INTO condition_line_languages(condition_line_id,language_name,sort_order) VALUES($1,$2,$3)",
        [conditionId,language,i]
      );
    }
  }
}

async function listAttached(
  db: Pick<DatabasePool,"query">,
  documentId: number
): Promise<AttachedCondition[]> {
  const r=await db.query(
    `SELECT cl.id,cl.line_no,cl.condition_name,cl.work_id,w.title AS work_title,
            cl.source_work_id,sw.title AS source_work_title,
            cl.source_material_id,wm.material_name AS source_material_name,
            cl.flow_direction,cl.direction,cl.transaction_kind,cl.payment_scheme,
            cl.rate_pct,cl.currency,cl.parent_license_condition_id
       FROM condition_lines cl
       LEFT JOIN works w ON w.id=cl.work_id
       LEFT JOIN works sw ON sw.id=cl.source_work_id
       LEFT JOIN work_materials wm ON wm.id=cl.source_material_id
      WHERE cl.document_id=$1
      ORDER BY cl.line_no,cl.id`,
    [documentId]
  );
  return r.rows.map(mapAttached);
}

async function findAttachedCondition(
  db: Pick<DatabasePool,"query">,
  documentId:number,
  conditionId:number
) {
  const rows=await listAttached(db,documentId);
  return rows.find(row=>row.id===conditionId) ?? null;
}

function mapAttached(row:Record<string,unknown>):AttachedCondition {
  return {
    id:Number(row.id),lineNo:Number(row.line_no),
    conditionName:String(row.condition_name ?? ""),
    workId:nullableInt(row.work_id),workTitle:nullableString(row.work_title),
    sourceWorkId:nullableInt(row.source_work_id),sourceWorkTitle:nullableString(row.source_work_title),
    sourceMaterialId:nullableInt(row.source_material_id),
    sourceMaterialName:nullableString(row.source_material_name),
    flowDirection:nullableString(row.flow_direction),direction:nullableString(row.direction),
    transactionKind:nullableString(row.transaction_kind),
    paymentScheme:nullableString(row.payment_scheme),
    ratePct:nullableNum(row.rate_pct),currency:nullableString(row.currency),
    parentLicenseConditionId:nullableInt(row.parent_license_condition_id)
  };
}

function nullableInt(v:unknown){ return v===null||v===undefined ? null : Number(v); }
function nullableNum(v:unknown){ if(v===null||v===undefined||v==="") return null; const n=Number(v); return Number.isFinite(n)?n:null; }
function nullableString(v:unknown){ return v===null||v===undefined||v==="" ? null : String(v); }

function translate(error:unknown):Error {
  if(error instanceof ConditionAttachmentError) return error;
  const code=(error as {code?:string})?.code;
  if(code==="23505") return new ConditionAttachmentError("ATTACHMENT_CONFLICT","条件明細の紐付けが競合しました。再読込してください");
  if(code==="23503") return new ConditionAttachmentError("ATTACHMENT_REFERENCE_INVALID","参照先データが存在しません");
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryDocumentConditionAttachmentRepository
implements DocumentConditionAttachmentRepository {
  private seq=1000;
  constructor(
    private readonly contexts=new Map<number,DocumentConditionAttachmentContext>()
  ) {}
  async context(documentId:number){ return this.contexts.get(documentId) ?? null; }
  async attach(documentId:number,input:ConditionAttachmentInput) {
    const context=this.contexts.get(documentId);
    if(!context) throw new ConditionAttachmentError("DOCUMENT_NOT_FOUND","文書が見つかりません");
    const id=input.mode==="link_existing" && input.existingConditionLineId
      ? input.existingConditionLineId : ++this.seq;
    const condition:AttachedCondition={
      id,lineNo:context.conditions.length+1,conditionName:input.conditionName ?? "後付け条件",
      workId:effectiveInput.workId,workTitle:null,sourceWorkId:input.sourceWorkId ?? null,
      sourceWorkTitle:null,sourceMaterialId:effectiveInput.sourceMaterialId ?? null,
      sourceMaterialName:null,flowDirection:effectiveInput.flowDirection,
      direction:effectiveInput.flowDirection==="in"?"payable":"receivable",
      transactionKind:effectiveInput.transactionKind,paymentScheme:input.paymentScheme ?? null,
      ratePct:input.ratePct ?? null,currency:input.currency ?? "JPY",
      parentLicenseConditionId:effectiveInput.parentLicenseConditionId ?? null
    };
    context.conditions.push(condition);
    return {condition,createdMaterialRightsSourceId:null,warnings:[]};
  }
}
