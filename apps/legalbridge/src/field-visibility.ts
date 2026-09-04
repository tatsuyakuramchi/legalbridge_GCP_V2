import type { DocumentFormData, ShowWhenCondition } from "./types.js";
import { hasEntityType, isIndividualEntity } from "./honorific.js";

// showWhen を持つものなら何でも判定できる（テンプレート項目でも、明細1行の列でも）。
type ConditionallyVisible = { showWhen?: ShowWhenCondition | ShowWhenCondition[] };

// truthy 判定の「値がある」。空配列は JS では真だが、明細0件を「明細あり」と
// 判定してしまうため件数で見る（発注書の単一明細フォールバックの出し分けに必要）。
function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

// showWhen（field_schema の条件表示）の判定。純関数。
// - anyOf: 参照先の値（文字列化）がいずれかに一致すれば表示
// - truthy: 参照先に値があるか／無いかと一致すれば表示
// - 配列: すべての条件を満たしたときだけ表示（AND）
// - 条件なし・不正な条件は常に表示（テンプレートの書き損じで項目が消えないように）
function matches(condition: ShowWhenCondition, formData: DocumentFormData): boolean {
  if (!condition?.field) return true;
  const value = formData[condition.field];
  if (Array.isArray(condition.anyOf)) {
    return condition.anyOf.includes(String(value ?? ""));
  }
  if (typeof condition.truthy === "boolean") {
    return hasValue(value) === condition.truthy;
  }
  return true;
}

// 検収書の単票フォールバック項目（IV. 納品明細の成果物・仕様・金額3欄）。
// テンプレートは検収明細（delivery_line_items）が1行でもあればそちらを描画し、
// 金額もサーバ側で明細から計算する。そのため明細があるときにこれらを出すと
// 「入力しても使われない項目」になる（必須マーク付きで混乱を招いていた）。
// 税率（taxRate）と軽減税率（isReducedTax）は明細モードでも使うので残す。
const INSPECTION_FALLBACK_FIELDS = new Set([
  "description", "spec", "deliveredAmountStr", "taxAmountStr", "totalAmountStr",
  // 進捗（検収率・検収済額・発注総額・未検収額）は明細の状態から自動計算する
  // （V. 進捗・財務の手入力欄は旧フォームの名残。明細があるときは計算値が優先）。
  "inspectedPct", "inspectedAmountStr", "totalOrderAmountStr", "pendingAmountStr"
]);

export function isInspectionFallbackFieldHidden(
  templateKey: string, fieldName: string, formData: DocumentFormData
): boolean {
  if (templateKey !== "inspection_certificate") return false;
  if (!INSPECTION_FALLBACK_FIELDS.has(fieldName)) return false;
  const lines = formData.delivery_line_items;
  return Array.isArray(lines) && lines.length > 0;
}

// 利用許諾料計算書: 構造化入力（rs*）が有効なあいだは、エンジンが組み立てる
// 計算系フィールド（グロス・MG/AG・合計等）と実績の生値をスキーマ側から隠す。
// 入力しても構造化入力の計算で上書きされる＝「入力しても使われない項目」になるため。
// 旧下書き（構造化入力なし）ではそのまま出て、従来どおり手で直せる。
const ROYALTY_COMPUTED_FIELDS = new Set([
  "calcType", "statementMode", "msrpStr", "quantity", "sampleQuantity",
  "billableQuantity", "royaltyRatePct", "grossRoyaltyStr",
  "mgAmount", "mgAmountStr", "mgTopupApplied", "mgTopupThisTime", "mgTopupThisTimeStr",
  "mgRemaining", "mgConsumedBefore", "mgConsumedThisTime", "mgConsumedAfter", "mgFullyConsumed",
  "agAmount", "agAmountStr", "agApplied", "agConsumedBefore", "agConsumedBeforeStr",
  "agConsumedThisTime", "agConsumedThisTimeStr", "agConsumedAfter", "agConsumedAfterStr",
  "agRemaining", "agRemainingStr", "agFullyConsumed", "agProgressPct",
  "actualRoyalty", "actualRoyaltyStr", "taxAmount", "totalPaymentStr",
  "intakeCurrency", "fxRate", "linesTotalSalesStr", "linesTotalPaymentStr",
  "linesTaxStr", "linesTotalIncTaxStr"
]);

export function isRoyaltyStructuredActive(formData: DocumentFormData): boolean {
  const receipts = formData.rs_receipts;
  if (String(formData.statementMode) === "multi" && Array.isArray(receipts) && receipts.length > 0) return true;
  // 束ね（複数契約）: 基準額の入った契約が1件でもあれば計算欄は自動（手入力欄を隠す）。
  const bundle = formData.rs_bundle;
  if (String(formData.statementMode) === "bundle" && Array.isArray(bundle)
    && bundle.some((row) => Number(String((row as Record<string, unknown>)?.msrp ?? "").replace(/,/g, "")) > 0)) return true;
  const msrp = Number(String(formData.rsMsrp ?? "").replace(/,/g, ""));
  return Boolean(formData.rsCalcType) && Number.isFinite(msrp) && msrp > 0;
}

export function isRoyaltyComputedFieldHidden(
  templateKey: string, fieldName: string, formData: DocumentFormData
): boolean {
  if (templateKey !== "royalty_statement") return false;
  if (!ROYALTY_COMPUTED_FIELDS.has(fieldName)) return false;
  return isRoyaltyStructuredActive(formData);
}

// 基本契約の「法人にしか無い項目」。相手方（許諾者）が個人のときは非表示にし、
// 必須チェックからも外す。license_master は VENDOR_REP（ライセンサー代表者）が
// スキーマ上必須のため、個人ライセンサーだと入力しようのない必須項目で確定が
// 塞がっていた。区分はマスタ引用が formData に記録する（vendorEntityType 等）。
// 区分が未入力（マスタを使わず手入力）のときは従来どおり必須のまま。
const CORPORATE_ONLY_FIELDS: Record<string, ReadonlySet<string>> = {
  license_master: new Set(["VENDOR_REP", "VENDOR_REPRESENTATIVE_SAMA"])
};
const VENDOR_ENTITY_KEYS = [
  "VENDOR_MASTER_ENTITY_TYPE", "VENDOR_IS_CORPORATION", "取引先種別", "vendorEntityType"
] as const;

export function isCorporateOnlyFieldHidden(
  templateKey: string, fieldName: string, formData: DocumentFormData
): boolean {
  const fields = CORPORATE_ONLY_FIELDS[templateKey];
  if (!fields?.has(fieldName)) return false;
  for (const key of VENDOR_ENTITY_KEYS) {
    const value = formData[key];
    if (hasEntityType(value)) return isIndividualEntity(value);
  }
  return false;
}

export function isFieldVisible(field: ConditionallyVisible, formData: DocumentFormData): boolean {
  const condition = field.showWhen;
  if (!condition) return true;
  if (Array.isArray(condition)) return condition.every((c) => matches(c, formData));
  return matches(condition, formData);
}
