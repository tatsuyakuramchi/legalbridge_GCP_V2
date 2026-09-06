import type { DatabasePool } from "../db/pool.js";
import { MatterWriteError } from "./write-repository.js";

// 案件画面からの納品実績（delivery_events）と支払（payments）の登録（2026-09-06）。
// 業務委託フロー（基本契約→発注→納品・報告→検収→支払）の③と⑤を、文書を作らずに
// 実績として記録できるようにする。どちらも案件と Backlog 課題キー（backlog_issue_key）で結ぶ
// （案件詳細の deliveryEvents / payments はこのキーで読んでいる）。
//
// delivery_events は V1 由来の表で列構成が環境により異なり得るため、information_schema で
// 実列を確認して「ある列だけ」に書く（無い列はスキップ・NOT NULL で埋められない列があれば
// 422 で列名を返す＝077 の preflight で確認できる）。payments は receipt-repository と同じ列を使う。

export type DeliveryStatus = "delivered" | "inspected" | "completed" | "cancelled";
export const DELIVERY_STATUSES: DeliveryStatus[] = ["delivered", "inspected", "completed", "cancelled"];
export type PaymentStatus = "planned" | "approved" | "paid";
export const PAYMENT_STATUSES: PaymentStatus[] = ["planned", "approved", "paid"];

export interface DeliveryCreateInput {
  backlogIssueKey?: string | null;
  deliveredOn?: string | null;          // 納品日（YYYY-MM-DD）
  deliveredAmount?: number | null;      // 納品額（税抜）
  inspectionDeadline?: string | null;   // 検収期限（YYYY-MM-DD）
  status?: DeliveryStatus;
  documentNumber?: string | null;       // 対象の発注書番号など
  note?: string | null;
}
export interface DeliveryPatchInput {
  status?: DeliveryStatus;
  inspectionDeadline?: string | null;
}
export interface PaymentCreateInput {
  backlogIssueKey?: string | null;
  amountExTax: number;
  totalAmount?: number | null;          // 税込。省略時は税抜と同額（V1 の payments 同期と同じ）
  currency?: string;
  dueDate?: string | null;
  paidDate?: string | null;
  status?: PaymentStatus;
  sourceDocumentNumber?: string | null; // 検収書・発注書などの文書番号
  counterpartyVendorId?: number | null;
  paymentKind?: string;                 // 既定 service_fee（業務委託報酬）
  note?: string | null;
}
export interface PaymentPatchInput {
  status?: PaymentStatus;
  paidDate?: string | null;
  dueDate?: string | null;
}

export interface DeliveryRecord {
  id: number;
  matterId: number;
  backlogIssueKey: string;
  status: string;
  deliveredAmount: number | null;
  inspectionDeadline: string | null;
}
export interface PaymentRecord {
  id: number;
  matterId: number;
  backlogIssueKey: string;
  status: string;
  amountExTax: number;
  totalAmount: number;
  currency: string;
  dueDate: string | null;
  paidDate: string | null;
}

export interface MatterDeliveryPaymentRepository {
  createDelivery(matterId: number, input: DeliveryCreateInput, actor: string): Promise<DeliveryRecord>;
  updateDelivery(matterId: number, deliveryId: number, patch: DeliveryPatchInput): Promise<DeliveryRecord>;
  createPayment(matterId: number, input: PaymentCreateInput, actor: string): Promise<PaymentRecord>;
  updatePayment(matterId: number, paymentId: number, patch: PaymentPatchInput): Promise<PaymentRecord>;
}

type ColumnInfo = { name: string; nullable: boolean; hasDefault: boolean };
type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }> };

// 実列に合わせて INSERT を組む。canonical → 候補列名（先に見つかった列を使う）。
function buildInsert(
  table: string, columns: ColumnInfo[],
  values: Record<string, unknown>, aliases: Record<string, string[]>,
  unsupportedCode: string
) {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const cols: string[] = [];
  const params: unknown[] = [];
  for (const [canonical, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const candidates = aliases[canonical] ?? [canonical];
    const column = candidates.find((name) => byName.has(name));
    if (!column) continue;
    cols.push(column); params.push(value);
  }
  const missing = columns
    .filter((c) => !c.nullable && !c.hasDefault && !cols.includes(c.name))
    .map((c) => c.name);
  if (missing.length) {
    throw new MatterWriteError(unsupportedCode,
      `${table} の必須列 ${missing.join(", ")} に値を入れられません（infra/gcp/sql/077 の列一覧で確認してください）`);
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  return { text: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`, params };
}

function dateOnly(value: unknown): string | null { return value ? String(value).slice(0, 10) : null; }
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function periodOf(date: string | null | undefined): string {
  const base = date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null;
  if (base) return base;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" })
    .format(new Date()).slice(0, 7);
}

export class PgMatterDeliveryPaymentRepository implements MatterDeliveryPaymentRepository {
  private readonly columnCache = new Map<string, ColumnInfo[]>();
  constructor(private readonly database: DatabasePool) {}

  private async columns(table: string): Promise<ColumnInfo[]> {
    const cached = this.columnCache.get(table);
    if (cached) return cached;
    const result = await this.database.query(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`, [table]);
    const info = result.rows.map((row) => ({
      name: String(row.column_name),
      nullable: String(row.is_nullable) === "YES",
      hasDefault: row.column_default !== null && row.column_default !== undefined
    }));
    if (!info.length) throw new MatterWriteError("DELIVERY_SCHEMA_UNSUPPORTED", `表 ${table} が見つかりません`);
    this.columnCache.set(table, info);
    return info;
  }

  // 案件に紐づく課題キー（代表＋関連）。要求されたキーが案件のものでなければ拒む。
  private async resolveIssueKey(client: Queryable, matterId: number, requested?: string | null) {
    const matter = await client.query(`SELECT primary_issue_key FROM matters WHERE id = $1`, [matterId]);
    if (!matter.rows[0]) throw new MatterWriteError("MATTER_NOT_FOUND", "案件が見つかりません");
    const linked = await client.query(
      `SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1 ORDER BY id`, [matterId]);
    const keys = [matter.rows[0].primary_issue_key, ...linked.rows.map((r) => r.backlog_issue_key)]
      .map((k) => String(k ?? "").trim()).filter(Boolean);
    const wanted = String(requested ?? "").trim();
    if (wanted) {
      if (!keys.includes(wanted)) {
        throw new MatterWriteError("MATTER_REFERENCE_INVALID", `課題キー ${wanted} はこの案件に紐づいていません`);
      }
      return { key: wanted, keys };
    }
    if (!keys.length) {
      throw new MatterWriteError("MATTER_ISSUE_REQUIRED",
        "この案件には Backlog 課題キーが無いため納品・支払を結び付けられません。案件の代表依頼（課題キー）を設定してください");
    }
    return { key: keys[0], keys };
  }

  async createDelivery(matterId: number, input: DeliveryCreateInput, actor: string) {
    const { key } = await this.resolveIssueKey(this.database, matterId, input.backlogIssueKey);
    const columns = await this.columns("delivery_events");
    const insert = buildInsert("delivery_events", columns, {
      backlog_issue_key: key,
      status: input.status ?? "delivered",
      delivered_amount: input.deliveredAmount ?? null,
      inspection_deadline: input.inspectionDeadline ?? null,
      delivered_on: input.deliveredOn ?? null,
      document_number: input.documentNumber ?? null,
      note: input.note ?? null,
      created_by: actor
    }, {
      delivered_on: ["delivered_on", "delivered_at", "delivery_date", "delivered_date"],
      document_number: ["source_document_number", "document_number", "target_doc_number", "purchase_order_number"],
      note: ["note", "notes", "remarks", "memo", "description"],
      created_by: ["created_by", "registered_by"]
    }, "DELIVERY_SCHEMA_UNSUPPORTED");
    try {
      const result = await this.database.query(insert.text, insert.params);
      return mapDelivery(matterId, result.rows[0]);
    } catch (error) {
      throw translate(error, "DELIVERY_GRANT_MISSING", "納品実績の書込権限が未付与です（infra/gcp/sql/078 を適用してください）");
    }
  }

  async updateDelivery(matterId: number, deliveryId: number, patch: DeliveryPatchInput) {
    const { keys } = await this.resolveIssueKey(this.database, matterId);
    const sets: string[] = []; const params: unknown[] = [deliveryId, keys];
    if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`); }
    if (patch.inspectionDeadline !== undefined) { params.push(patch.inspectionDeadline); sets.push(`inspection_deadline = $${params.length}`); }
    if (!sets.length) throw new MatterWriteError("MATTER_CHECK_FAILED", "変更内容がありません");
    try {
      const result = await this.database.query(
        `UPDATE delivery_events SET ${sets.join(", ")}
          WHERE id = $1 AND backlog_issue_key = ANY($2::text[]) RETURNING *`, params);
      if (!result.rows[0]) throw new MatterWriteError("MATTER_TASK_NOT_FOUND", "納品実績が見つかりません");
      return mapDelivery(matterId, result.rows[0]);
    } catch (error) {
      throw translate(error, "DELIVERY_GRANT_MISSING", "納品実績の更新権限が未付与です（infra/gcp/sql/078 を適用してください）");
    }
  }

  async createPayment(matterId: number, input: PaymentCreateInput, actor: string) {
    const { key } = await this.resolveIssueKey(this.database, matterId, input.backlogIssueKey);
    const columns = await this.columns("payments");
    const amount = Number(input.amountExTax);
    const total = input.totalAmount ?? amount;
    const status = input.status ?? (input.paidDate ? "paid" : "planned");
    const insert = buildInsert("payments", columns, {
      payment_no: `MTR-${matterId}-${Date.now().toString(36).toUpperCase()}`,
      direction: "outbound",
      payment_kind: input.paymentKind ?? "service_fee",
      counterparty_vendor_id: input.counterpartyVendorId ?? null,
      period: periodOf(input.dueDate ?? input.paidDate),
      amount_ex_tax: amount,
      total_amount: total,
      currency: (input.currency ?? "JPY").toUpperCase(),
      status,
      due_date: input.dueDate ?? null,
      paid_date: input.paidDate ?? null,
      source_document_number: input.sourceDocumentNumber ?? null,
      backlog_issue_key: key,
      note: input.note ?? null,
      created_by: actor
    }, {
      note: ["note", "notes", "remarks", "memo", "purpose"],
      created_by: ["created_by", "registered_by"]
    }, "PAYMENT_SCHEMA_UNSUPPORTED");
    try {
      const result = await this.database.query(insert.text, insert.params);
      return mapPayment(matterId, result.rows[0]);
    } catch (error) {
      throw translate(error, "PAYMENT_GRANT_MISSING", "支払台帳の書込権限が未付与です（grant 016 を適用してください）");
    }
  }

  async updatePayment(matterId: number, paymentId: number, patch: PaymentPatchInput) {
    const { keys } = await this.resolveIssueKey(this.database, matterId);
    const sets: string[] = []; const params: unknown[] = [paymentId, keys];
    if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`); }
    if (patch.paidDate !== undefined) { params.push(patch.paidDate); sets.push(`paid_date = $${params.length}`); }
    if (patch.dueDate !== undefined) { params.push(patch.dueDate); sets.push(`due_date = $${params.length}`); }
    if (!sets.length) throw new MatterWriteError("MATTER_CHECK_FAILED", "変更内容がありません");
    try {
      const result = await this.database.query(
        `UPDATE payments SET ${sets.join(", ")}
          WHERE id = $1 AND backlog_issue_key = ANY($2::text[]) RETURNING *`, params);
      if (!result.rows[0]) throw new MatterWriteError("MATTER_TASK_NOT_FOUND", "支払が見つかりません");
      return mapPayment(matterId, result.rows[0]);
    } catch (error) {
      throw translate(error, "PAYMENT_GRANT_MISSING", "支払台帳の更新権限が未付与です（grant 016 を適用してください）");
    }
  }
}

function translate(error: unknown, grantCode: string, grantMessage: string): unknown {
  if (error instanceof MatterWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "42501") return new MatterWriteError(grantCode, grantMessage);
  if (code === "23514" || code === "22P02" || code === "23502") {
    return new MatterWriteError("MATTER_CHECK_FAILED",
      `DB の制約に合いません（${String((error as Error)?.message ?? "").slice(0, 200)}）`);
  }
  return error;
}

function mapDelivery(matterId: number, row: Record<string, any>): DeliveryRecord {
  return {
    id: Number(row.id), matterId, backlogIssueKey: String(row.backlog_issue_key ?? ""),
    status: String(row.status ?? ""), deliveredAmount: numberOrNull(row.delivered_amount),
    inspectionDeadline: dateOnly(row.inspection_deadline)
  };
}
function mapPayment(matterId: number, row: Record<string, any>): PaymentRecord {
  return {
    id: Number(row.id), matterId, backlogIssueKey: String(row.backlog_issue_key ?? ""),
    status: String(row.status ?? ""), amountExTax: Number(row.amount_ex_tax ?? 0),
    totalAmount: Number(row.total_amount ?? row.amount_ex_tax ?? 0), currency: String(row.currency ?? "JPY"),
    dueDate: dateOnly(row.due_date), paidDate: dateOnly(row.paid_date)
  };
}

// テスト用。案件→課題キーの対応を与えて、納品・支払をメモリに積む。
export class MemoryMatterDeliveryPaymentRepository implements MatterDeliveryPaymentRepository {
  readonly deliveries: DeliveryRecord[] = [];
  readonly payments: PaymentRecord[] = [];
  private sequence = 1;
  constructor(private readonly issueKeys: Record<number, string[]> = {}) {}

  private resolve(matterId: number, requested?: string | null) {
    const keys = this.issueKeys[matterId];
    if (!keys) throw new MatterWriteError("MATTER_NOT_FOUND", "案件が見つかりません");
    const wanted = String(requested ?? "").trim();
    if (wanted && !keys.includes(wanted)) throw new MatterWriteError("MATTER_REFERENCE_INVALID", `課題キー ${wanted} はこの案件に紐づいていません`);
    if (!wanted && !keys.length) throw new MatterWriteError("MATTER_ISSUE_REQUIRED", "課題キーが無い案件です");
    return wanted || keys[0];
  }
  async createDelivery(matterId: number, input: DeliveryCreateInput) {
    const key = this.resolve(matterId, input.backlogIssueKey);
    const record: DeliveryRecord = {
      id: this.sequence++, matterId, backlogIssueKey: key, status: input.status ?? "delivered",
      deliveredAmount: input.deliveredAmount ?? null, inspectionDeadline: input.inspectionDeadline ?? null
    };
    this.deliveries.push(record);
    return record;
  }
  async updateDelivery(matterId: number, deliveryId: number, patch: DeliveryPatchInput) {
    const record = this.deliveries.find((d) => d.id === deliveryId && d.matterId === matterId);
    if (!record) throw new MatterWriteError("MATTER_TASK_NOT_FOUND", "納品実績が見つかりません");
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.inspectionDeadline !== undefined) record.inspectionDeadline = patch.inspectionDeadline;
    return record;
  }
  async createPayment(matterId: number, input: PaymentCreateInput) {
    const key = this.resolve(matterId, input.backlogIssueKey);
    const record: PaymentRecord = {
      id: this.sequence++, matterId, backlogIssueKey: key,
      status: input.status ?? (input.paidDate ? "paid" : "planned"),
      amountExTax: input.amountExTax, totalAmount: input.totalAmount ?? input.amountExTax,
      currency: (input.currency ?? "JPY").toUpperCase(), dueDate: input.dueDate ?? null, paidDate: input.paidDate ?? null
    };
    this.payments.push(record);
    return record;
  }
  async updatePayment(matterId: number, paymentId: number, patch: PaymentPatchInput) {
    const record = this.payments.find((p) => p.id === paymentId && p.matterId === matterId);
    if (!record) throw new MatterWriteError("MATTER_TASK_NOT_FOUND", "支払が見つかりません");
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.paidDate !== undefined) record.paidDate = patch.paidDate;
    if (patch.dueDate !== undefined) record.dueDate = patch.dueDate;
    return record;
  }
}
