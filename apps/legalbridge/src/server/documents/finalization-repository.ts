import type { PoolClient } from "pg";
import type { DocumentDraft, DocumentFormData } from "../../types.js";
import type { DatabasePool } from "../db/pool.js";

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
      const numberPrefix = prefix.startsWith("ARC-") ? prefix : `ARC-${prefix}`;
      const documentNumber = `${numberPrefix}-${year}-${String(sequence).padStart(4, "0")}`;

      const inserted = await client.query(
        `INSERT INTO documents (
           document_number, issue_key, template_type, template_version_id,
           form_data, drive_link, created_at, created_by
         ) VALUES ($1, $2, $3, $4, $5::jsonb, '', now(), $6)
         RETURNING id, document_number, issue_key, template_type,
                   template_version_id, created_at, created_by`,
        [
          documentNumber,
          input.issueKey,
          input.templateType,
          input.templateVersionId,
          JSON.stringify(input.formData),
          input.createdBy ?? null
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

function currentYearInTokyo() {
  return Number(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Tokyo",
    year: "numeric"
  }).format(new Date()));
}

const DOCUMENT_PREFIXES: Record<string, string> = {
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
  const configured = String(result.rows[0].document_prefix ?? "").trim().toUpperCase();
  const prefix = configured || DOCUMENT_PREFIXES[templateType];
  if (!prefix || !/^[A-Z0-9-]{1,20}$/.test(prefix)) {
    throw new Error("document prefix mapping is required");
  }
  return prefix.startsWith("ARC-") ? prefix.slice(4) : prefix;
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
