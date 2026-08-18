import type { DatabasePool } from "../db/pool.js";
import { resolveNumberPrefix, formatDocumentNumber, currentYearInTokyo } from "./finalization-repository.js";

// 文書ルックアップ（読取専用・Phase 10-6）。番号採番プレビュー（非破壊）と PDF 未生成一覧。
// いずれも SELECT のみ＝新規 GRANT 不要。番号プレビューは V1 と異なり sequences を増分しない
// （プレビューで採番を消費しない安全設計）。

export interface PendingPdfRow {
  id: number;
  documentNumber: string | null;
  issueKey: string;
  templateType: string;
  title: string;
  counterparty: string;
  createdAt: string;
}

export interface PendingPdfResult {
  total: number;
  rows: PendingPdfRow[];
  countsByTemplate: Record<string, number>;
}

export interface NextNumberPreview {
  templateType: string;
  prefix: string;
  year: number;
  sequence: number;    // 次に採番される連番（増分はしない）
  number: string;      // プレビュー番号（ARC-<prefix>-<year>-<0001>）
}

// 同じ親POの確定済み検収書の明細（検収済み行の支払日・金額の補完に使う）。
export interface InspectionHistoryEntry {
  documentNumber: string | null;
  itemName: string;
  deliveryDate: string;
  paidDate: string;
  amountExTax: number;
  inspectionCompletedAt: string;
}

export interface DocumentLookupRepository {
  pendingPdf(templateType: string | undefined, limit: number): Promise<PendingPdfResult>;
  peekNextNumber(templateType: string): Promise<NextNumberPreview | null>;
  inspectionHistory(parentPoNumber: string): Promise<InspectionHistoryEntry[]>;
}

const TITLE_KEYS = ["PROJECT_TITLE", "CONTRACT_TITLE", "基本契約名", "件名", "title"];
const PARTY_KEYS = ["VENDOR_NAME", "Licensor_氏名会社名", "Licensor_名称", "取引先", "counterparty"];

function pick(formData: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = formData[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

export class PgDocumentLookupRepository implements DocumentLookupRepository {
  constructor(private readonly database: DatabasePool) {}

  async pendingPdf(templateType: string | undefined, limit: number): Promise<PendingPdfResult> {
    const capped = Math.min(Math.max(limit, 1), 500);
    // 発行済（voided でない）だが Drive 保存されていない＝PDF 未生成キュー。
    const where = `(drive_link IS NULL OR drive_link = '')
                     AND COALESCE(lifecycle_status, 'final') <> 'voided'`;
    const params: unknown[] = [capped];
    let filter = "";
    if (templateType) { params.push(templateType); filter = ` AND template_type = $${params.length}`; }
    const rowsResult = await this.database.query(
      `SELECT id, document_number, issue_key, template_type, form_data, created_at
         FROM documents
        WHERE ${where}${filter}
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $1`,
      params
    );
    const countsResult = await this.database.query(
      `SELECT template_type, COUNT(*)::int AS n
         FROM documents
        WHERE ${where}
        GROUP BY template_type
        ORDER BY n DESC`
    );
    const countsByTemplate: Record<string, number> = {};
    for (const r of countsResult.rows) countsByTemplate[r.template_type] = Number(r.n);
    const rows: PendingPdfRow[] = rowsResult.rows.map((r) => {
      const fd = (r.form_data ?? {}) as Record<string, unknown>;
      return {
        id: Number(r.id),
        documentNumber: r.document_number ?? null,
        issueKey: r.issue_key,
        templateType: r.template_type,
        title: pick(fd, TITLE_KEYS) || r.document_number || r.issue_key || "",
        counterparty: pick(fd, PARTY_KEYS),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : ""
      };
    });
    return { total: rows.length, rows, countsByTemplate };
  }

  async peekNextNumber(templateType: string): Promise<NextNumberPreview | null> {
    const tpl = await this.database.query(
      `SELECT document_prefix FROM document_templates
        WHERE template_key = $1 AND is_active = true LIMIT 1`,
      [templateType]
    );
    if (!tpl.rows[0]) return null;
    const prefix = resolveNumberPrefix(tpl.rows[0].document_prefix, templateType);
    if (!prefix) return null;
    const year = currentYearInTokyo();
    const seqResult = await this.database.query(
      `SELECT current_value FROM document_sequences WHERE kind = $1 AND year = $2 LIMIT 1`,
      [prefix, year]
    );
    const current = seqResult.rows[0] ? Number(seqResult.rows[0].current_value) : 0;
    const sequence = current + 1;   // 増分はしない（プレビューのみ）
    return { templateType, prefix, year, sequence, number: formatDocumentNumber(prefix, year, sequence) };
  }

  async inspectionHistory(parentPoNumber: string): Promise<InspectionHistoryEntry[]> {
    // 現在有効（final）の検収書だけを見る。reissued（再発行で置き換わった旧版）を含めると
    // 同じ明細が二重に出る。上限は防御的（1つのPOに数十枚の検収書は想定外）。
    const result = await this.database.query(
      `SELECT document_number, form_data
         FROM documents
        WHERE template_type = 'inspection_certificate'
          AND COALESCE(lifecycle_status, 'final') = 'final'
          AND form_data->>'parent_po_number' = $1
        ORDER BY created_at ASC, id ASC
        LIMIT 50`,
      [parentPoNumber]
    );
    return result.rows.flatMap((row) =>
      historyEntriesOf(row.document_number ?? null, (row.form_data ?? {}) as Record<string, unknown>));
  }
}

// 確定済み検収書1枚 → 履歴エントリ（未検収 skip 行は実績ではないので除く）。
export function historyEntriesOf(
  documentNumber: string | null, formData: Record<string, unknown>
): InspectionHistoryEntry[] {
  const lines = Array.isArray(formData.delivery_line_items)
    ? formData.delivery_line_items as Array<Record<string, unknown>> : [];
  const str = (value: unknown) => String(value ?? "").trim();
  return lines
    .filter((line) => str(line.inspection_status) !== "skip")
    .map((line) => ({
      documentNumber,
      itemName: str(line.item_name),
      deliveryDate: str(line.delivery_date) || str(formData.deliveredAt),
      paidDate: str(line.paid_date) || str(formData.paymentDueDate),
      amountExTax: Number(String(line.inspected_amount_ex_tax ?? line.amount_ex_tax ?? 0).replace(/,/g, "")) || 0,
      inspectionCompletedAt: str(formData.inspectionCompletedAt) || str(formData.documentDate)
    }))
    .filter((entry) => entry.itemName !== "");
}

// メモリ実装（テスト用）。docs（pending 判定用）と sequences（採番プレビュー用）を簡易保持。
export interface MemoryLookupDoc {
  id: number;
  documentNumber: string | null;
  issueKey: string;
  templateType: string;
  driveLink: string;
  lifecycleStatus?: string;
  title?: string;
  counterparty?: string;
  createdAt?: string;
  formData?: Record<string, unknown>;
}

export class MemoryDocumentLookupRepository implements DocumentLookupRepository {
  constructor(
    private readonly docs: MemoryLookupDoc[] = [],
    private readonly prefixes: Record<string, string> = {},   // templateType → prefix
    private readonly sequences: Record<string, number> = {}    // `${prefix}:${year}` → current
  ) {}

  async pendingPdf(templateType: string | undefined, limit: number): Promise<PendingPdfResult> {
    const pending = this.docs.filter((d) =>
      (!d.driveLink) && (d.lifecycleStatus ?? "final") !== "voided");
    const countsByTemplate: Record<string, number> = {};
    for (const d of pending) countsByTemplate[d.templateType] = (countsByTemplate[d.templateType] ?? 0) + 1;
    const filtered = pending.filter((d) => !templateType || d.templateType === templateType).slice(0, Math.max(limit, 1));
    const rows = filtered.map((d) => ({
      id: d.id, documentNumber: d.documentNumber, issueKey: d.issueKey, templateType: d.templateType,
      title: d.title ?? d.documentNumber ?? d.issueKey, counterparty: d.counterparty ?? "", createdAt: d.createdAt ?? ""
    }));
    return { total: rows.length, rows, countsByTemplate };
  }

  async peekNextNumber(templateType: string): Promise<NextNumberPreview | null> {
    const prefix = resolveNumberPrefix(this.prefixes[templateType], templateType);
    if (!prefix) return null;
    const year = currentYearInTokyo();
    const current = this.sequences[`${prefix}:${year}`] ?? 0;
    const sequence = current + 1;
    return { templateType, prefix, year, sequence, number: formatDocumentNumber(prefix, year, sequence) };
  }

  async inspectionHistory(parentPoNumber: string): Promise<InspectionHistoryEntry[]> {
    return this.docs
      .filter((d) => d.templateType === "inspection_certificate"
        && (d.lifecycleStatus ?? "final") === "final"
        && String((d.formData ?? {}).parent_po_number ?? "") === parentPoNumber)
      .flatMap((d) => historyEntriesOf(d.documentNumber, d.formData ?? {}));
  }
}
