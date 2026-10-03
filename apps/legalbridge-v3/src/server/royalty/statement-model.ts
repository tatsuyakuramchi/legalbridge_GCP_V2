/**
 * 取引モデル（利用形態）ごとの、利用許諾料計算書の出し分け。
 *
 * 計算書のひな形は1つで、取引モデルを問わず同じ本文を使う。本文
 * （document_template_versions）は変えない決まりなので、出し分けは
 * 本文へ渡す値の側でする。本文の {{#if}} は空文字・false で消えるので、
 * そのモデルで意味を持たない欄は空にして渡す（0 を "0" で渡すと消えない）。
 *
 * どのモデルで何を出すかを、ここ1か所の表にまとめる。画面（運用 → 計算書の表示）
 * もこの表をそのまま見せる。
 */

import { USAGE_TYPES, type UsageType } from "./usage-type.js";

type Data = Record<string, unknown>;

export interface StatementModelRule {
  usageType: UsageType;
  label: string;
  /** 本文の日付見出しの分岐（製造完了日／売上発生日／入金日）に渡す値。 */
  calcType: "manufacturing" | "sales" | "sublicense";
  dateLabel: string;
  /** 算定の基礎として紙に出るもの。 */
  basisLabel: string;
  /** 数量・見本・有償数量の欄を出すか。 */
  quantityRows: boolean;
  /**
   * 「■ 取引モデル」の表の「取引モデル概要」（変数 payerCompany）の書き方。
   * {自社} は会社情報の会社名から「株式会社」などを外したもの、{OUT企業} はアウト条件の取引先。
   */
  summaryPattern: string;
}

const spec = (value: UsageType) => USAGE_TYPES.find((t) => t.value === value)!;

export const STATEMENT_MODELS: StatementModelRule[] = [
  {
    usageType: "in_house", label: spec("in_house").label,
    calcType: "manufacturing", dateLabel: "製造完了日",
    basisLabel: "基準価格 × 個数（見本を除く）",
    quantityRows: true, summaryPattern: "{自社}版"
  },
  {
    usageType: "sublicense", label: spec("sublicense").label,
    calcType: "sublicense", dateLabel: "入金日",
    basisLabel: "受領価格（期間の合計）",
    quantityRows: false, summaryPattern: "{OUT企業}再許諾分"
  },
  {
    usageType: "oem", label: spec("oem").label,
    calcType: "manufacturing", dateLabel: "製造完了日",
    basisLabel: "受領価格 × 製造個数（または受領額）",
    quantityRows: true, summaryPattern: "{OUT企業}版"
  }
];

export const statementModelRule = (value: unknown): StatementModelRule | null =>
  STATEMENT_MODELS.find((m) => m.usageType === value) ?? null;

/**
 * 計算書に載る行の利用形態から、本文へ渡す出し分けの値を作る。
 *
 * 利用形態が1つも分からなければ空（これまでどおり何も変えない）。
 */
export function statementModelPatch(usageTypes: Array<string | null | undefined>): Data {
  const rules = [...new Set(usageTypes.map((u) => String(u ?? "")).filter(Boolean))]
    .map(statementModelRule).filter((r): r is StatementModelRule => r !== null)
    .sort((a, b) => STATEMENT_MODELS.indexOf(a) - STATEMENT_MODELS.indexOf(b));
  if (!rules.length) return {};
  const patch: Data = {
    // 本文が今は読まない新しい名前。版を改めるときに {{#if}} の条件に使える。
    transactionModel: rules.length === 1 ? rules[0].usageType : "mixed",
    transactionModelLabel: rules.map((r) => r.label).join("／"),
    hasQuantityRows: rules.some((r) => r.quantityRows)
  };
  // 日付の見出し（本文が calcType で分岐する）。モデルが混ざれば渡さず「発生日」のまま。
  if (rules.length === 1) patch.calcType = rules[0].calcType;
  return patch;
}

/** 会社名から法人の種類を外す。「株式会社アークライト」→「アークライト」。 */
export function companyShortName(name: unknown): string {
  return String(name ?? "")
    .replace(/[（(](株|有|同)[）)]/g, "")
    .replace(/^(株式会社|有限会社|合同会社)\s*/, "")
    .replace(/\s*(株式会社|有限会社|合同会社)$/, "")
    .trim();
}

/**
 * 行1本の「取引モデル概要」。
 *   自社製造・自社販売 … {自社}版（アークライト版）
 *   再許諾            … {OUT企業}再許諾分
 *   自社製造・他社販売 … {OUT企業}版
 * 利用形態の分からない行は、これまでどおり払ってきた相手の名前。
 */
export function modelSummaryLabel(usageType: unknown, payerName: unknown, companyName: unknown): string {
  const payer = String(payerName ?? "").trim();
  const rule = statementModelRule(usageType);
  if (!rule) return payer;
  const own = companyShortName(companyName) || "自社";
  if (rule.summaryPattern.includes("{OUT企業}") && !payer) return rule.label;
  return rule.summaryPattern.replace("{自社}", own).replace("{OUT企業}", payer);
}

/**
 * 計算書1枚の「取引モデル概要」。紙には1組しか書けないので、明細の並び順で
 * 最初の1つを出し、ほかは「ほかN件」にする（各行の内訳は明細に出る）。
 */
export function modelSummary(
  lines: Array<{ usageType?: string | null; payerName?: string | null }>, companyName: unknown
): string {
  const found = [...new Set(lines.map((l) => modelSummaryLabel(l.usageType, l.payerName, companyName))
    .filter(Boolean))];
  if (found.length <= 1) return found[0] ?? "";
  return `${found[0]} ほか${found.length - 1}件`;
}
