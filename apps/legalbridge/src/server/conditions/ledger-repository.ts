// 条件台帳（condition_ledger・2026-09-04）— 永続化。
//
// 「条件明細を正にする」新フローの保存先。台帳の入れ物は documents 行
// （template_type='condition_ledger'・番号 CT-YYYY-NNNNN・印刷しない台帳レコード）で、
// condition_lines.document_id はこの行を指す。契約ヘッダ（contracts）は補助的に作り
// documents.contract_id で結ぶ（作れなくても台帳は成立させる＝SAVEPOINT で隔離）。
//
// 状態（下書き／確定）は form_data.ledger_status に持つ。documents.lifecycle_status は
// void/reissue の語彙（voided/reissued/superseded）を持つ列でありCHECK・grantの都合で触らない。
// 下書きの条件明細は計算書の下地にしない（conditions/economics 側で ledger_status を見る）。
//
// 文書との紐づけは対象文書の form_data.condition_ledger_id / condition_ledger_number
// （＋作品があれば work_code）をマージ追記するだけ。条件明細は台帳側に留まり、
// 文書確定時に作り直さない＝二重にならない。
//
// 権限: documents INSERT／UPDATE(form_data, vendor_id, updated_at)、contracts・contract_works
// INSERT（007）、document_sequences（066）。既存 grant の範囲だけを使う。

import type { ConditionLedgerPayload, LedgerStatus } from "../../condition-ledger.js";

export interface LedgerClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  release(): void;
}
export interface LedgerDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  connect(): Promise<LedgerClient>;
}

export interface LedgerSummary {
  id: number;
  documentNumber: string;
  contractId: number | null;
  title: string;
  vendorId: number | null;
  vendorName: string;
  workId: number | null;
  workCode: string | null;
  workTitle: string;
  kinds: string[];
  status: LedgerStatus;
  lineCount: number;
  linkedCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
}

export interface LedgerLine {
  id: number;
  lineNo: number | null;
  lineCode: string | null;
  lineKind: string;            // payment / expense / fee（075 未適用なら payment）
  taxCategory: string | null;
  direction: string | null;
  paymentScheme: string | null;
  transactionKind: string | null;
  conditionName: string | null;
  amountExTax: number | null;
  ratePct: number | null;
  mgAmount: number | null;
  agAmount: number | null;
  groupNo: number | null;
  sourceMaterialId: number | null;
  regionTerritory: string | null;
  regionLanguage: string | null;
}

export interface LinkedDocument {
  id: number;
  documentNumber: string | null;
  templateType: string | null;
  templateVersionId: number | null;
  lifecycleStatus: string | null;
  title: string | null;
}

export interface LedgerDetail extends LedgerSummary {
  payload: ConditionLedgerPayload;
  lines: LedgerLine[];
  linkedDocuments: LinkedDocument[];
}

export interface LedgerListQuery {
  status?: LedgerStatus;
  workId?: number;
  vendorId?: number;
  q?: string;
  limit?: number;
}

export class ConditionLedgerError extends Error {
  constructor(readonly code: "LEDGER_NOT_FOUND" | "DOCUMENT_NOT_FOUND" | "DOCUMENT_IS_LEDGER", message: string) {
    super(message);
    this.name = "ConditionLedgerError";
  }
}

export interface ConditionLedgerRepository {
  create(payload: ConditionLedgerPayload, createdBy: string | null): Promise<LedgerSummary>;
  update(id: number, payload: ConditionLedgerPayload): Promise<LedgerSummary>;
  find(id: number): Promise<LedgerDetail | null>;
  list(query: LedgerListQuery): Promise<LedgerSummary[]>;
  attach(id: number, documentId: number): Promise<LinkedDocument>;
  detach(id: number, documentId: number): Promise<boolean>;
}

export const LEDGER_TEMPLATE_TYPE = "condition_ledger";

const str = (v: unknown): string | null => (v == null || String(v).trim() === "" ? null : String(v));
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);

/** 台帳の form_data（payload ＋ 一覧・同期・検索が読む既存キー）。 */
export function buildLedgerFormData(payload: ConditionLedgerPayload): Record<string, unknown> {
  return {
    ...payload,
    ledger: true,
    ledger_status: payload.status,
    // 文書一覧・検索が読む表示キー
    title: payload.title || `条件明細（${payload.vendorName || "相手先未設定"}）`,
    counterparty: payload.vendorName || "",
    // 条件同期（resolveDocumentWork）と作品の文書一覧が読む作品キー
    ...(payload.workCode ? { work_code: payload.workCode } : {}),
    ...(payload.workId != null ? { work_id: String(payload.workId) } : {}),
    flow_direction: payload.kinds.includes("license_out") && !payload.kinds.includes("license_in") && !payload.kinds.includes("service") ? "out" : "in"
  };
}

function payloadFrom(formData: Record<string, unknown> | null): ConditionLedgerPayload {
  const f = formData ?? {};
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
  return {
    entry: f.entry === "work" ? "work" : "new",
    workId: num(f.workId ?? f.work_id),
    workCode: str(f.workCode ?? f.work_code),
    workTitle: String(f.workTitle ?? ""),
    vendorId: num(f.vendorId),
    vendorName: String(f.vendorName ?? f.counterparty ?? ""),
    title: String(f.title ?? ""),
    termStart: String(f.termStart ?? ""),
    termEnd: String(f.termEnd ?? ""),
    kinds: arr<string>(f.kinds).filter((k): k is ConditionLedgerPayload["kinds"][number] =>
      k === "service" || k === "license_in" || k === "license_out"),
    payments: arr(f.payments),
    expenses: arr(f.expenses),
    fees: arr(f.fees),
    licenseIn: arr(f.licenseIn),
    licenseOut: arr(f.licenseOut),
    status: f.ledger_status === "final" || f.status === "final" ? "final" : "draft",
    notes: String(f.notes ?? "")
  };
}

function contractTypeFor(payload: ConditionLedgerPayload): string {
  if (payload.kinds.includes("service")) return "service_agreement";
  return payload.kinds.includes("license_out") ? "license_out" : "license_individual";
}

const SUMMARY_SELECT = `
  d.id, d.document_number, d.contract_id, d.form_data, d.created_at, d.updated_at, d.created_by,
  d.vendor_id, COALESCE(v.vendor_name, d.form_data->>'vendorName', '') AS vendor_name,
  w.title AS work_title,
  (SELECT COUNT(*) FROM condition_lines cl WHERE cl.document_id = d.id) AS line_count,
  (SELECT COUNT(*) FROM documents x WHERE x.form_data->>'condition_ledger_id' = d.id::text
      AND (x.lifecycle_status IS NULL OR x.lifecycle_status <> 'voided')) AS linked_count`;
const SUMMARY_FROM = `
  FROM documents d
  LEFT JOIN vendors v ON v.id = d.vendor_id
  LEFT JOIN works w ON w.work_code = d.form_data->>'work_code'`;

function mapSummary(row: Record<string, unknown>): LedgerSummary {
  const f = (row.form_data ?? {}) as Record<string, unknown>;
  const payload = payloadFrom(f);
  return {
    id: Number(row.id),
    documentNumber: String(row.document_number ?? ""),
    contractId: num(row.contract_id),
    title: payload.title,
    vendorId: num(row.vendor_id) ?? payload.vendorId,
    vendorName: String(row.vendor_name ?? payload.vendorName ?? ""),
    workId: payload.workId,
    workCode: payload.workCode,
    workTitle: String(row.work_title ?? payload.workTitle ?? ""),
    kinds: payload.kinds,
    status: payload.status,
    lineCount: num(row.line_count) ?? 0,
    linkedCount: num(row.linked_count) ?? 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    createdBy: str(row.created_by)
  };
}

export class PgConditionLedgerRepository implements ConditionLedgerRepository {
  constructor(private readonly database: LedgerDatabase) {}

  async create(payload: ConditionLedgerPayload, createdBy: string | null): Promise<LedgerSummary> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const year = new Date().getFullYear();
      const seq = await client.query(
        `INSERT INTO document_sequences (kind, year, current_value) VALUES ('condition_ledger', $1, 1)
           ON CONFLICT (kind, year) DO UPDATE SET current_value = document_sequences.current_value + 1
         RETURNING current_value`,
        [year]
      );
      const documentNumber = `CT-${year}-${String(Number(seq.rows[0].current_value)).padStart(5, "0")}`;
      const contractId = await this.writeContract(client, null, documentNumber, payload);
      const formData = buildLedgerFormData(payload);
      const inserted = await client.query(
        `INSERT INTO documents (
           document_number, issue_key, template_type, form_data, drive_link, created_at, created_by,
           vendor_id, contract_id, contract_title
         ) VALUES ($1, $2, $3, $4::jsonb, '', now(), $5, $6, $7, $8)
         RETURNING id`,
        [documentNumber, `LEDGER-${documentNumber}`, LEDGER_TEMPLATE_TYPE, JSON.stringify(formData),
          createdBy, payload.vendorId, contractId, String(formData.title)]
      );
      const id = Number(inserted.rows[0].id);
      await client.query("COMMIT");
      const found = await this.summary(id);
      if (!found) throw new ConditionLedgerError("LEDGER_NOT_FOUND", "条件台帳を作成できませんでした");
      return found;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id: number, payload: ConditionLedgerPayload): Promise<LedgerSummary> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT id, document_number, contract_id FROM documents WHERE id = $1 AND template_type = $2 FOR UPDATE`,
        [id, LEDGER_TEMPLATE_TYPE]
      );
      if (!current.rows[0]) throw new ConditionLedgerError("LEDGER_NOT_FOUND", "条件台帳が見つかりません");
      const documentNumber = String(current.rows[0].document_number);
      const contractId = await this.writeContract(client, num(current.rows[0].contract_id), documentNumber, payload);
      const formData = buildLedgerFormData(payload);
      // documents の UPDATE は列レベル grant（form_data / vendor_id / updated_at）の範囲だけ。
      await client.query(
        `UPDATE documents SET form_data = $2::jsonb, vendor_id = $3, updated_at = now()
          WHERE id = $1 AND template_type = $4`,
        [id, JSON.stringify(formData), payload.vendorId, LEDGER_TEMPLATE_TYPE]
      );
      void contractId;
      await client.query("COMMIT");
      const found = await this.summary(id);
      if (!found) throw new ConditionLedgerError("LEDGER_NOT_FOUND", "条件台帳が見つかりません");
      return found;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 契約ヘッダ（contracts）＋作品リンク（contract_works）。CHECK・grant 違反で作れなくても
  // 台帳は成立させる（SAVEPOINT で隔離し null を返す）。更新は列 grant が無い環境もあるため同様。
  private async writeContract(
    client: LedgerClient, existingId: number | null, documentNumber: string, payload: ConditionLedgerPayload
  ): Promise<number | null> {
    const stage = payload.status === "final" ? "executed" : "drafting";
    const status = payload.status === "final" ? "executed" : "draft";
    const executedAt = payload.termStart || new Date().toISOString().slice(0, 10);
    await client.query("SAVEPOINT ledger_contract");
    try {
      if (existingId != null) {
        await client.query(
          `UPDATE contracts
              SET contract_title = $2, primary_vendor_id = $3, lifecycle_stage = $4, contract_status = $5,
                  effective_date = $6::date, expiration_date = $7::date, contract_type = $8
            WHERE id = $1`,
          [existingId, payload.title || documentNumber, payload.vendorId, stage, status,
            payload.termStart || null, payload.termEnd || null, contractTypeFor(payload)]
        );
        await client.query("RELEASE SAVEPOINT ledger_contract");
        return existingId;
      }
      const inserted = await client.query(
        `INSERT INTO contracts (
           document_number, contract_level, record_type, contract_category,
           contract_type, contract_title, primary_vendor_id, origin,
           lifecycle_stage, executed_at, effective_date, expiration_date,
           auto_renewal, renewal_notice_months, source_system, document_url,
           scope, contract_status
         ) VALUES (
           $1, 'individual', 'license_condition', 'license',
           $2, $3, $4, 'registered',
           $5, $6::date, $7::date, $8::date,
           false, NULL, 'legalbridge_v2_ledger', NULL,
           NULL, $9
         ) RETURNING id`,
        [documentNumber, contractTypeFor(payload), payload.title || documentNumber, payload.vendorId,
          stage, executedAt, payload.termStart || null, payload.termEnd || null, status]
      );
      const contractId = Number(inserted.rows[0].id);
      if (payload.workId != null) {
        await client.query(
          `INSERT INTO contract_works (contract_id, work_id, role, rights_holder_vendor_id)
           VALUES ($1, $2, 'licensed_work', $3)`,
          [contractId, payload.workId, payload.vendorId]
        );
      }
      await client.query("RELEASE SAVEPOINT ledger_contract");
      return contractId;
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT ledger_contract");
      return existingId;
    }
  }

  private async summary(id: number): Promise<LedgerSummary | null> {
    const result = await this.database.query(
      `SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM} WHERE d.id = $1 AND d.template_type = $2`,
      [id, LEDGER_TEMPLATE_TYPE]
    );
    return result.rows[0] ? mapSummary(result.rows[0]) : null;
  }

  async find(id: number): Promise<LedgerDetail | null> {
    const head = await this.database.query(
      `SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM} WHERE d.id = $1 AND d.template_type = $2`,
      [id, LEDGER_TEMPLATE_TYPE]
    );
    if (!head.rows[0]) return null;
    // 列名を固定しない（075 未適用でも line_kind / tax_category が無いだけで読める）。
    const [lines, linked] = await Promise.all([
      this.database.query(
        `SELECT row_to_json(cl) AS line FROM condition_lines cl WHERE cl.document_id = $1 ORDER BY cl.line_no, cl.id`,
        [id]
      ),
      this.database.query(
        `SELECT id, document_number, template_type, template_version_id, lifecycle_status, form_data->>'title' AS title
           FROM documents
          WHERE form_data->>'condition_ledger_id' = $1::text
          ORDER BY created_at DESC NULLS LAST, id DESC`,
        [String(id)]
      )
    ]);
    const summary = mapSummary(head.rows[0]);
    return {
      ...summary,
      payload: payloadFrom((head.rows[0].form_data ?? {}) as Record<string, unknown>),
      lines: lines.rows.map((r) => mapLine((r.line ?? r) as Record<string, unknown>)),
      linkedDocuments: linked.rows.map(mapLinked)
    };
  }

  async list(query: LedgerListQuery): Promise<LedgerSummary[]> {
    const where: string[] = ["d.template_type = $1", "(d.lifecycle_status IS NULL OR d.lifecycle_status <> 'voided')"];
    const params: unknown[] = [LEDGER_TEMPLATE_TYPE];
    if (query.status) { params.push(query.status); where.push(`d.form_data->>'ledger_status' = $${params.length}`); }
    if (query.workId != null) {
      params.push(String(query.workId));
      where.push(`(d.form_data->>'work_id' = $${params.length}
                   OR EXISTS (SELECT 1 FROM condition_lines cl WHERE cl.document_id = d.id AND cl.work_id = $${params.length}::int))`);
    }
    if (query.vendorId != null) { params.push(query.vendorId); where.push(`d.vendor_id = $${params.length}`); }
    if (query.q?.trim()) {
      params.push(`%${query.q.trim()}%`);
      where.push(`(d.document_number ILIKE $${params.length} OR d.form_data->>'title' ILIKE $${params.length}
                   OR COALESCE(v.vendor_name, d.form_data->>'vendorName', '') ILIKE $${params.length}
                   OR COALESCE(w.title, '') ILIKE $${params.length})`);
    }
    params.push(Math.min(Math.max(query.limit ?? 100, 1), 500));
    const result = await this.database.query(
      `SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
        WHERE ${where.join(" AND ")}
        ORDER BY d.updated_at DESC NULLS LAST, d.id DESC
        LIMIT $${params.length}`,
      params
    );
    return result.rows.map(mapSummary);
  }

  async attach(id: number, documentId: number): Promise<LinkedDocument> {
    const ledger = await this.summary(id);
    if (!ledger) throw new ConditionLedgerError("LEDGER_NOT_FOUND", "条件台帳が見つかりません");
    if (documentId === id) throw new ConditionLedgerError("DOCUMENT_IS_LEDGER", "台帳そのものには紐づけられません");
    const patch: Record<string, string> = {
      condition_ledger_id: String(id),
      condition_ledger_number: ledger.documentNumber,
      ...(ledger.workCode ? { work_code: ledger.workCode } : {})
    };
    const updated = await this.database.query(
      `UPDATE documents
          SET form_data = COALESCE(form_data, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE id = $1 AND template_type <> $3
        RETURNING id, document_number, template_type, template_version_id, lifecycle_status, form_data->>'title' AS title`,
      [documentId, JSON.stringify(patch), LEDGER_TEMPLATE_TYPE]
    );
    if (!updated.rows[0]) throw new ConditionLedgerError("DOCUMENT_NOT_FOUND", "紐づける文書が見つかりません");
    return mapLinked(updated.rows[0]);
  }

  async detach(id: number, documentId: number): Promise<boolean> {
    const updated = await this.database.query(
      `UPDATE documents
          SET form_data = COALESCE(form_data, '{}'::jsonb) - ARRAY['condition_ledger_id', 'condition_ledger_number'],
              updated_at = now()
        WHERE id = $1 AND form_data->>'condition_ledger_id' = $2::text
        RETURNING id`,
      [documentId, String(id)]
    );
    return updated.rows.length > 0;
  }
}

function mapLine(r: Record<string, unknown>): LedgerLine {
  return {
    id: Number(r.id),
    lineNo: num(r.line_no),
    lineCode: str(r.line_code),
    lineKind: str(r.line_kind) ?? "payment",
    taxCategory: str(r.tax_category),
    direction: str(r.direction),
    paymentScheme: str(r.payment_scheme),
    transactionKind: str(r.transaction_kind),
    conditionName: str(r.condition_name),
    amountExTax: num(r.amount_ex_tax),
    ratePct: num(r.rate_pct),
    mgAmount: num(r.mg_amount),
    agAmount: num(r.ag_amount),
    groupNo: num(r.group_no),
    sourceMaterialId: num(r.source_material_id),
    regionTerritory: str(r.region_territory),
    regionLanguage: str(r.region_language)
  };
}

function mapLinked(r: Record<string, unknown>): LinkedDocument {
  return {
    id: Number(r.id),
    documentNumber: str(r.document_number),
    templateType: str(r.template_type),
    templateVersionId: num(r.template_version_id),
    lifecycleStatus: str(r.lifecycle_status),
    title: str(r.title)
  };
}

// テスト・DB非依存起動用。
export class MemoryConditionLedgerRepository implements ConditionLedgerRepository {
  constructor(readonly strictDocuments = true) {}
  private seq = 0;
  readonly ledgers = new Map<number, { summary: LedgerSummary; payload: ConditionLedgerPayload }>();
  readonly links = new Map<number, number>();   // documentId → ledgerId
  readonly documents = new Map<number, LinkedDocument>();

  async create(payload: ConditionLedgerPayload, createdBy: string | null): Promise<LedgerSummary> {
    const id = ++this.seq;
    const summary: LedgerSummary = {
      id, documentNumber: `CT-2026-${String(id).padStart(5, "0")}`, contractId: null,
      title: payload.title, vendorId: payload.vendorId, vendorName: payload.vendorName,
      workId: payload.workId, workCode: payload.workCode, workTitle: payload.workTitle,
      kinds: payload.kinds, status: payload.status, lineCount: 0, linkedCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy
    };
    this.ledgers.set(id, { summary, payload });
    return summary;
  }
  async update(id: number, payload: ConditionLedgerPayload): Promise<LedgerSummary> {
    const current = this.ledgers.get(id);
    if (!current) throw new ConditionLedgerError("LEDGER_NOT_FOUND", "条件台帳が見つかりません");
    const summary: LedgerSummary = {
      ...current.summary, title: payload.title, vendorId: payload.vendorId, vendorName: payload.vendorName,
      workId: payload.workId, workCode: payload.workCode, workTitle: payload.workTitle,
      kinds: payload.kinds, status: payload.status, updatedAt: new Date().toISOString()
    };
    this.ledgers.set(id, { summary, payload });
    return summary;
  }
  async find(id: number): Promise<LedgerDetail | null> {
    const current = this.ledgers.get(id);
    if (!current) return null;
    const linkedDocuments = [...this.links.entries()].filter(([, l]) => l === id)
      .map(([docId]) => this.documents.get(docId)).filter((d): d is LinkedDocument => !!d);
    return { ...current.summary, linkedCount: linkedDocuments.length, payload: current.payload, lines: [], linkedDocuments };
  }
  async list(query: LedgerListQuery): Promise<LedgerSummary[]> {
    return [...this.ledgers.values()].map((l) => l.summary)
      .filter((s) => !query.status || s.status === query.status)
      .filter((s) => query.workId == null || s.workId === query.workId)
      .filter((s) => query.vendorId == null || s.vendorId === query.vendorId)
      .filter((s) => !query.q || `${s.documentNumber} ${s.title} ${s.vendorName}`.includes(query.q))
      .slice(0, query.limit ?? 100);
  }
  async attach(id: number, documentId: number): Promise<LinkedDocument> {
    if (!this.ledgers.has(id)) throw new ConditionLedgerError("LEDGER_NOT_FOUND", "条件台帳が見つかりません");
    if (documentId === id) throw new ConditionLedgerError("DOCUMENT_IS_LEDGER", "台帳そのものには紐づけられません");
    // 既知の文書（documents に登録済み）以外は未知＝404。ただし strictDocuments=false なら
    // 確定直後の文書（別リポジトリが持つ）も受け入れる（確定フローのテスト用）。
    const doc = this.documents.get(documentId);
    if (!doc && this.strictDocuments) throw new ConditionLedgerError("DOCUMENT_NOT_FOUND", "紐づける文書が見つかりません");
    const linked = doc ?? { id: documentId, documentNumber: null, templateType: null, templateVersionId: null, lifecycleStatus: null, title: null };
    this.documents.set(documentId, linked);
    this.links.set(documentId, id);
    return linked;
  }
  async detach(id: number, documentId: number): Promise<boolean> {
    if (this.links.get(documentId) !== id) return false;
    this.links.delete(documentId);
    return true;
  }
}
