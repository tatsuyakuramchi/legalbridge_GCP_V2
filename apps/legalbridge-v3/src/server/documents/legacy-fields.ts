/**
 * ひな形の項目のうち「人に入力させてはいけないもの」を落とす。
 *
 * V1 の field_schema は hidden / readonly / showWhen / dbField を持っていて、
 * 画面はそれを見て出す項目を決めていた（field-visibility.ts）。V3 は移行のとき
 * field_schema をそのまま variables に移したのに、読むのは name / label /
 * required だけだったので、
 *   ・計算で埋まる欄（消費税額・合計額）まで「必須の手入力」として要求する
 *   ・使わない側の分岐の欄（showWhen で隠れるはず）も要求する
 * ということが起きていた。検収書1枚に8項目という数字はこれが原因。
 */

export interface ShowWhenCondition {
  field: string;
  anyOf?: string[];
  truthy?: boolean;
}

export interface LegacyFieldMeta {
  hidden?: boolean;
  readonly?: boolean;
  showWhen?: ShowWhenCondition | ShowWhenCondition[];
}

/** 空配列を「値あり」にしない。明細0件は「明細なし」。 */
const hasValue = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : Boolean(value);

function matches(condition: ShowWhenCondition, values: Record<string, unknown>): boolean {
  if (!condition?.field) return true;
  const value = values[condition.field];
  if (Array.isArray(condition.anyOf)) return condition.anyOf.includes(String(value ?? ""));
  if (typeof condition.truthy === "boolean") return hasValue(value) === condition.truthy;
  return true;
}

/** showWhen の判定。条件なし・書き損じは常に表示（項目が黙って消えないように）。 */
export function isFieldVisible(field: LegacyFieldMeta, values: Record<string, unknown>): boolean {
  const condition = field.showWhen;
  if (!condition) return true;
  if (Array.isArray(condition)) return condition.every((c) => matches(c, values));
  return matches(condition, values);
}

/**
 * 検収書の単票フォールバック欄。明細が1行でもあれば本文は明細を描き、金額も
 * 明細から計算する。明細があるのにこれらを要求すると「入力しても使われない
 * 必須項目」になる。税率だけは明細モードでも使うので残す。
 */
const INSPECTION_FALLBACK_FIELDS = new Set([
  "description", "spec", "deliveredAmountStr", "taxAmountStr", "totalAmountStr",
  "inspectedPct", "inspectedAmountStr", "totalOrderAmountStr", "pendingAmountStr"
]);

export function isInspectionFallbackFieldHidden(
  templateKey: string, fieldName: string, values: Record<string, unknown>
): boolean {
  if (templateKey !== "inspection_certificate") return false;
  if (!INSPECTION_FALLBACK_FIELDS.has(fieldName)) return false;
  const lines = values.delivery_line_items;
  return Array.isArray(lines) && lines.length > 0;
}

/**
 * 利用許諾料計算書の計算欄。試算の結果で埋まるので、試算があるあいだは
 * 手入力に回さない。入力しても計算で上書きされる。
 */
const ROYALTY_COMPUTED_FIELDS = new Set([
  "calcType", "statementMode", "msrpStr", "quantity", "sampleQuantity",
  "billableQuantity", "royaltyRatePct", "grossRoyaltyStr",
  "mgAmount", "mgAmountStr", "mgTopupApplied", "mgTopupThisTime", "mgTopupThisTimeStr",
  "mgRemaining", "mgConsumedBefore", "mgConsumedThisTime", "mgConsumedAfter",
  "mgFullyConsumed", "mgProgressPct",
  "agAmount", "agAmountStr", "agApplied", "agConsumedBefore", "agConsumedBeforeStr",
  "agConsumedThisTime", "agConsumedThisTimeStr", "agConsumedAfter", "agConsumedAfterStr",
  "agRemaining", "agRemainingStr", "agFullyConsumed", "agProgressPct",
  "actualRoyalty", "actualRoyaltyStr", "taxAmount", "totalPaymentStr",
  "intakeCurrency", "fxRate", "linesTotalSalesStr", "linesTotalPaymentStr",
  "linesTaxStr", "linesTotalIncTaxStr"
]);

export function isRoyaltyComputedFieldHidden(
  templateKey: string, fieldName: string, values: Record<string, unknown>
): boolean {
  if (templateKey !== "royalty_statement") return false;
  if (!ROYALTY_COMPUTED_FIELDS.has(fieldName)) return false;
  // V3 は試算の結果を royalty として渡す。あるなら計算欄は自動。
  return Boolean(values.__hasRoyalty);
}

/**
 * 法人にしか無い項目。相手先が個人のときは必須から外す。
 * 個人の許諾者に「代表者名」を要求すると、入力しようのない必須項目で止まる。
 */
const CORPORATE_ONLY_FIELDS: Record<string, ReadonlySet<string>> = {
  license_master: new Set(["VENDOR_REP", "VENDOR_REPRESENTATIVE_SAMA"])
};

export function isCorporateOnlyFieldHidden(
  templateKey: string, fieldName: string, values: Record<string, unknown>
): boolean {
  const fields = CORPORATE_ONLY_FIELDS[templateKey];
  if (!fields?.has(fieldName)) return false;
  const kind = values.__counterpartyKind;
  if (kind !== "individual" && kind !== "corporate") return false;
  return kind === "individual";
}

/** その項目を人に入力させるか。false なら必須判定からも外す。 */
export function isFieldRequested(
  templateKey: string,
  field: { name: string } & LegacyFieldMeta,
  values: Record<string, unknown>
): boolean {
  if (field.hidden === true) return false;
  if (!isFieldVisible(field, values)) return false;
  if (isInspectionFallbackFieldHidden(templateKey, field.name, values)) return false;
  if (isRoyaltyComputedFieldHidden(templateKey, field.name, values)) return false;
  if (isCorporateOnlyFieldHidden(templateKey, field.name, values)) return false;
  return true;
}
