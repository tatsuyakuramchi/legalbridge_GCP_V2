/**
 * 権利の使い方（利用形態）と、その形の算定基礎。
 *
 * 利用許諾料計算書は「作者から取った権利（イン条件）に対して払うもの」で、
 * 料率はイン条件が決める。実績はその権利をどう使ったかの記録になる。
 * 使い方は3つあり、要る数字が違う。
 *
 *   自社製造・自社販売 … アウト条件なし。基準価格 × 個数
 *   再許諾            … アウト条件あり。受領価格（期間の合計）
 *   自社製造・他社販売 … アウト条件あり。受領価格（1個）× 製造個数
 *
 * これまで計算書は「実績を載せた条件そのものの計算方式（pricing_model）」で
 * 分岐していた。つまりイン条件の料率とアウト条件の実績を組み合わせられず、
 * 再許諾の実績はイン条件に載せられなかった（載せると料率が条件のもので、
 * 相手ごとの違いが出せない）。分岐の軸を「条件の計算方式」から
 * 「その回の使い方」へ移す。
 *
 * 見本（サンプル）は製造から引く。作者に払うのは売る分だけ、というのが
 * V1 からの決まりで、紙にも「N個 × 基準価格」と出る。
 */

import { DomainError } from "../core/errors.js";

export type UsageType = "in_house" | "sublicense" | "oem";

export interface UsageTypeSpec {
  value: UsageType;
  label: string;
  /** 紙の methodLabel。本文がそのまま印字する。 */
  methodLabel: string;
  /** アウト条件（相手へ許諾した条件）が要るか。 */
  needsOutCondition: boolean;
  /** 画面に出す欄。ここに無い欄は、その形では使わない。 */
  fields: Array<"unitAmount" | "quantity" | "sampleQuantity" | "grossAmount">;
  hint: string;
}

export const USAGE_TYPES: UsageTypeSpec[] = [
  {
    value: "in_house",
    label: "自社製造・自社販売",
    methodLabel: "自社製造・自社販売（基準価格 × 個数）",
    needsOutCondition: false,
    fields: ["unitAmount", "quantity", "sampleQuantity"],
    hint: "自社で作って自社で売る。相手への許諾が無いのでアウト条件は要らない"
  },
  {
    value: "sublicense",
    label: "再許諾",
    methodLabel: "再許諾（受領価格）",
    needsOutCondition: true,
    fields: ["grossAmount"],
    hint: "相手に許諾して、相手から受け取った額が算定の基礎になる"
  },
  {
    value: "oem",
    label: "自社製造・他社販売",
    methodLabel: "自社製造・他社販売（受領価格 × 製造個数）",
    needsOutCondition: true,
    fields: ["unitAmount", "quantity", "sampleQuantity"],
    hint: "自社で作って相手が売る。受領価格は1個あたり"
  }
];

export const usageTypeSpec = (value: unknown): UsageTypeSpec | null =>
  USAGE_TYPES.find((t) => t.value === value) ?? null;

export const usageTypeLabel = (value: unknown): string =>
  usageTypeSpec(value)?.label ?? String(value ?? "");

/** 実績1件が持つ、算定に要る値。 */
export interface UsageBasisInput {
  usageType: UsageType;
  /** 基準価格（自社販売）／受領価格1個あたり（他社販売）。最小通貨単位。 */
  unitAmount?: number | null;
  quantity?: number | null;
  sampleQuantity?: number | null;
  /** 受領価格の合計（再許諾）。最小通貨単位。 */
  grossAmount?: number | null;
}

/**
 * その実績の算定基礎（最小通貨単位）。
 *
 * 足りない数字があれば止める。0 のまま計算すると、金額の入っていない
 * 計算書が番号付きで出る（外貨の換算で実際に起きた）。
 */
export function basisOf(input: UsageBasisInput, tag: string): number {
  if (input.usageType === "sublicense") {
    const gross = Number(input.grossAmount ?? 0);
    if (!(gross > 0)) {
      throw new DomainError("VALIDATION", `${tag}：再許諾は受領価格を入れてください`);
    }
    return Math.round(gross);
  }
  const unit = Number(input.unitAmount ?? 0);
  const quantity = Number(input.quantity ?? 0);
  const sample = Number(input.sampleQuantity ?? 0);
  const priceLabel = input.usageType === "oem" ? "受領価格（1個あたり）" : "基準価格";
  if (!(unit > 0)) throw new DomainError("VALIDATION", `${tag}：${priceLabel}を入れてください`);
  if (!(quantity > 0)) {
    throw new DomainError("VALIDATION",
      `${tag}：${input.usageType === "oem" ? "製造個数" : "個数"}を入れてください`);
  }
  // 見本は作者に払わない。引いた数が0以下なら、その回は算定の対象が無い。
  const billable = Math.max(0, quantity - sample);
  if (billable <= 0) {
    throw new DomainError("VALIDATION", `${tag}：見本を引くと0個になります`);
  }
  return Math.round(unit * billable);
}

/** 紙に出す「どう出した数字か」の一行。 */
export function basisNoteOf(input: UsageBasisInput): string {
  if (input.usageType === "sublicense") return "受領価格";
  const quantity = Number(input.quantity ?? 0);
  const sample = Number(input.sampleQuantity ?? 0);
  const billable = Math.max(0, quantity - sample);
  const price = input.usageType === "oem" ? "受領価格" : "基準価格";
  return sample > 0
    ? `${billable}個（${quantity} − 見本 ${sample}）× ${price}`
    : `${billable}個 × ${price}`;
}

/**
 * 実績の入力がその形として揃っているか。書く前に確かめる。
 *
 * アウト条件の要否もここで見る。再許諾なのに相手が分からない実績を作ると、
 * 計算書に許諾地域が出せず、権利の上限とも照合できない。
 */
export function assertUsageInput(
  input: UsageBasisInput & { outConditionId?: number | null }, tag: string
): void {
  const spec = usageTypeSpec(input.usageType);
  if (!spec) throw new DomainError("VALIDATION", `${tag}：利用形態が分かりません`);
  if (spec.needsOutCondition && !input.outConditionId) {
    throw new DomainError("VALIDATION",
      `${tag}：${spec.label} は許諾したアウト条件を選んでください` +
      "（無ければ 条件明細 で登録してから戻ってきてください）");
  }
  if (!spec.needsOutCondition && input.outConditionId) {
    throw new DomainError("VALIDATION",
      `${tag}：${spec.label} にアウト条件は付きません`);
  }
  basisOf(input, tag);
}
