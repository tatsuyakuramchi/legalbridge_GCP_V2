import type { DatabasePool } from "../db/pool.js";
import type { FormContextSources } from "./form-mapper.js";

export interface DocumentFormContextRepository {
  findSources(issueKey: string): Promise<FormContextSources>;
}

export class PgDocumentFormContextRepository implements DocumentFormContextRepository {
  constructor(private readonly database: DatabasePool) {}

  async findSources(issueKey: string) {
    const requestResult = await this.database.query(
      `SELECT id, backlog_issue_key, summary, contract_type, counterparty, deadline, notes
         FROM legal_requests
        WHERE backlog_issue_key = $1
        LIMIT 1`,
      [issueKey]
    );
    const request = requestResult.rows[0] ?? null;
    const matterResult = await this.database.query(
      `SELECT m.*, s.staff_name, s.email AS staff_email, s.department AS staff_department,
              s.phone AS staff_phone
         FROM matters m
         LEFT JOIN staff s ON s.id = m.owner_staff_id
        WHERE m.primary_issue_key = $1
           OR m.id IN (SELECT matter_id FROM matter_issues WHERE backlog_issue_key = $1)
        ORDER BY (m.primary_issue_key = $1) DESC, m.updated_at DESC NULLS LAST
        LIMIT 1`,
      [issueKey]
    );
    const matter = matterResult.rows[0] ?? null;
    const counterparty = String(request?.counterparty ?? matter?.counterparty ?? "").trim();
    const matterId = matter?.id ? Number(matter.id) : null;

    const [vendorResult, documentResult, workResult] = await Promise.all([
      counterparty ? this.database.query(
        `SELECT id, vendor_code, vendor_name, trade_name, pen_name, vendor_suffix,
                entity_type, address, phone, email, contact_department, contact_name,
                vendor_rep, bank_info, bank_name, branch_name, account_type,
                account_number, account_holder_kana, is_invoice_issuer,
                invoice_registration_number, withholding_enabled
           FROM vendors
          WHERE lower(vendor_name) = lower($1)
             OR lower(COALESCE(trade_name, '')) = lower($1)
          ORDER BY (lower(vendor_name) = lower($1)) DESC, id
          LIMIT 1`,
        [counterparty]
      ) : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      this.database.query(
        `SELECT id, document_number, template_type, issue_key, vendor_name_snapshot,
                created_at, form_data
           FROM documents
          WHERE issue_key = $1
             OR backlog_issue_key = $1
             OR ($2::bigint IS NOT NULL AND matter_id = $2)
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 1`,
        [issueKey, matterId]
      ),
      this.database.query(
        `SELECT w.id, w.work_code AS code, w.title, w.work_type AS category, w.remarks
           FROM works w
          WHERE w.id IN (
            SELECT cl.work_id
              FROM documents d
              JOIN condition_lines cl ON cl.document_id = d.id
             WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1
                    OR ($2::bigint IS NOT NULL AND d.matter_id = $2))
               AND cl.work_id IS NOT NULL
            UNION
            SELECT cw.work_id
              FROM documents d
              JOIN contract_works cw ON cw.contract_id = d.contract_id
             WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1
                    OR ($2::bigint IS NOT NULL AND d.matter_id = $2))
          )
          ORDER BY w.id
          LIMIT 1`,
        [issueKey, matterId]
      )
    ]);
    const vendor = vendorResult.rows[0] ?? null;
    const document = documentResult.rows[0] ?? null;
    const work = workResult.rows[0] ?? null;
    const parsedNotes = parseRequestNotes(request?.notes);

    return {
      backlog: request ? {
        issueKey: request.backlog_issue_key,
        summary: request.summary,
        contract_type: request.contract_type,
        counterparty: request.counterparty,
        deadline: dateOnly(request.deadline),
        details: parsedNotes.details,
        ...parsedNotes.raw
      } : { issueKey },
      matter: matter ? {
        id: matter.id,
        matter_code: matter.matter_code,
        title: matter.title,
        status: matter.status,
        lifecycle_stage: matter.lifecycle_stage,
        counterparty: matter.counterparty,
        target_due_date: dateOnly(matter.target_due_date),
        remarks: matter.remarks
      } : undefined,
      vendor: vendor ?? undefined,
      staff: matter ? {
        staff_name: matter.staff_name,
        email: matter.staff_email,
        department: matter.staff_department,
        phone: matter.staff_phone
      } : undefined,
      document: document ? {
        id: document.id,
        document_number: document.document_number,
        template_type: document.template_type,
        issue_key: document.issue_key,
        vendor_name: document.vendor_name_snapshot,
        created_at: document.created_at,
        ...(document.form_data ?? {})
      } : undefined,
      work: work ?? undefined,
      company: companyProfile()
    };
  }
}

export class MemoryDocumentFormContextRepository implements DocumentFormContextRepository {
  constructor(private readonly sources: FormContextSources = {}) {}
  async findSources(issueKey: string) {
    return { ...this.sources, backlog: { issueKey, ...(this.sources.backlog ?? {}) } };
  }
}

function parseRequestNotes(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return { details: "", raw: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      return { details: typeof raw.details === "string" ? raw.details : "", raw };
    }
  } catch {
    // Legacy notes are plain text.
  }
  return { details: text, raw: {} };
}

function dateOnly(value: unknown) {
  return value ? String(value).slice(0, 10) : null;
}

function companyProfile() {
  return {
    name: "株式会社アークライト",
    address: "東京都千代田区神田小川町1-2 風雲堂ビル2階",
    rep: "代表取締役　青柳 昌行"
  };
}
