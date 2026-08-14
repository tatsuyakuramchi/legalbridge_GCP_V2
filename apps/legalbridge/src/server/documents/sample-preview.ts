import type { TemplateField } from "../../types.js";

// ひな形プレビュー（V1 search-api /templates/preview 相当）のサンプルデータ生成。
// V1 shared-rendering.mjs の buildSampleData / sampleValueForField の移植（純関数）。
// 事業部担当者が「この契約書はどんな文面か」をフォーム入力なしで確認する用途のため、
// 各項目にそれらしい記入例を流し込む。placeholder の「例: 」があれば最優先で使う。

type Data = Record<string, unknown>;

// 一覧・直リンクとも非表示にするテンプレ（V1 の HIDDEN_PREVIEW_TYPES と同じ考え方）。
//   individual_license_terms    … v3 に置き換え済みの旧版（V1 でも非表示）
//   individual_license_terms_v3 … 専用サンプル（conds/lcs マトリクス）が必要で
//                                 汎用生成では意味のある文面にならないため当面除外。
export const SAMPLE_HIDDEN_KEYS = new Set([
  "individual_license_terms",
  "individual_license_terms_v3"
]);

export interface SampleVariant {
  id: string;
  label: string;
  overrides: Data;
}

const DEFAULT_VARIANT: SampleVariant[] = [{ id: "default", label: "サンプル", overrides: {} }];

// IGLA は Deal Sheet の取引モデルで Schedule 1/2（付属書側は Annex 3・ティア表）の
// 出力が切り替わるため、サンプルも取引モデル別に2通り提示する。
const IGLA_VARIANTS: SampleVariant[] = [
  {
    id: "license-out",
    label: "License-Out（先方製造）",
    overrides: { TRANSACTION_MODEL: "License-Out", EXCLUSIVITY: "Exclusive", ROYALTY_BASE: "Net Sales" }
  },
  {
    id: "product-out",
    label: "Product-Out（自社製造・供給）",
    overrides: { TRANSACTION_MODEL: "Product-Out", EXCLUSIVITY: "Exclusive", PRICING_METHOD: "Variable" }
  }
];

export function sampleVariantsFor(templateKey: string): SampleVariant[] {
  if (templateKey === "igla_license_en" || templateKey === "igla_license_annex_en") {
    return IGLA_VARIANTS;
  }
  return DEFAULT_VARIANT;
}

// V1 と同じ発想の項目名ヒューリスティック。型情報（field_schema）を最優先し、
// 名前に含まれる語で日付・金額・住所などのそれらしい値を返す。
export function sampleValueForField(fieldId: string, def?: TemplateField): unknown {
  const id = String(fieldId || "");
  const upper = id.toUpperCase();
  const label = String(def?.label || "");
  const placeholder = String(def?.placeholder || "");
  if (def?.type === "boolean") return true;
  if (def?.type === "number") {
    if (upper.includes("DAYS")) return 10;
    if (upper.includes("YEARS")) return 5;
    if (upper.includes("RATE")) return 10;
    if (upper.includes("AMOUNT") || upper.includes("TOTAL") || label.includes("金額")) return 100000;
    return 1;
  }
  if (def?.type === "select" && Array.isArray(def.options) && def.options.length > 0) {
    return def.options[0];
  }
  // placeholder の記入例（「例: 」形式）はテンプレ作者が用意した最良のサンプル。
  if (placeholder) return placeholder.replace(/^例[:：]\s*/, "");
  if (upper.includes("CONTRACT_NO") || upper.includes("ORDER_NO")) return "SAMPLE-2026-0001";
  if (upper.includes("CONTRACT_DATE_FORMATTED")) return "2026年5月24日";
  if (upper.includes("DATE")) return "2026-05-24";
  if (upper.includes("PARTY_B_NAME") || upper.includes("VENDOR_NAME") || upper.includes("LICENSEE_NAME")) {
    return "サンプル株式会社";
  }
  if (upper.includes("ADDRESS")) return "東京都千代田区サンプル1-2-3";
  if (upper.includes("REPRESENTATIVE") || upper.includes("_REP")) return "代表取締役 山田 太郎";
  if (upper.includes("EMAIL")) return "sample@example.com";
  if (upper.includes("PHONE") || upper.includes("TEL")) return "03-1234-5678";
  if (upper.includes("JURISDICTION")) return "東京地方裁判所";
  if (upper.includes("PAYMENT")) return "月末締め翌月末日払い";
  if (upper.includes("DELIVERY_LOCATION")) return "甲指定倉庫";
  if (upper.includes("PRODUCT_SCOPE")) return "アナログゲーム製品および関連商品";
  if (upper.includes("WARRANTY_PERIOD")) return "引渡し後1年";
  if (upper.includes("SPECIAL_TERMS") || upper.includes("REMARKS") || upper.includes("NOTES")) {
    return "本欄はサンプル表示です。実運用では案件に応じて編集してください。";
  }
  if (label) return `${label}サンプル`;
  return `[${id}]`;
}

// html 中の {{VAR}}（単純参照のみ）を拾い、schema に無い変数にもサンプルを与える。
// ヘルパー呼び出し・ブロック（{{#if}} 等）・パーシャルは対象外。
export function extractTemplateVariables(html: string): string[] {
  const found = new Set<string>();
  const pattern = /\{\{\s*([A-Za-z0-9_぀-ヿ一-鿿]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (!["if", "unless", "else", "each", "with", "this"].includes(match[1])) found.add(match[1]);
  }
  return [...found];
}

// field_schema + html からサンプル formData を構築する（汎用）。
// overrides はバリアント（IGLA の取引モデル別など）の明示値で最後に上書き。
export function buildSampleFormData(
  fields: TemplateField[],
  htmlSource: string,
  label: string,
  overrides: Data = {}
): Data {
  const defs = new Map<string, TemplateField>();
  for (const field of fields ?? []) if (field?.name) defs.set(field.name, field);
  const names = new Set([...defs.keys(), ...extractTemplateVariables(htmlSource ?? "")]);
  const data: Data = {};
  for (const name of names) data[name] = sampleValueForField(name, defs.get(name));

  // 明細系テンプレ（発注書・検収書・計算書）の配列サンプル（V1 と同等）。
  Object.assign(data, {
    items: [
      { item_name: "サンプル品目A", spec: "仕様A", quantity: 10, unit_price: 10000, amount: 100000, remarks: "サンプル明細" },
      { item_name: "サンプル品目B", spec: "仕様B", quantity: 5, unit_price: 20000, amount: 100000, remarks: "" }
    ],
    order_lines: [
      { line_no: 1, item_name: "サンプル品目A", spec: "仕様A", quantity: 10, unit_price: 10000, amount_ex_tax: 100000 },
      { line_no: 2, item_name: "サンプル品目B", spec: "仕様B", quantity: 5, unit_price: 20000, amount_ex_tax: 100000 }
    ],
    delivery_line_items: [
      { line_no: 1, item_name: "サンプル成果物A", spec: "仕様A", inspected_quantity: 10, acceptance_ratio: 1, inspected_amount_ex_tax: 100000 }
    ],
    expenses: [
      { line_no: 1, expense_name: "サンプル経費", spent_date: "2026-05-24", amount_inc_tax: 11000, remarks: "交通費" }
    ]
  });

  Object.assign(data, overrides);

  const documentNumber = String(
    data.CONTRACT_NO || data.ORDER_NO || data.DOC_NO || "SAMPLE-2026-0001"
  );
  return {
    issueKey: "SAMPLE-1",
    documentNumber,
    summary: `${label || ""} サンプル`,
    requester: "LegalBridge Sample",
    ...data
  };
}
