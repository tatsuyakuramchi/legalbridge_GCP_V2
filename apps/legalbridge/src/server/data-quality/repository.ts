import type { DatabasePool } from "../db/pool.js";
import {
  summarizeQuality, type QualityCategory, type QualityReport, type QualitySample, type Severity
} from "./scan.js";

// データ品質センター（Phase 4・読み取り専用）。ポートフォリオ横断で整合性/完全性の
// 問題をスキャンし俯瞰する。新規GRANT不要（006/007/015の既存SELECTを利用）。
// スキャン単位で権限不足・未整備（42501/42P01/42703）は available:false に縮退し、
// 他カテゴリは通常表示する。書込みは一切しない。

const SAMPLE_LIMIT = 20;
const DEGRADE_CODES = new Set(["42501", "42P01", "42703", "42883"]);
function degradable(error: unknown): boolean {
  return DEGRADE_CODES.has((error as { code?: string })?.code ?? "");
}

export interface DataQualityRepository {
  scan(): Promise<QualityReport>;
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v: unknown): string { return v === null || v === undefined ? "" : String(v); }

interface ScanDef {
  key: string;
  label: string;
  description: string;
  severity: Severity;
  countSql: string;
  sampleSql: string;
  toSample: (row: Record<string, unknown>) => QualitySample;
}

const SCANS: ScanDef[] = [
  {
    key: "unlinked-conditions",
    label: "未リンク条件明細",
    description: "作品・文書・取引先のいずれかが未紐付けの条件明細",
    severity: "high",
    countSql: `SELECT count(*) AS c FROM condition_lines cl
       WHERE cl.work_id IS NULL OR cl.document_id IS NULL OR cl.counterparty_vendor_id IS NULL`,
    sampleSql: `SELECT cl.id, cl.condition_name,
              (cl.work_id IS NULL) AS no_work, (cl.document_id IS NULL) AS no_doc,
              (cl.counterparty_vendor_id IS NULL) AS no_vendor
         FROM condition_lines cl
        WHERE cl.work_id IS NULL OR cl.document_id IS NULL OR cl.counterparty_vendor_id IS NULL
        ORDER BY cl.id DESC LIMIT ${SAMPLE_LIMIT}`,
    toSample: (r) => {
      const missing = [r.no_work ? "作品" : null, r.no_doc ? "文書" : null, r.no_vendor ? "取引先" : null]
        .filter(Boolean).join("・");
      return { id: num(r.id), label: str(r.condition_name) || `条件#${num(r.id)}`, detail: `未設定: ${missing}`, link: { view: "conditions" } };
    }
  },
  {
    key: "works-without-materials",
    label: "素材未登録の作品",
    description: "有効な作品のうち構成素材が1件も登録されていないもの",
    severity: "medium",
    countSql: `SELECT count(*) AS c FROM works w
       WHERE COALESCE(w.is_active, true) = true
         AND NOT EXISTS (SELECT 1 FROM work_materials wm WHERE wm.work_id = w.id)`,
    sampleSql: `SELECT w.id, w.work_code, w.title FROM works w
        WHERE COALESCE(w.is_active, true) = true
          AND NOT EXISTS (SELECT 1 FROM work_materials wm WHERE wm.work_id = w.id)
        ORDER BY w.id DESC LIMIT ${SAMPLE_LIMIT}`,
    toSample: (r) => ({ id: num(r.id), label: str(r.title) || `作品#${num(r.id)}`, detail: str(r.work_code), link: { view: "works", id: num(r.id) } })
  },
  {
    key: "materials-without-rights",
    label: "権利ソース未登録の素材",
    description: "ロイヤリティ対象なのに権利ソースが未登録の素材",
    severity: "medium",
    countSql: `SELECT count(*) AS c FROM work_materials wm
       WHERE wm.is_royalty_bearing = true
         AND NOT EXISTS (SELECT 1 FROM material_rights_sources mrs WHERE mrs.material_id = wm.id)`,
    sampleSql: `SELECT wm.id, wm.material_code, wm.material_name, wm.work_id FROM work_materials wm
        WHERE wm.is_royalty_bearing = true
          AND NOT EXISTS (SELECT 1 FROM material_rights_sources mrs WHERE mrs.material_id = wm.id)
        ORDER BY wm.id DESC LIMIT ${SAMPLE_LIMIT}`,
    toSample: (r) => ({ id: num(r.id), label: str(r.material_name) || `素材#${num(r.id)}`, detail: str(r.material_code), link: { view: "works", id: num(r.work_id) } })
  },
  {
    key: "unreceived-receipts",
    label: "未受領（報告済）",
    description: "売上報告済だが入金未確認の受領記録",
    severity: "low",
    countSql: `SELECT count(*) AS c FROM condition_receipts WHERE received_amount IS NULL`,
    sampleSql: `SELECT cr.id, cr.period, cr.computed_royalty_ex_tax FROM condition_receipts cr
        WHERE cr.received_amount IS NULL ORDER BY cr.id DESC LIMIT ${SAMPLE_LIMIT}`,
    toSample: (r) => ({ id: num(r.id), label: str(r.period) || `受領#${num(r.id)}`, detail: `試算 ¥${new Intl.NumberFormat("ja-JP").format(num(r.computed_royalty_ex_tax))}`, link: { view: "billing" } })
  },
  {
    key: "duplicate-vendors",
    label: "取引先の重複候補",
    description: "正規化名が一致する取引先（名寄せ候補）",
    severity: "medium",
    countSql: `SELECT count(*) AS c FROM (
         SELECT lower(btrim(vendor_name)) AS n FROM vendors
          WHERE COALESCE(btrim(vendor_name), '') <> ''
          GROUP BY lower(btrim(vendor_name)) HAVING count(*) > 1) d`,
    sampleSql: `SELECT min(id) AS id, lower(btrim(vendor_name)) AS norm, count(*) AS c FROM vendors
        WHERE COALESCE(btrim(vendor_name), '') <> ''
        GROUP BY lower(btrim(vendor_name)) HAVING count(*) > 1
        ORDER BY count(*) DESC LIMIT ${SAMPLE_LIMIT}`,
    toSample: (r) => ({ id: num(r.id), label: str(r.norm), detail: `${num(r.c)}件が重複`, link: { view: "vendor-merge" } })
  }
];

export class PgDataQualityRepository implements DataQualityRepository {
  constructor(private readonly database: DatabasePool) {}

  async scan(): Promise<QualityReport> {
    const categories = await Promise.all(SCANS.map((def) => this.runScan(def)));
    return summarizeQuality(categories);
  }

  private async runScan(def: ScanDef): Promise<QualityCategory> {
    try {
      const [countResult, sampleResult] = await Promise.all([
        this.database.query(def.countSql, []),
        this.database.query(def.sampleSql, [])
      ]);
      return {
        key: def.key, label: def.label, description: def.description, severity: def.severity,
        available: true,
        count: num(countResult.rows[0]?.c),
        samples: sampleResult.rows.map(def.toSample)
      };
    } catch (error) {
      if (degradable(error)) {
        return {
          key: def.key, label: def.label, description: def.description, severity: def.severity,
          available: false, count: 0, samples: []
        };
      }
      throw error;
    }
  }
}

// テスト・DB非依存起動用。プリセットのカテゴリ配列を集計して返す。
export class MemoryDataQualityRepository implements DataQualityRepository {
  constructor(private readonly categories: QualityCategory[] = []) {}
  async scan(): Promise<QualityReport> {
    return summarizeQuality(this.categories);
  }
}
