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

/**
 * 入金区分。契約金と残金で2回に分けて入る契約がある。
 *
 * 区分を持たないと、紙に同じ行が2本並ぶ。「5000個 × 受領価格」が2回出ると、
 * 受け取った側は10,000個作ったと読む。数量は同じ製造ぶんを指しているので、
 * どちらの入金かが行に出ていないと足し算が狂う。
 */
export type PaymentStage = "advance" | "balance";

export const PAYMENT_STAGES: Array<{ value: PaymentStage; label: string }> = [
  { value: "advance", label: "前金" },
  { value: "balance", label: "後金" }
];

export const paymentStageLabel = (value: unknown): string =>
  PAYMENT_STAGES.find((p) => p.value === value)?.label ?? "";

export interface UsageTypeSpec {
  value: UsageType;
  label: string;
  /** 紙の methodLabel。本文がそのまま印字する。 */
  methodLabel: string;
  /** アウト条件（相手へ許諾した条件）が要るか。 */
  needsOutCondition: boolean;
  /** 画面に出す欄。ここに無い欄は、その形では使わない。 */
  fields: Array<"unitAmount" | "quantity" | "sampleQuantity" | "grossAmount">;
  /** 前金・後金に分けられるか。相手のいる形（アウト条件を使う形）だけ。 */
  hasStages: boolean;
  /**
   * 算定の形を行ごとに選べるか。
   * 前金の形は契約による。個数に応じて単価を前金分・後金分に割る契約もあれば、
   * 前金だけ定額で後金が実績払い、という契約もある。
   */
  choosableBasis: boolean;
  hint: string;
}

export const USAGE_TYPES: UsageTypeSpec[] = [
  {
    value: "in_house",
    label: "自社製造・自社販売",
    methodLabel: "自社製造・自社販売（基準価格 × 個数）",
    needsOutCondition: false,
    fields: ["unitAmount", "quantity", "sampleQuantity"],
    hasStages: false, choosableBasis: false,
    hint: "自社で作って自社で売る。相手への許諾が無いのでアウト条件は要らない"
  },
  {
    value: "sublicense",
    label: "再許諾",
    methodLabel: "再許諾（受領価格）",
    needsOutCondition: true,
    fields: ["grossAmount"],
    hasStages: true, choosableBasis: false,
    hint: "相手に許諾して、相手から受け取った額が算定の基礎になる"
  },
  {
    value: "oem",
    label: "自社製造・他社販売",
    methodLabel: "自社製造・他社販売（受領価格 × 製造個数）",
    needsOutCondition: true,
    // 個数×単価でも、受領額そのものでも入れられる。どちらで入れたかは
    // 「単価と個数が入っているか、受領額が入っているか」で読み分ける。
    fields: ["unitAmount", "quantity", "sampleQuantity", "grossAmount"],
    hasStages: true, choosableBasis: true,
    hint: "自社で作って相手が売る。受領額に料率を掛ける（再許諾と同じ計算）。"
        + "個数建ての契約のときだけ算定の形を変える"
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
  /** 受領価格の合計（再許諾、または定額の前金）。最小通貨単位。 */
  grossAmount?: number | null;
  /** 入金区分。前金・後金に分かれる契約で、どちらの入金かを持つ。 */
  paymentStage?: PaymentStage | null;
  /**
   * 受領額・受領価格が税込で入っているか。
   *
   * 受領元が海外なら税込、国内なら税別で報告が来る。許諾料は税別の額に
   * 料率を掛けて出すので、税込のまま掛けると 10% 多く払う。
   * 入っている額はそのまま残し、ここで割り戻す（記録は入金額と一致させる）。
   */
  taxIncluded?: boolean | null;
  /**
   * 算定の形の指定。入力中の画面から渡す。
   *
   * 保存した行は数字から読み分けられるが、入力の途中はまだ数字が揃っていない。
   * 「受領額 × 料率」を選んだ直後の空の行を数字から読むと、選んだ形と
   * 画面に出る方式名が食い違う。選んでいるならそれを使う。
   */
  basisKind?: "per_unit" | "lump" | null;
}

/** 受領額を割り戻すときの税率。国内の消費税に合わせる。 */
export const RECEIPT_TAX_RATE_PCT = 10;

/**
 * 税込で入っている受領額を税別に直す。税別ならそのまま。
 *
 * 整数どうしで割る。1.1 で割ると 1,100,000 ÷ 1.1 が 999999.9999… になり、
 * 切りのいい額のたびに1円ずれる（浮動小数の丸め）。
 *
 * 端数は切り捨てる。切り上げると、割り戻した額に税を足したとき元の額を
 * 超えることがあり、相手の入金より多い基礎で計算することになる。
 */
export function netOfTax(amount: number, taxIncluded: boolean | null | undefined): number {
  if (!taxIncluded) return amount;
  return Math.floor((amount * 100) / (100 + RECEIPT_TAX_RATE_PCT));
}

/**
 * その行が「個数 × 単価」で出しているか、「受領額そのもの」で出しているか。
 *
 * 自社製造・他社販売は契約によってどちらもある。新しい列を足さず、
 * 入っている数字から読み分ける（両方入っている行は受け付けないので、
 * あとからでも一意に決まる）。
 */
export function basisKindOf(input: UsageBasisInput): "per_unit" | "lump" {
  if (input.usageType === "sublicense") return "lump";
  if (input.usageType === "in_house") return "per_unit";
  // 画面が形を指定しているならそれに従う。数字はまだ揃っていないことがある。
  if (input.basisKind) return input.basisKind;
  // 他社販売は受領額に料率を掛ける形が主。個数と単価が入っている行だけ、
  // 個数建ての契約として扱う。
  return Number(input.unitAmount ?? 0) > 0 && Number(input.quantity ?? 0) > 0
    ? "per_unit" : "lump";
}

/**
 * その実績の算定基礎（最小通貨単位）。
 *
 * 足りない数字があれば止める。0 のまま計算すると、金額の入っていない
 * 計算書が番号付きで出る（外貨の換算で実際に起きた）。
 */
export function basisOf(input: UsageBasisInput, tag: string): number {
  const gross = Number(input.grossAmount ?? 0);
  if (input.usageType === "sublicense") {
    if (!(gross > 0)) {
      throw new DomainError("VALIDATION", `${tag}：再許諾は受領価格を入れてください`);
    }
    return netOfTax(Math.round(gross), input.taxIncluded);
  }
  if (input.usageType === "oem") {
    // 個数×単価と受領額の両方が入っている行は、どちらで計算したのか決められない。
    // 片方を勝たせると、人が見ていない側の数字が紙に出ないまま残る。
    const hasPerUnit = Number(input.unitAmount ?? 0) > 0 || Number(input.quantity ?? 0) > 0;
    if (gross > 0 && hasPerUnit) {
      throw new DomainError("VALIDATION",
        `${tag}：受領額と「個数 × 単価」の両方は入れられません。どちらかにしてください`);
    }
    if (gross > 0) return netOfTax(Math.round(gross), input.taxIncluded);
  }
  // 基準価格は自社の定価なので割り戻さない。割り戻すのは相手から受け取った額だけ。
  const unit = input.usageType === "oem"
    ? netOfTax(Number(input.unitAmount ?? 0), input.taxIncluded)
    : Number(input.unitAmount ?? 0);
  const quantity = Number(input.quantity ?? 0);
  const sample = Number(input.sampleQuantity ?? 0);
  const priceLabel = input.usageType === "oem" ? "受領価格（1個あたり）" : "基準価格";
  if (!(Number(input.unitAmount ?? 0) > 0)) {
    throw new DomainError("VALIDATION", `${tag}：${priceLabel}を入れてください`);
  }
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

/** 紙に出す「どう出した数字か」の一行。入金区分があれば先に付ける。 */
export function basisNoteOf(input: UsageBasisInput): string {
  const stage = paymentStageLabel(input.paymentStage);
  const head = stage ? `${stage}　` : "";
  // 割り戻したときは、その式も出す。相手が検算できないと問い合わせになる。
  const tax = input.taxIncluded ? `（税込 ÷ ${1 + RECEIPT_TAX_RATE_PCT / 100}）` : "";
  if (basisKindOf(input) === "lump") return `${head}受領価格${tax}`;
  const quantity = Number(input.quantity ?? 0);
  const sample = Number(input.sampleQuantity ?? 0);
  const billable = Math.max(0, quantity - sample);
  const price = input.usageType === "oem" ? "受領価格" : "基準価格";
  return sample > 0
    ? `${head}${billable}個（${quantity} − 見本 ${sample}）× ${price}${tax}`
    : `${head}${billable}個 × ${price}${tax}`;
}

/**
 * 紙に出す方式名。前金・後金は行の見出しで分ける。
 * 同じ方式の行が2本並ぶと、受け取った側はどちらの入金か読めない。
 */
export function methodLabelOf(input: UsageBasisInput): string {
  const spec = usageTypeSpec(input.usageType);
  if (!spec) return "";
  const stage = paymentStageLabel(input.paymentStage);
  if (!stage) {
    return input.usageType === "oem" && basisKindOf(input) === "lump"
      ? "自社製造・他社販売（受領価格）" : spec.methodLabel;
  }
  const shape = basisKindOf(input) === "lump" ? "受領価格" : "受領価格 × 製造個数";
  return `${spec.label}（${stage}・${shape}）`;
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
  if (input.paymentStage && !spec.hasStages) {
    throw new DomainError("VALIDATION",
      `${tag}：${spec.label} に前金・後金の区別は付きません`);
  }
  basisOf(input, tag);
}
