// 文書確定時の条件明細（condition_lines）同期 — 純関数部。
// V1 documentSave.ts（mapV3MatrixToConditions / toConditionInput）の移植。
// 利用許諾条件書（v3マトリクス）・発注書等の financial_conditions を CL 入力行へ変換する。
// これが無いと、画面から発行した条件書の経済条件（料率・MG/AG・地域言語）が
// form_data（PDF用）にしか残らず、条件明細一覧・ライセンスマトリクス・消化管理に現れない。

import type { DocumentFormData } from "../../types.js";

export interface ConditionRegionLanguage { code: string | null; name: string }

/** 1条件（=CL 1行）の入力。V1 ConditionInput のうち V2 が書く列のサブセット。 */
export interface ConditionSyncInput {
  line_no: number;
  group_no?: number | null;
  material_code?: string | null;      // work_materials.material_code で結線（addon セル）
  source_work_id?: number | null;
  direction: "payable" | "receivable";
  payment_scheme?: string | null;     // 空なら導出（料率あり=royalty / 無し=lump_sum）
  rate_pct?: unknown; mg_amount?: unknown; ag_amount?: unknown;
  currency?: string | null;
  base_price_label?: string | null;
  calc_type?: string | null; fixed_kind?: string | null; subscription_cycle?: string | null;
  unit_amount?: unknown;
  guarantee_type?: string | null;
  region_territory?: string | null; region_language?: string | null;
  regions?: ConditionRegionLanguage[];      // undefined なら子テーブルは触らない
  languages?: ConditionRegionLanguage[];
  applies_scope?: string | null; formula_text?: string | null; payment_terms?: string | null;
  condition_name?: string | null;
  is_addon: boolean;
  manufacturer?: string | null; seller?: string | null;
  max_region?: string | null; max_language?: string | null;
}

const s = (v: unknown): string | null =>
  v == null || String(v).trim() === "" ? null : String(v);

export const num = (v: unknown): number | null => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// 選択式 regions/languages(Opt[]) を子テーブル書込み用に正規化（V1 rlArr）。
//   name 空は除外、code 空文字は null(=name-only)。配列以外は undefined（子テーブル不変）。
function rlArr(arr: unknown): ConditionRegionLanguage[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  return arr
    .map((o) => {
      const item = (o ?? {}) as { code?: unknown; name?: unknown };
      return { code: item.code ? String(item.code) : null, name: String(item.name ?? "").trim() };
    })
    .filter((o) => o.name !== "");
}

// region_territory/language の結合文字列 → name のみの配列（V1 normalizeRL の文字列側）。
export function splitRegionLanguage(value: string | null | undefined): ConditionRegionLanguage[] {
  const text = String(value ?? "").trim();
  if (!text) return [];
  return text.split(/[・、,\/／]/).map((x) => x.trim()).filter(Boolean)
    .map((name) => ({ code: null, name }));
}

/** payment_scheme 導出（V1 derivePaymentScheme）。 */
export function derivePaymentScheme(c: Pick<ConditionSyncInput, "payment_scheme" | "rate_pct">): string {
  const scheme = String(c.payment_scheme ?? "").trim();
  if (scheme) return scheme;
  return num(c.rate_pct) != null ? "royalty" : "lump_sum";
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    : [];
}

/**
 * v3 マトリクス（取引形態×構成要素LC）→ CL 入力へ（V1 mapV3MatrixToConditions の移植）。
 *   加算型: 取引形態(group)ごとに料率を持つ各LCを1行へ（group_no で束ね・mg/ag は先頭のみ）。
 *   非加算型: 取引形態ごとに1本（実効料率 fixedRate）。line_no は 4000+（他タイプと非衝突）。
 */
export function mapV3MatrixToConditions(
  v3Conds: unknown, v3Lcs: unknown, direction: "payable" | "receivable" = "payable"
): ConditionSyncInput[] {
  const conds = records(v3Conds);
  const lcs = records(v3Lcs);
  const out: ConditionSyncInput[] = [];
  let lineSeq = 4000;
  conds.forEach((c, gi) => {
    const groupNo = gi + 1;
    const key = String(c.id ?? "");
    const header = {
      group_no: groupNo,
      direction,
      condition_name: s(c.name),
      base_price_label: s(c.basePrice),
      region_territory: s(c.reg),
      region_language: s(c.lang),
      regions: rlArr(c.regions),
      languages: rlArr(c.languages),
      currency: s(c.cur) ?? "JPY",
      manufacturer: s(c.manufacturer),
      seller: s(c.seller),
      max_region: s(c.maxReg),
      max_language: s(c.maxLang)
    };
    if (c.addon) {
      const cells = lcs
        .map((lc) => ({ lc, rate: (lc.rates as Record<string, unknown> | undefined)?.[key] }))
        .filter((x) => x.rate != null && String(x.rate).trim() !== "");
      cells.forEach((cell, k) => {
        out.push({
          ...header,
          line_no: ++lineSeq,
          is_addon: true,
          payment_scheme: "royalty",
          material_code: s(cell.lc.material_code),
          rate_pct: cell.rate,
          mg_amount: k === 0 ? c.mg : null,   // 代表（先頭LC）のみ
          ag_amount: k === 0 ? c.ag : null
        });
      });
    } else {
      out.push({
        ...header,
        line_no: ++lineSeq,
        is_addon: false,
        payment_scheme: "royalty",
        material_code: null,
        rate_pct: c.fixedRate,
        mg_amount: c.mg,
        ag_amount: c.ag
      });
    }
  });
  return out;
}

/** financial_conditions（発注書・条件書の金銭条件エディタ）→ CL 入力（V1 toConditionInput 相当）。 */
export function mapFinancialConditions(
  value: unknown, direction: "payable" | "receivable" = "payable"
): ConditionSyncInput[] {
  return records(value).map((fc, idx) => ({
    line_no: Number(num(fc.condition_no) ?? idx + 1),
    group_no: num(fc.group_no),
    material_code: s(fc.material_code),
    source_work_id: num(fc.source_work_id),
    direction,
    payment_scheme: null,   // 導出（料率→royalty / 他→lump_sum）
    rate_pct: fc.rate_pct,
    mg_amount: fc.mg_amount,
    ag_amount: fc.ag_amount,
    currency: s(fc.currency) ?? "JPY",
    base_price_label: s(fc.base_price_label),
    calc_type: s(fc.calc_type),
    fixed_kind: s(fc.fixed_kind),
    subscription_cycle: s(fc.subscription_cycle),
    unit_amount: fc.unit_amount,
    guarantee_type: s(fc.guarantee_type),
    region_territory: s(fc.region_territory),
    region_language: s(fc.region_language),
    regions: rlArr(fc.regions),
    languages: rlArr(fc.languages),
    applies_scope: s(fc.applies_scope),
    formula_text: s(fc.formula_text),
    payment_terms: s(fc.payment_terms),
    condition_name: s(fc.condition_name),
    is_addon: Boolean(fc.is_addon),
    manufacturer: s(fc.manufacturer),
    seller: s(fc.seller),
    max_region: s(fc.max_region),
    max_language: s(fc.max_language)
  }));
}

/**
 * 文書の form_data から同期すべき CL 入力の全量を組み立てる。
 * データ駆動（financial_conditions か v3_conds があるものだけ）＝テンプレ種別に依存しない。
 * flow_direction が "out"（自社が許諾する側）なら receivable、それ以外は payable（V1 dirFromFlow）。
 */
export function buildDocumentConditionInputs(formData: DocumentFormData): ConditionSyncInput[] {
  const direction: "payable" | "receivable" =
    String(formData.flow_direction ?? "").toLowerCase() === "out" ? "receivable" : "payable";
  return [
    ...mapFinancialConditions(formData.financial_conditions, direction),
    ...mapV3MatrixToConditions(formData.v3_conds, formData.v3_lcs, direction)
  ];
}

/** 同期対象データを持つ文書か（確定フローが同期を試みるかの判定）。 */
export function hasConditionSyncData(formData: DocumentFormData): boolean {
  return records(formData.financial_conditions).length > 0 || records(formData.v3_conds).length > 0;
}
