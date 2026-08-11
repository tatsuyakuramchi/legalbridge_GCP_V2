import type { PoolClient } from "pg";
import type { DocumentDraft, DocumentFormData } from "../../types.js";
import type { DatabasePool } from "../db/pool.js";
import {
  PARTY_NAME_KEYS, TITLE_KEYS, firstTextValue, deriveRecordType, resolveVendorIdByName
} from "./document-business-columns.js";

export interface FinalizeDocumentInput {
  issueKey: string;
  templateType: string;
  templateVersionId: number;
  formData: DocumentFormData;
  createdBy?: string | null;
  expectedDraftUpdatedAt: string;
}

export interface FinalizedDocument {
  id: number;
  documentNumber: string;
  issueKey: string;
  templateType: string;
  templateVersionId: number;
  createdAt: string;
  createdBy: string | null;
}

export interface DocumentFinalizationRepository {
  finalize(input: FinalizeDocumentInput, draft: DocumentDraft): Promise<FinalizedDocument>;
}

export class PgDocumentFinalizationRepository implements DocumentFinalizationRepository {
  constructor(private readonly database: DatabasePool) {}

  async finalize(input: FinalizeDocumentInput, draft: DocumentDraft) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await lockCurrentDraft(client, input, draft.id);
      const prefix = await findPrefix(client, input.templateType);
      const year = currentYearInTokyo();
      const sequence = await nextSequence(client, prefix, year);
      const documentNumber = formatDocumentNumber(prefix, year, sequence);

      // 業務列も V1 同等に刻む（監査 P0-3/P0-4）：contract_status は V1 既定の 'executed'
      // （発行済み＝有効。CloudSign 送信フロー導入時に 'awaiting_signature' を追加予定）。
      // vendor_id は form_data の相手先名から解決（できなければ NULL のまま・作成は止めない）。
      const contractTitle = firstTextValue(input.formData, TITLE_KEYS);
      const vendorId = await resolveVendorIdByName(
        client, firstTextValue(input.formData, PARTY_NAME_KEYS)
      );

      // 案件への自動紐付け（監査指摘：確定文書が全件 案件から孤児になっていた）。
      // 受付番号を代表課題キーに持つ案件があれば matter_id を設定する（無ければ NULL＝従来どおり）。
      const inserted = await client.query(
        `INSERT INTO documents (
           document_number, issue_key, template_type, template_version_id,
           form_data, drive_link, created_at, created_by,
           record_type, contract_status, contract_title, vendor_id, matter_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, '', now(), $6, $7, 'executed', $8, $9,
           (SELECT id FROM matters WHERE primary_issue_key = $2 ORDER BY id DESC LIMIT 1))
         RETURNING id, document_number, issue_key, template_type,
                   template_version_id, created_at, created_by`,
        [
          documentNumber,
          input.issueKey,
          input.templateType,
          input.templateVersionId,
          JSON.stringify(input.formData),
          input.createdBy ?? null,
          deriveRecordType(input.templateType),
          contractTitle,
          vendorId
        ]
      );

      const removed = await client.query(
        `DELETE FROM document_drafts
          WHERE id = $1
            AND issue_key = $2
            AND template_type = $3`,
        [draft.id, input.issueKey, input.templateType]
      );
      if (removed.rowCount !== 1) {
        throw new DocumentFinalizationConflictError();
      }

      await client.query("COMMIT");
      return mapFinalizedDocument(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockCurrentDraft(
  client: PoolClient,
  input: FinalizeDocumentInput,
  draftId: number
) {
  const result = await client.query(
    `SELECT updated_at
       FROM document_drafts
      WHERE id = $1
        AND issue_key = $2
        AND template_type = $3
      FOR UPDATE`,
    [draftId, input.issueKey, input.templateType]
  );
  const currentUpdatedAt = result.rows[0]?.updated_at;
  if (
    !currentUpdatedAt ||
    new Date(currentUpdatedAt).toISOString() !== input.expectedDraftUpdatedAt
  ) {
    throw new DocumentFinalizationConflictError();
  }
}

export function currentYearInTokyo() {
  return Number(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Tokyo",
    year: "numeric"
  }).format(new Date()));
}

// 採番プレフィックスの正規化（純関数）。設定値優先→種別既定→検証。ARC- 接頭辞は基底に戻す。
// numbering/next プレビュー（10-6）と finalize の findPrefix で共用する。
export function resolveNumberPrefix(
  configured: string | null | undefined,
  templateType: string
): string | null {
  const c = String(configured ?? "").trim().toUpperCase();
  const prefix = c || DOCUMENT_PREFIXES[templateType];
  if (!prefix || !/^[A-Z0-9-]{1,20}$/.test(prefix)) return null;
  return prefix.startsWith("ARC-") ? prefix.slice(4) : prefix;
}

// 文書番号の組み立て（純関数）。ARC-<prefix>-<year>-<0001> 形式。
export function formatDocumentNumber(basePrefix: string, year: number, sequence: number): string {
  const numberPrefix = basePrefix.startsWith("ARC-") ? basePrefix : `ARC-${basePrefix}`;
  return `${numberPrefix}-${year}-${String(sequence).padStart(4, "0")}`;
}

export const DOCUMENT_PREFIXES: Record<string, string> = {
  purchase_order: "PO",
  intl_purchase_order: "IPO",
  inspection_certificate: "INS",
  license_master: "LIC",
  individual_license_terms: "ILT",
  individual_license_terms_v3: "ILT",
  royalty_statement: "ROY",
  service_master: "SVC",
  pub_master_individual: "PUB",
  pub_master_corporate: "PUB",
  pub_license_terms: "PUBT",
  pub_additional_terms: "PUBA",
  sales_master_buyer: "SAL",
  sales_master_credit: "SAL",
  sales_master_standard: "SAL",
  maintenance_spec: "MNT",
  legal_response: "LG",
  notice_consent_personal_info_freelance: "PR",
  nda: "NDA"
};

async function findPrefix(client: PoolClient, templateType: string) {
  const result = await client.query(
    `SELECT document_prefix
       FROM document_templates
      WHERE template_key = $1
        AND is_active = true
      FOR SHARE`,
    [templateType]
  );
  if (!result.rows[0]) throw new Error("active template is required");
  const prefix = resolveNumberPrefix(result.rows[0].document_prefix, templateType);
  if (!prefix) throw new Error("document prefix mapping is required");
  return prefix;
}

async function nextSequence(client: PoolClient, kind: string, year: number) {
  const result = await client.query(
    `INSERT INTO document_sequences (kind, year, current_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (kind, year) DO UPDATE
       SET current_value = document_sequences.current_value + 1
     RETURNING current_value`,
    [kind, year]
  );
  return Number(result.rows[0].current_value);
}

function mapFinalizedDocument(row: Record<string, unknown>): FinalizedDocument {
  return {
    id: Number(row.id),
    documentNumber: String(row.document_number),
    issueKey: String(row.issue_key),
    templateType: String(row.template_type),
    templateVersionId: Number(row.template_version_id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: row.created_by ? String(row.created_by) : null
  };
}

export class MemoryDocumentFinalizationRepository implements DocumentFinalizationRepository {
  private sequence = 1;
  readonly documents: FinalizedDocument[] = [];

  async finalize(input: FinalizeDocumentInput, draft: DocumentDraft) {
    if (draft.updatedAt !== input.expectedDraftUpdatedAt) {
      throw new DocumentFinalizationConflictError();
    }
    const value: FinalizedDocument = {
      id: this.sequence,
      documentNumber: `ARC-TEST-${new Date().getUTCFullYear()}-${String(this.sequence).padStart(4, "0")}`,
      issueKey: input.issueKey,
      templateType: input.templateType,
      templateVersionId: input.templateVersionId,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? null
    };
    this.sequence += 1;
    this.documents.push(value);
    return value;
  }
}

export class DocumentFinalizationConflictError extends Error {
  constructor() {
    super("draft changed before finalization");
  }
}
