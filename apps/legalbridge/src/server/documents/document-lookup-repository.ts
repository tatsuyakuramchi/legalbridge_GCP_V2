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

export interface DocumentLookupRepository {
  pendingPdf(templateType: string | undefined, limit: number): Promise<PendingPdfResult>;
  peekNextNumber(templateType: string): Promise<NextNumberPreview | null>;
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
}
