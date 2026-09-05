import type { DatabasePool } from "../db/pool.js";
import type { ScopeOption } from "../../rights-scope.js";

export interface WorkRightsSummary {
  id: number;
  workCode: string;
  title: string;
  kind: string;
  parentWorkId: number | null;
  derivationType: string | null;
  materialCount: number;
  conditionCount: number;
  contractCount: number;
}

export interface WorkRightsDetail {
  work: WorkRightsSummary & {
    workType: string | null;
    status: string | null;
    creatorName: string | null;
    publisherName: string | null;
    defaultRightsHolder: string | null;
    remarks: string | null;
  };
  parent: { id: number; workCode: string; title: string; relationType: string | null } | null;
  children: Array<{ id: number; workCode: string; title: string; relationType: string | null }>;
  materials: Array<{
    id: number;
    materialCode: string | null;
    name: string;
    materialType: string | null;
    materialRole: string | null;
    acquisitionType: string | null;
    rightsType: string | null;
    rightsHolder: string | null;
    territory: string | null;
    language: string | null;
    royaltyBearing: boolean;
  }>;
  conditions: Array<{
    id: number;
    name: string;
    direction: string | null;
    flowDirection: string | null;
    transactionKind: string | null;
    paymentScheme: string | null;
    calcType: string | null;
    ratePct: number | null;
    amountExTax: number | null;
    mgAmount: number | null;
    agAmount: number | null;
    currency: string | null;
    territory: string | null;
    language: string | null;
    regions: ScopeOption[];
    languages: ScopeOption[];
    exclusivity: string | null;
    sublicenseAllowed: boolean | null;
    termStart: string | null;
    termEnd: string | null;
    parentLicenseConditionId: number | null;
    sourceMaterialId: number | null;
    sourceMaterialName: string | null;
    counterparty: string | null;
    documentNumber: string | null;
  }>;
  contracts: Array<{
    id: number;
    documentNumber: string | null;
    title: string;
    contractType: string | null;
    status: string | null;
    effectiveDate: string | null;
    expirationDate: string | null;
    role: string | null;
    counterparty: string | null;
  }>;
}

export interface WorkRightsRepository {
  list(query?: string, limit?: number): Promise<WorkRightsSummary[]>;
  find(id: number): Promise<WorkRightsDetail | null>;
}

export class PgWorkRightsRepository implements WorkRightsRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query = "", limit = 200) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT w.id, w.work_code, w.title, w.kind, w.parent_work_id, w.derivation_type,
              COUNT(DISTINCT wm.id)::int AS material_count,
              COUNT(DISTINCT cl.id)::int AS condition_count,
              COUNT(DISTINCT cw.contract_id)::int AS contract_count
         FROM works w
         LEFT JOIN work_materials wm ON wm.work_id = w.id
         LEFT JOIN condition_lines cl ON cl.work_id = w.id
         LEFT JOIN contract_works cw ON cw.work_id = w.id
        WHERE w.is_active = true
          AND ($1 = '%%'
            OR w.title ILIKE $1
            OR w.work_code ILIKE $1
            OR COALESCE(w.creator_name, '') ILIKE $1
            OR COALESCE(w.publisher_name, '') ILIKE $1)
        GROUP BY w.id
        ORDER BY w.updated_at DESC NULLS LAST, w.id DESC
        LIMIT $2`,
      [keyword, Math.min(Math.max(limit, 1), 500)]
    );
    return result.rows.map(mapSummary);
  }

  async find(id: number) {
    const workResult = await this.database.query(
      `SELECT w.id, w.work_code, w.title, w.kind, w.parent_work_id, w.derivation_type,
              w.work_type, w.status, w.creator_name, w.publisher_name,
              w.default_rights_holder, w.remarks,
              COUNT(DISTINCT wm.id)::int AS material_count,
              COUNT(DISTINCT cl.id)::int AS condition_count,
              COUNT(DISTINCT cw.contract_id)::int AS contract_count
         FROM works w
         LEFT JOIN work_materials wm ON wm.work_id = w.id
         LEFT JOIN condition_lines cl ON cl.work_id = w.id
         LEFT JOIN contract_works cw ON cw.work_id = w.id
        WHERE w.id = $1
        GROUP BY w.id`,
      [id]
    );
    if (!workResult.rows[0]) return null;

    const [materials, conditions, contracts, parent, children, regionRows, languageRows] = await Promise.all([
      this.database.query(
        `SELECT wm.id, wm.material_code, wm.material_name, wm.material_type,
                wm.material_role, wm.acquisition_type, wm.rights_type,
                COALESCE(v.vendor_name, wm.rights_holder_label) AS rights_holder,
                wm.territory, wm.language, wm.is_royalty_bearing
           FROM work_materials wm
           LEFT JOIN vendors v ON v.id = wm.rights_holder_vendor_id
          WHERE wm.work_id = $1
          ORDER BY wm.is_default DESC, wm.material_no NULLS LAST, wm.id`,
        [id]
      ),
      this.database.query(
        `SELECT cl.id, cl.condition_name, cl.direction, cl.flow_direction, cl.is_inbound,
                cl.transaction_kind, cl.payment_scheme, cl.calc_type,
                cl.rate_pct, cl.amount_ex_tax, cl.mg_amount, cl.ag_amount,
                cl.currency, cl.region_territory, cl.region_language,
                cl.exclusivity, cl.sublicense_allowed, cl.term_start, cl.term_end,
                cl.parent_license_condition_id, cl.source_material_id,
                wm.material_name AS source_material_name,
                v.vendor_name AS counterparty,
                d.document_number
           FROM condition_lines cl
           LEFT JOIN work_materials wm ON wm.id = cl.source_material_id
           LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
           LEFT JOIN documents d ON d.id = cl.document_id
          WHERE cl.work_id = $1
          ORDER BY COALESCE(cl.flow_direction, CASE WHEN cl.is_inbound THEN 'in' ELSE 'out' END),
                   cl.direction, cl.group_no NULLS LAST, cl.line_no, cl.id`,
        [id]
      ),
      this.database.query(
        `SELECT c.id, c.document_number, c.contract_title, c.contract_type,
                c.contract_status, c.effective_date, c.expiration_date,
                cw.role, v.vendor_name AS counterparty
           FROM contract_works cw
           JOIN contracts c ON c.id = cw.contract_id
           LEFT JOIN vendors v ON v.id = c.primary_vendor_id
          WHERE cw.work_id = $1
          ORDER BY c.updated_at DESC NULLS LAST, c.id DESC`,
        [id]
      ),
      this.database.query(
        `SELECT p.id, p.work_code, p.title, wr.relation_type
           FROM works c
           JOIN works p ON p.id = c.parent_work_id
           LEFT JOIN work_relations wr
             ON wr.child_work_id = c.id AND wr.parent_work_id = p.id
          WHERE c.id = $1
          LIMIT 1`,
        [id]
      ),
      this.database.query(
        `SELECT c.id, c.work_code, c.title,
                COALESCE(wr.relation_type, c.derivation_type) AS relation_type
           FROM works c
           LEFT JOIN work_relations wr
             ON wr.child_work_id = c.id AND wr.parent_work_id = $1
          WHERE c.parent_work_id = $1 OR wr.parent_work_id = $1
          ORDER BY c.title, c.id`,
        [id]
      ),
      this.database.query(
        `SELECT r.condition_line_id, r.country_code, r.country_name
           FROM condition_line_regions r
           JOIN condition_lines cl ON cl.id = r.condition_line_id
          WHERE cl.work_id = $1
          ORDER BY r.condition_line_id, r.sort_order, r.id`,
        [id]
      ),
      this.database.query(
        `SELECT l.condition_line_id, l.language_code, l.language_name
           FROM condition_line_languages l
           JOIN condition_lines cl ON cl.id = l.condition_line_id
          WHERE cl.work_id = $1
          ORDER BY l.condition_line_id, l.sort_order, l.id`,
        [id]
      )
    ]);

    const w = workResult.rows[0];
    const regionsByCondition = groupScopeRows(
      regionRows.rows,
      "country_code",
      "country_name"
    );
    const languagesByCondition = groupScopeRows(
      languageRows.rows,
      "language_code",
      "language_name"
    );
    return {
      work: {
        ...mapSummary(w),
        workType: w.work_type ?? null,
        status: w.status ?? null,
        creatorName: w.creator_name ?? null,
        publisherName: w.publisher_name ?? null,
        defaultRightsHolder: w.default_rights_holder ?? null,
        remarks: w.remarks ?? null
      },
      parent: parent.rows[0] ? {
        id: Number(parent.rows[0].id),
        workCode: String(parent.rows[0].work_code ?? ""),
        title: String(parent.rows[0].title ?? ""),
        relationType: parent.rows[0].relation_type ?? null
      } : null,
      children: children.rows.map((row) => ({
        id: Number(row.id),
        workCode: String(row.work_code ?? ""),
        title: String(row.title ?? ""),
        relationType: row.relation_type ?? null
      })),
      materials: materials.rows.map((row) => ({
        id: Number(row.id),
        materialCode: row.material_code ?? null,
        name: String(row.material_name ?? ""),
        materialType: row.material_type ?? null,
        materialRole: row.material_role ?? null,
        acquisitionType: row.acquisition_type ?? null,
        rightsType: row.rights_type ?? null,
        rightsHolder: row.rights_holder ?? null,
        territory: row.territory ?? null,
        language: row.language ?? null,
        royaltyBearing: Boolean(row.is_royalty_bearing)
      })),
      conditions: conditions.rows.map((row) => ({
        id: Number(row.id),
        name: String(row.condition_name ?? ""),
        direction: row.direction ?? null,
        flowDirection: row.flow_direction ?? (row.is_inbound ? "in" : null),
        transactionKind: row.transaction_kind ?? null,
        paymentScheme: row.payment_scheme ?? null,
        calcType: row.calc_type ?? null,
        ratePct: num(row.rate_pct),
        amountExTax: num(row.amount_ex_tax),
        mgAmount: num(row.mg_amount),
        agAmount: num(row.ag_amount),
        currency: row.currency ?? null,
        territory: row.region_territory ?? null,
        language: row.region_language ?? null,
        regions: scopeRows(
          regionsByCondition.get(Number(row.id)) ?? [],
          row.region_territory,
          "region"
        ),
        languages: scopeRows(
          languagesByCondition.get(Number(row.id)) ?? [],
          row.region_language,
          "language"
        ),
        exclusivity: row.exclusivity ?? null,
        sublicenseAllowed: row.sublicense_allowed === null ? null : Boolean(row.sublicense_allowed),
        termStart: dateOnly(row.term_start),
        termEnd: dateOnly(row.term_end),
        parentLicenseConditionId: row.parent_license_condition_id === null ? null : Number(row.parent_license_condition_id),
        sourceMaterialId: row.source_material_id === null ? null : Number(row.source_material_id),
        sourceMaterialName: row.source_material_name ?? null,
        counterparty: row.counterparty ?? null,
        documentNumber: row.document_number ?? null
      })),
      contracts: contracts.rows.map((row) => ({
        id: Number(row.id),
        documentNumber: row.document_number ?? null,
        title: String(row.contract_title ?? ""),
        contractType: row.contract_type ?? null,
        status: row.contract_status ?? null,
        effectiveDate: dateOnly(row.effective_date),
        expirationDate: dateOnly(row.expiration_date),
        role: row.role ?? null,
        counterparty: row.counterparty ?? null
      }))
    };
  }
}

function groupScopeRows(
  rows: Record<string, unknown>[],
  codeKey: string,
  nameKey: string
) {
  const grouped = new Map<number, ScopeOption[]>();
  for (const row of rows) {
    const conditionId = Number(row.condition_line_id);
    if (!Number.isSafeInteger(conditionId)) continue;
    const code = String(row[codeKey] ?? "").trim();
    const name = String(row[nameKey] ?? "").trim();
    if (!code || !name) continue;
    const current = grouped.get(conditionId) ?? [];
    current.push({ code, name });
    grouped.set(conditionId, current);
  }
  return grouped;
}

function scopeRows(
  value: ScopeOption[],
  fallback: unknown,
  kind: "region" | "language"
): ScopeOption[] {
  if (value.length) return value;
  const text = String(fallback ?? "").trim();
  if (!text) return [];
  if (kind === "region" && /全世界|world/i.test(text)) {
    return [{ code: "WORLD", name: "全世界" }];
  }
  if (kind === "language" && /全言語|all languages?/i.test(text)) {
    return [{ code: "ALL", name: "全言語" }];
  }
  return [{ code: kind === "region" ? "LEGACY-R" : "LEGACY-L", name: text }];
}

function mapSummary(row: Record<string, any>): WorkRightsSummary {
  return {
    id: Number(row.id),
    workCode: String(row.work_code ?? ""),
    title: String(row.title ?? ""),
    kind: String(row.kind ?? "own"),
    parentWorkId: row.parent_work_id === null ? null : Number(row.parent_work_id),
    derivationType: row.derivation_type ?? null,
    materialCount: Number(row.material_count ?? 0),
    conditionCount: Number(row.condition_count ?? 0),
    contractCount: Number(row.contract_count ?? 0)
  };
}
function num(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function dateOnly(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(value);
  }
  const text = String(value);
  const iso = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(parsed);
  }
  return null;
}

export class MemoryWorkRightsRepository implements WorkRightsRepository {
  constructor(private readonly details: WorkRightsDetail[] = []) {}
  async list(query = "", limit = 200) {
    const keyword = query.trim().toLowerCase();
    return this.details.map((item) => item.work)
      .filter((item) => !keyword || [item.workCode, item.title].some((v) => v.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }
  async find(id: number) {
    return this.details.find((item) => item.work.id === id) ?? null;
  }
}
