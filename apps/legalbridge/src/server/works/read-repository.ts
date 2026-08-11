import type { DatabasePool } from "../db/pool.js";
import {
  buildLineageView, groupWorkConditions,
  type GroupedWorkConditions, type LineageNode, type LineageView, type WorkConditionLine
} from "./work-detail.js";

// 作品集約リード（Phase 2・読み取り専用）。作品を起点に 概要/系譜/素材/権利ソース/
// 条件 を一望する。新規GRANT不要（006: works/condition_lines/vendors/documents、
// 007: work_materials/material_rights_sources/work_relations/contracts のSELECTを利用）。
// 007 未適用など権限不足・未整備テーブル（42501/42P01/42703）はセクション単位で
// null 縮退し、コアの作品概要は返す。書込みは一切しない。

const MAX_DEPTH = 20;
const DEGRADE_CODES = new Set(["42501", "42P01", "42703"]);

function degradable(error: unknown): boolean {
  return DEGRADE_CODES.has((error as { code?: string })?.code ?? "");
}

export interface WorkSummary {
  id: number;
  workCode: string | null;
  title: string | null;
  titleKana: string | null;
  kind: string | null;
  isOriginal: boolean | null;
  workType: string | null;
  status: string | null;
  parentWorkId: number | null;
  isActive: boolean | null;
}

export interface WorkCore extends WorkSummary {
  derivationType: string | null;
  rightsHolderVendorId: number | null;
  rightsHolderName: string | null;
  creatorName: string | null;
  publisherName: string | null;
  ledgerCode: string | null;
  remarks: string | null;
}

export interface WorkMaterialRow {
  id: number;
  materialNo: number | null;
  materialCode: string | null;
  materialName: string | null;
  materialType: string | null;
  materialRole: string | null;
  acquisitionType: string | null;
  rightsType: string | null;
  rightsHolderVendorId: number | null;
  rightsHolderLabel: string | null;
  isRoyaltyBearing: boolean | null;
  isDefault: boolean | null;
  categoryName: string | null;
  territory: string | null;
  language: string | null;
  remarks: string | null;
}

export interface RightsSourceRow {
  id: number;
  materialId: number | null;
  materialName: string | null;
  sourceType: string | null;
  sourceWorkId: number | null;
  sourceWorkTitle: string | null;
  rightsHolderVendorId: number | null;
  rightsHolderName: string | null;
  sourceDocumentId: number | null;
  sourceContractId: number | null;
  sourceRole: string | null;
  isPrimary: boolean | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface WorkDetail {
  work: WorkCore;
  lineage: LineageView | null;
  materials: WorkMaterialRow[] | null;
  rightsSources: RightsSourceRow[] | null;
  conditions: GroupedWorkConditions | null;
}

export interface WorkListResult {
  works: WorkSummary[];
  total: number;
}

export interface WorkReadRepository {
  list(options: { keyword?: string; limit?: number }): Promise<WorkListResult>;
  detail(workId: number): Promise<WorkDetail | null>;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function bool(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(value);
}
function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toSummary(row: Record<string, unknown>): WorkSummary {
  return {
    id: Number(row.id),
    workCode: str(row.work_code),
    title: str(row.title),
    titleKana: str(row.title_kana),
    kind: str(row.kind),
    isOriginal: bool(row.is_original),
    workType: str(row.work_type),
    status: str(row.status),
    parentWorkId: num(row.parent_work_id),
    isActive: bool(row.is_active)
  };
}

const SUMMARY_COLUMNS =
  "id, work_code, title, title_kana, kind, is_original, work_type, status, parent_work_id, is_active";

export class PgWorkReadRepository implements WorkReadRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(options: { keyword?: string; limit?: number }): Promise<WorkListResult> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const keyword = (options.keyword ?? "").trim();
    const params: unknown[] = [];
    let where = "WHERE COALESCE(is_active, true) = true";
    if (keyword) {
      params.push(`%${keyword}%`);
      where += ` AND (title ILIKE $${params.length} OR work_code ILIKE $${params.length}` +
        ` OR COALESCE(title_kana, '') ILIKE $${params.length})`;
    }
    params.push(limit);
    const result = await this.database.query(
      `SELECT ${SUMMARY_COLUMNS} FROM works ${where}
        ORDER BY work_code NULLS LAST, id DESC LIMIT $${params.length}`,
      params
    );
    return { works: result.rows.map(toSummary), total: result.rows.length };
  }

  async detail(workId: number): Promise<WorkDetail | null> {
    // コア（works は 006 で必ず読める）。無ければ 404 相当の null。
    const core = await this.database.query(
      `SELECT w.${SUMMARY_COLUMNS}, w.derivation_type, w.rights_holder_vendor_id,
              v.vendor_name AS rights_holder_name, w.creator_name, w.publisher_name,
              w.ledger_code, w.remarks
         FROM works w
         LEFT JOIN vendors v ON v.id = w.rights_holder_vendor_id
        WHERE w.id = $1`,
      [workId]
    );
    if (!core.rows.length) return null;
    const row = core.rows[0];
    const work: WorkCore = {
      ...toSummary(row),
      derivationType: str(row.derivation_type),
      rightsHolderVendorId: num(row.rights_holder_vendor_id),
      rightsHolderName: str(row.rights_holder_name),
      creatorName: str(row.creator_name),
      publisherName: str(row.publisher_name),
      ledgerCode: str(row.ledger_code),
      remarks: str(row.remarks)
    };

    const [lineage, materials, rightsSources, conditions] = await Promise.all([
      this.lineage(workId).catch((e) => { if (degradable(e)) return null; throw e; }),
      this.materials(workId).catch((e) => { if (degradable(e)) return null; throw e; }),
      this.rightsSources(workId).catch((e) => { if (degradable(e)) return null; throw e; }),
      this.conditions(workId).catch((e) => { if (degradable(e)) return null; throw e; })
    ]);

    return { work, lineage, materials, rightsSources, conditions };
  }

  private async lineage(workId: number): Promise<LineageView> {
    // 原作→selected の系譜（works.parent_work_id）。receivable-map と同一解釈。
    const ancestors = await this.database.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_work_id, title, work_code, 0 AS depth
           FROM works WHERE id = $1
         UNION ALL
         SELECT w.id, w.parent_work_id, w.title, w.work_code, up.depth + 1
           FROM works w JOIN up ON w.id = up.parent_work_id
          WHERE up.depth < ${MAX_DEPTH}
       )
       SELECT id, title, work_code FROM up ORDER BY depth DESC`,
      [workId]
    );
    const children = await this.database.query(
      `SELECT id, title, work_code, kind, status FROM works WHERE parent_work_id = $1
        ORDER BY work_code NULLS LAST, id`,
      [workId]
    );
    // work_relations の親（parent_work_id 系譜との差分検出用）。
    const relationParents = await this.database.query(
      `SELECT w.id, w.title, w.work_code
         FROM work_relations r JOIN works w ON w.id = r.parent_work_id
        WHERE r.child_work_id = $1`,
      [workId]
    );
    const node = (r: Record<string, unknown>): LineageNode =>
      ({ workId: Number(r.id), title: str(r.title), workCode: str(r.work_code) });
    const childNode = (r: Record<string, unknown>): LineageNode =>
      ({ workId: Number(r.id), title: str(r.title), workCode: str(r.work_code), kind: str(r.kind), status: str(r.status) });
    return buildLineageView(
      workId,
      ancestors.rows.map(node),
      children.rows.map(childNode),
      relationParents.rows.map(node)
    );
  }

  private async materials(workId: number): Promise<WorkMaterialRow[]> {
    const result = await this.database.query(
      `SELECT wm.id, wm.material_no, wm.material_code, wm.material_name, wm.material_type,
              wm.material_role, wm.acquisition_type, wm.rights_type, wm.rights_holder_vendor_id,
              wm.rights_holder_label, wm.is_royalty_bearing, wm.is_default,
              mc.name AS category_name, wm.territory, wm.language, wm.remarks
         FROM work_materials wm
         LEFT JOIN material_categories mc ON mc.id = wm.category_id
        WHERE wm.work_id = $1
        ORDER BY wm.material_no NULLS LAST, wm.id`,
      [workId]
    );
    return result.rows.map((r) => ({
      id: Number(r.id),
      materialNo: num(r.material_no),
      materialCode: str(r.material_code),
      materialName: str(r.material_name),
      materialType: str(r.material_type),
      materialRole: str(r.material_role),
      acquisitionType: str(r.acquisition_type),
      rightsType: str(r.rights_type),
      rightsHolderVendorId: num(r.rights_holder_vendor_id),
      rightsHolderLabel: str(r.rights_holder_label),
      isRoyaltyBearing: bool(r.is_royalty_bearing),
      isDefault: bool(r.is_default),
      categoryName: str(r.category_name),
      territory: str(r.territory),
      language: str(r.language),
      remarks: str(r.remarks)
    }));
  }

  private async rightsSources(workId: number): Promise<RightsSourceRow[]> {
    const result = await this.database.query(
      `SELECT mrs.id, mrs.material_id, wm.material_name, mrs.source_type,
              mrs.source_work_id, sw.title AS source_work_title,
              mrs.rights_holder_vendor_id, v.vendor_name AS rights_holder_name,
              mrs.source_document_id, mrs.source_contract_id, mrs.source_role,
              mrs.is_primary, mrs.valid_from, mrs.valid_to
         FROM material_rights_sources mrs
         JOIN work_materials wm ON wm.id = mrs.material_id
         LEFT JOIN works sw ON sw.id = mrs.source_work_id
         LEFT JOIN vendors v ON v.id = mrs.rights_holder_vendor_id
        WHERE wm.work_id = $1
        ORDER BY mrs.is_primary DESC NULLS LAST, mrs.id`,
      [workId]
    );
    return result.rows.map((r) => ({
      id: Number(r.id),
      materialId: num(r.material_id),
      materialName: str(r.material_name),
      sourceType: str(r.source_type),
      sourceWorkId: num(r.source_work_id),
      sourceWorkTitle: str(r.source_work_title),
      rightsHolderVendorId: num(r.rights_holder_vendor_id),
      rightsHolderName: str(r.rights_holder_name),
      sourceDocumentId: num(r.source_document_id),
      sourceContractId: num(r.source_contract_id),
      sourceRole: str(r.source_role),
      isPrimary: bool(r.is_primary),
      validFrom: str(r.valid_from),
      validTo: str(r.valid_to)
    }));
  }

  private async conditions(workId: number): Promise<GroupedWorkConditions> {
    const result = await this.database.query(
      `SELECT cl.id, cl.condition_name, cl.direction, cl.flow_direction,
              cl.source_material_id, wm.material_name, cl.sublicense_allowed,
              cl.parent_license_condition_id, cl.rate_pct, cl.amount_ex_tax,
              cl.mg_amount, cl.currency, d.document_number
         FROM condition_lines cl
         LEFT JOIN work_materials wm ON wm.id = cl.source_material_id
         LEFT JOIN documents d ON d.id = cl.document_id
        WHERE cl.work_id = $1
        ORDER BY cl.direction NULLS LAST, cl.source_material_id NULLS FIRST, cl.id DESC
        LIMIT 500`,
      [workId]
    );
    const lines: WorkConditionLine[] = result.rows.map((r) => ({
      id: Number(r.id),
      conditionName: str(r.condition_name),
      direction: (r.direction as WorkConditionLine["direction"]) ?? null,
      flowDirection: (r.flow_direction as WorkConditionLine["flowDirection"]) ?? null,
      sourceMaterialId: num(r.source_material_id),
      materialName: str(r.material_name),
      sublicenseAllowed: bool(r.sublicense_allowed),
      parentLicenseConditionId: num(r.parent_license_condition_id),
      ratePct: num(r.rate_pct),
      amountExTax: num(r.amount_ex_tax),
      mgAmount: num(r.mg_amount),
      currency: str(r.currency),
      documentNumber: str(r.document_number)
    }));
    return groupWorkConditions(lines);
  }
}

// テスト・DB非依存起動用のインメモリ実装。
export class MemoryWorkReadRepository implements WorkReadRepository {
  constructor(
    private readonly works: WorkCore[] = [],
    private readonly details = new Map<number, Omit<WorkDetail, "work">>()
  ) {}

  async list(options: { keyword?: string; limit?: number }): Promise<WorkListResult> {
    const keyword = (options.keyword ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const filtered = this.works
      .filter((w) => w.isActive !== false)
      .filter((w) => !keyword ||
        (w.title ?? "").toLowerCase().includes(keyword) ||
        (w.workCode ?? "").toLowerCase().includes(keyword) ||
        (w.titleKana ?? "").toLowerCase().includes(keyword));
    return { works: filtered.slice(0, limit), total: filtered.length };
  }

  async detail(workId: number): Promise<WorkDetail | null> {
    const work = this.works.find((w) => w.id === workId);
    if (!work) return null;
    const extra = this.details.get(workId) ?? {
      lineage: null, materials: null, rightsSources: null, conditions: null
    };
    return { work, ...extra };
  }
}
