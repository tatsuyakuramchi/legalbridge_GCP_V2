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
import { isRoyaltyStatementKey } from "./settlement-docs.js";

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
  if (templateKey !== "inspection_certificate" && templateKey !== "intl_inspection_certificate"
      && templateKey !== "service_completion_notice") return false;
  if (!INSPECTION_FALLBACK_FIELDS.has(fieldName)) return false;
  const lines = values.delivery_line_items;
  return Array.isArray(lines) && lines.length > 0;
}

/**
 * 利用許諾料計算書の計算欄。
 *
 * V1 はここを人が打てた（電卓で出した金額を紙に写す運用）。V3 の計算書は
 * 条件と実績から試算して出すので、打たせる意味が無い。打った値は本文に
 * 差さるので、データベースの計算書と紙の金額が食い違う余地にもなる。
 * 42 項目のうち 22 項目がこれで、宣言をそのまま並べると「金額を全部手で
 * 入れてください」という画面になっていた。
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
  templateKey: string, fieldName: string, _values: Record<string, unknown>
): boolean {
  if (!isRoyaltyStatementKey(templateKey)) return false;
  // 試算があるかどうかに依らず隠す。V3 の計算書は必ず条件と実績から出るので、
  // 試算がまだ無い段階（ひな形を選んだ直後）でも、人が入れる欄ではない。
  return ROYALTY_COMPUTED_FIELDS.has(fieldName);
}

/**
 * 相手先の代表者の欄。法人にしか無いので、相手先が個人のときは必須から外す。
 * 個人の許諾者・受託者に「代表者名」を要求すると、入力しようのない必須項目で止まる。
 *
 * 以前は license_master の 2 項目だけを名指ししていた。ひな形ごとに欄の名前が違う
 * （Licensor_代表者名・代表者氏名・受託者代表者 …）ので、名前の組で見る。
 * 個人でも代理人などを代表者として登録してあれば（__counterpartyHasRep）欄は出す（必須にはしない）。
 */
/** 契約書の当事者欄の代表者（個人は本人で埋めない。登録が無ければ欄ごと出さない）。 */
const PARTY_BLOCK_REP_FIELDS: ReadonlySet<string> = new Set([
  "VENDOR_REP", "VENDOR_REPRESENTATIVE", "VENDOR_REPRESENTATIVE_SAMA", "LICENSOR_REP", "LICENSOR_REPRESENTATIVE",
  "Licensor_代表者名", "代表者氏名", "代表者名様", "許諾者代表者", "受託者代表者", "representativeName"
]);
/** 代表者の肩書・1 行（取引先に登録した代表者から出る。個人は無い）。 */
const REP_TITLE_FIELDS: ReadonlySet<string> = new Set([
  "VENDOR_REPRESENTATIVE_LINE", "VENDOR_REPRESENTATIVE_TITLE", "代表者行", "代表者肩書",
  "受託者代表者行", "受託者代表者肩書", "representativeLine", "representativeTitle"
]);
/** 検収書などの「受託者代表者名」。個人は本人の名前で出す（そのままでよい）が、必須にはしない。 */
const REP_NAME_FIELDS: ReadonlySet<string> = new Set(["受託者代表者名", "相手先代表者", "counterpartyRep"]);

/** 相手先の代表者の欄か（当事者欄・肩書・検収書の代表者名）。 */
export const isCounterpartyRepField = (fieldName: string): boolean =>
  PARTY_BLOCK_REP_FIELDS.has(fieldName) || REP_TITLE_FIELDS.has(fieldName) || REP_NAME_FIELDS.has(fieldName);

/** 相手先が個人で、この欄が代表者の欄（必須にしない）。 */
export function isRepOfIndividual(fieldName: string, values: Record<string, unknown>): boolean {
  return values.__counterpartyKind === "individual" && isCounterpartyRepField(fieldName);
}

/** 相手先が個人で、代表者の登録が無いとき、本人の名前で埋めない欄（契約書の当事者欄）。 */
export function isRepLeftBlankForIndividual(fieldName: string, values: Record<string, unknown>): boolean {
  return values.__counterpartyKind === "individual" && values.__counterpartyHasRep !== true
    && PARTY_BLOCK_REP_FIELDS.has(fieldName);
}

/** 個人の相手先の代表者の欄を隠すか。代表者の登録が無いときだけ（あれば出して直せるように）。 */
export function isCorporateOnlyFieldHidden(
  _templateKey: string, fieldName: string, values: Record<string, unknown>
): boolean {
  return values.__counterpartyKind === "individual" && values.__counterpartyHasRep !== true
    && (PARTY_BLOCK_REP_FIELDS.has(fieldName) || REP_TITLE_FIELDS.has(fieldName));
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
