import type { DatabasePool } from "../db/pool.js";

export interface RegisteredDocument {
  id: number;
  documentNumber: string | null;
  previousDocumentNumber?: string | null;
  issueKey: string;
  templateType: string;
  templateVersionId: number | null;
  title: string;
  counterparty: string;
  driveLink: string;
  createdAt: string;
  createdBy: string | null;
  lifecycleStatus?: string;   // final / voided / draft 等（void 済みの表示に使用・Phase 10-2）
  matterId?: number | null;   // 紐付く案件（確定時に自動設定・W2で追加）
  baseDocumentNumber?: string | null;   // バージョン系列の基底番号（アーカイブ履歴・10-1）
  supersededBy?: string | null;         // これを差し替えた文書番号
  isPrimary?: boolean;                  // 系列内の正本フラグ
  formData: Record<string, unknown>;
  // 確定時に解決した documents.vendor_id の取引先マスタ（find / findByNumber のみ）。
  // form_data の区分は前に選んだ取引先の値が残ることがあるため、描画時の敬称は
  // マスタを優先する。names は宛名との突き合わせ用（別人のマスタで上書きしない）。
  vendorMaster?: VendorMasterEntity | null;
}

export interface VendorMasterEntity {
  entityType: string;
  names: string[];
}

// アーカイブのバージョン履歴 1 件（同一 base_document_number の系列・10-1）。
export interface DocumentVersion {
  id: number;
  documentNumber: string | null;
  templateType: string;
  lifecycleStatus: string;
  isPrimary: boolean;
  supersededBy: string | null;
  createdAt: string;
}

// 一覧の状態フィルタ（アーカイブ・10-1）。all=全件 / active=void以外 / voided=void のみ。
export type LifecycleFilter = "all" | "active" | "voided";

export interface DocumentRegistryRepository {
  list(query: string, templateType?: string, limit?: number, lifecycle?: LifecycleFilter): Promise<RegisteredDocument[]>;
  find(id: number): Promise<RegisteredDocument | null>;
  findByNumber(documentNumber: string): Promise<RegisteredDocument | null>;
  // バージョン履歴（同一系列を古い順）。文書が無ければ空配列。
  versionHistory(id: number): Promise<DocumentVersion[]>;
  setDriveLink(id: number, driveLink: string): Promise<void>;
}

// 1件取得（find / findByNumber）は取引先マスタも一緒に読む。区分は form_data より
// マスタが正しいため（宛名だけ書き換えると form_data 側に前の取引先の区分が残る）。
const DOCUMENT_SELECT = `d.id, d.document_number, h.previous_document_number, d.issue_key, d.template_type,
              d.template_version_id, d.form_data, d.drive_link, d.created_at,
              d.created_by, d.matter_id,
              COALESCE(d.lifecycle_status, 'final') AS lifecycle_status,
              v.entity_type AS vendor_entity_type,
              v.vendor_name AS vendor_master_name,
              v.trade_name AS vendor_master_trade_name,
              v.pen_name AS vendor_master_pen_name`;

// 取引先マスタの結合。documents.vendor_id があればそれを、無い旧文書（確定時に名前から解決
// できなかったもの）は宛名（form_data の相手先名）でマスタを引く（excel-batch と同じ順序:
// vendor_name → trade_name → pen_name）。宛名一致でしか引かないので別人のマスタは付かない。
// これが無いと vendor_id の無い検収書は区分不明＝敬称が既定の「御中」になり、個人宛でも御中で出ていた。
const VENDOR_MASTER_JOIN = `CROSS JOIN LATERAL (
           SELECT COALESCE(
             NULLIF(btrim(d.form_data->>'VENDOR_NAME'), ''), NULLIF(btrim(d.form_data->>'counterparty'), ''),
             NULLIF(btrim(d.form_data->>'取引先'), ''), NULLIF(btrim(d.form_data->>'相手先'), ''),
             NULLIF(btrim(d.form_data->>'LICENSOR_NAME'), ''), NULLIF(btrim(d.form_data->>'licensor'), ''),
             NULLIF(btrim(d.form_data->>'designerName'), '')
           ) AS party_name
         ) n
         LEFT JOIN LATERAL (
           SELECT v.entity_type, v.vendor_name, v.trade_name, v.pen_name
             FROM vendors v
            WHERE (d.vendor_id IS NOT NULL AND v.id = d.vendor_id)
               OR (d.vendor_id IS NULL AND n.party_name IS NOT NULL
                   AND (v.vendor_name = n.party_name OR v.trade_name = n.party_name OR v.pen_name = n.party_name
                        OR replace(replace(v.vendor_name, ' ', ''), '　', '') = replace(replace(n.party_name, ' ', ''), '　', '')))
            ORDER BY (v.id = d.vendor_id) DESC NULLS LAST, (v.vendor_name = n.party_name) DESC NULLS LAST, v.id
            LIMIT 1
         ) v ON true`;

// 文書番号の振替履歴（026・document_number_history）から直近の旧番号を引く。
// 一覧の検索対象にも含める（旧番号で探せる）。
const PREVIOUS_NUMBER_JOIN = `LEFT JOIN LATERAL (
           SELECT previous_document_number
             FROM document_number_history
            WHERE document_id = d.id
            ORDER BY changed_at DESC, id DESC
            LIMIT 1
         ) h ON true`;

export class PgDocumentRegistryRepository implements DocumentRegistryRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query: string, templateType?: string, limit = 100, lifecycle: LifecycleFilter = "all") {
    const keyword = `%${query.trim()}%`;
    // 「有効」は V1 の横断検索と同じく無効化だけでなく旧版（reissued/superseded）も除外する（監査 P1-1）。
    const lifecycleClause =
      lifecycle === "active" ? "AND COALESCE(lifecycle_status, 'final') NOT IN ('voided', 'reissued', 'superseded')"
      : lifecycle === "voided" ? "AND COALESCE(lifecycle_status, 'final') = 'voided'"
      : "";
    const result = await this.database.query(
      `SELECT d.id, d.document_number, h.previous_document_number, d.issue_key, d.template_type,
              d.template_version_id, d.form_data, d.drive_link, d.created_at, d.created_by, d.matter_id,
              COALESCE(d.lifecycle_status, 'final') AS lifecycle_status
         FROM documents d
         ${PREVIOUS_NUMBER_JOIN}
        WHERE ($1 = '%%'
          OR COALESCE(d.document_number, '') ILIKE $1
          OR d.issue_key ILIKE $1
          OR d.template_type ILIKE $1
          OR COALESCE(d.form_data->>'PROJECT_TITLE', d.form_data->>'CONTRACT_TITLE',
                      d.form_data->>'基本契約名', d.form_data->>'VENDOR_NAME',
                      d.form_data->>'Licensor_氏名会社名', '') ILIKE $1
          OR COALESCE(h.previous_document_number, '') ILIKE $1)
          AND ($2 = '' OR d.template_type = $2)
          ${lifecycleClause.replace(/COALESCE\(lifecycle_status/g, "COALESCE(d.lifecycle_status")}
        ORDER BY d.created_at DESC NULLS LAST, d.id DESC
        LIMIT $3`,
      [keyword, templateType ?? "", Math.min(Math.max(limit, 1), 200)]
    );
    return result.rows.map(mapRow);
  }

  async versionHistory(id: number): Promise<DocumentVersion[]> {
    const result = await this.database.query(
      `WITH target AS (
         SELECT COALESCE(NULLIF(base_document_number, ''), document_number) AS base
           FROM documents WHERE id = $1
       )
       SELECT id, document_number, template_type,
              COALESCE(lifecycle_status, 'final') AS lifecycle_status,
              COALESCE(is_primary, true) AS is_primary,
              superseded_by, created_at
         FROM documents
        WHERE (SELECT base FROM target) IS NOT NULL
          AND COALESCE(NULLIF(base_document_number, ''), document_number) = (SELECT base FROM target)
        ORDER BY created_at ASC NULLS FIRST, id ASC`,
      [id]
    );
    return result.rows.map(mapVersion);
  }

  async setDriveLink(id: number, driveLink: string) {
    const result = await this.database.query(
      `UPDATE documents SET drive_link = $2 WHERE id = $1`,
      [id, driveLink]
    );
    if (result.rowCount !== 1) throw new Error("document not found while updating drive link");
  }

  async find(id: number) {
    const result = await this.database.query(
      `SELECT ${DOCUMENT_SELECT}
         FROM documents d
         ${VENDOR_MASTER_JOIN}
         ${PREVIOUS_NUMBER_JOIN}
        WHERE d.id = $1`,
      [id]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByNumber(documentNumber: string) {
    const result = await this.database.query(
      `SELECT ${DOCUMENT_SELECT}
         FROM documents d
         ${VENDOR_MASTER_JOIN}
         ${PREVIOUS_NUMBER_JOIN}
        WHERE d.document_number = $1
        ORDER BY d.id DESC
        LIMIT 1`,
      [documentNumber]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

export class MemoryDocumentRegistryRepository implements DocumentRegistryRepository {
  constructor(private readonly documents: RegisteredDocument[] = []) {}

  async list(query: string, templateType?: string, limit = 100, lifecycle: LifecycleFilter = "all") {
    const keyword = query.trim().toLowerCase();
    return this.documents
      .filter((item) => !templateType || item.templateType === templateType)
      .filter((item) => {
        const status = item.lifecycleStatus ?? "final";
        if (lifecycle === "active") return status !== "voided";
        if (lifecycle === "voided") return status === "voided";
        return true;
      })
      .filter((item) => !keyword || [
        item.documentNumber, item.issueKey, item.templateType, item.title, item.counterparty
      ].some((value) => value?.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }

  async versionHistory(id: number): Promise<DocumentVersion[]> {
    const target = this.documents.find((d) => d.id === id);
    if (!target) return [];
    const base = (target.baseDocumentNumber || target.documentNumber) ?? null;
    if (!base) return [];
    return this.documents
      .filter((d) => ((d.baseDocumentNumber || d.documentNumber) ?? null) === base)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id))
      .map((d) => ({
        id: d.id, documentNumber: d.documentNumber, templateType: d.templateType,
        lifecycleStatus: d.lifecycleStatus ?? "final", isPrimary: d.isPrimary ?? true,
        supersededBy: d.supersededBy ?? null, createdAt: d.createdAt
      }));
  }

  async find(id: number) {
    return this.documents.find((item) => item.id === id) ?? null;
  }

  async findByNumber(documentNumber: string) {
    return this.documents.find((item) => item.documentNumber === documentNumber) ?? null;
  }

  async setDriveLink(id: number, driveLink: string) {
    const document = this.documents.find((item) => item.id === id);
    if (!document) throw new Error("document not found while updating drive link");
    document.driveLink = driveLink;
  }
}

function mapRow(row: Record<string, any>): RegisteredDocument {
  const formData = row.form_data ?? {};
  return {
    id: Number(row.id),
    documentNumber: row.document_number,
    previousDocumentNumber: row.previous_document_number ?? legacyPreviousNumber(formData),
    issueKey: row.issue_key,
    templateType: row.template_type,
    templateVersionId: row.template_version_id,
    title: firstText(formData, [
      "PROJECT_TITLE", "CONTRACT_TITLE", "基本契約名", "件名", "title"
    ]) || row.document_number || row.issue_key,
    counterparty: firstText(formData, [
      "VENDOR_NAME", "Licensor_氏名会社名", "Licensor_名称",
      "許諾者", "相手先", "counterparty"
    ]),
    driveLink: row.drive_link ?? "",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
    createdBy: row.created_by,
    lifecycleStatus: row.lifecycle_status ?? "final",
    matterId: row.matter_id == null ? null : Number(row.matter_id),
    formData,
    vendorMaster: mapVendorMaster(row)
  };
}

// 一覧（list）は取引先を結合しないので、列が無ければ null を返す。
function mapVendorMaster(row: Record<string, any>): VendorMasterEntity | null {
  const entityType = String(row.vendor_entity_type ?? "").trim();
  if (!entityType) return null;
  const names = [row.vendor_master_name, row.vendor_master_trade_name, row.vendor_master_pen_name]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value !== "");
  return { entityType, names };
}

function mapVersion(row: Record<string, any>): DocumentVersion {
  return {
    id: Number(row.id),
    documentNumber: row.document_number ?? null,
    templateType: row.template_type,
    lifecycleStatus: row.lifecycle_status ?? "final",
    isPrimary: row.is_primary !== false,
    supersededBy: row.superseded_by ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : ""
  };
}

function legacyPreviousNumber(values: Record<string, unknown>) {
  return firstText(values, [
    "PREVIOUS_DOCUMENT_NUMBER", "旧文書番号", "旧契約書番号",
    "BASE_DOC_NO", "元文書番号", "元契約番号",
    "previousDocumentNumber", "baseDocumentNumber", "originalDocumentNumber"
  ]) || null;
}

function firstText(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}
