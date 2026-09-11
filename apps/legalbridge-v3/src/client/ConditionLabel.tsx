import { money, rate } from "./api.js";
import { CONDITION_KIND_LABEL, PRICING_MODEL_LABEL } from "./labels.js";

/**
 * 条件明細の見出し。選ぶ画面はどこもこれで揃える。
 *
 * 条件名だけを並べていたころは、どれを選べばよいのかが読めなかった。
 * ライセンスの条件は「どの作品を・誰に・どの取引モデルで」が効く一方、
 * 条件名は「繁体字版 電子書籍 配信許諾」のように作品名と重なる。
 * 業務委託は逆で、作品は付いていないことも多く、件名と金額で見分ける。
 * だから型ごとに出すものを変える。
 *
 *   ライセンス … 条件番号 ／ 作品名 ／ 取引先 ／ 取引モデル
 *   業務委託   … 作品名（あれば）／ 件名 ／ 取引先 ／ 金額
 */

export interface LabelledCondition {
  id: number;
  conditionNo: string | null;
  name: string;
  kind: string;
  direction: string;
  counterparty: { name: string } | null;
  work?: { title: string } | null;
  currency?: string;
  pricingModel?: string;
  flatAmount?: number | null;
  unitAmount?: number | null;
  ratePpm?: number | null;
}

/** 権利を扱う条件か。許諾料と製品がライセンス、残りが業務委託。 */
export const isLicenseCondition = (c: { kind: string }): boolean =>
  c.kind === "license" || c.kind === "product";

/**
 * ライセンスの取引モデル。固定3種（条件書の V3_FIXED_DEALS と対）。
 *
 * V3 は取引モデルを列で持っていないので、計算方式から当てる。
 * 「自社製造・他社販売」は計算方式が製造販売と同じなので当てられない。
 * 当てられないものは計算方式をそのまま出す（黙って空にしない）。
 */
export function dealModelLabel(c: { direction: string; pricingModel?: string }): string {
  // 取得（IN）は「許諾を受ける側」で、取引モデルの話ではない。
  if (c.direction === "in") return "取得";
  if (c.pricingModel === "unit_rate") return "自社製造・自社販売";
  if (c.pricingModel === "revenue_rate") return "権利許諾（サブライセンス）";
  return PRICING_MODEL_LABEL[String(c.pricingModel ?? "")] ?? "計算方式なし";
}

/** 金額の見出し。料率なら率、単価×数量なら単価、それ以外は定額。 */
export function conditionAmountLabel(c: LabelledCondition): string {
  const currency = c.currency ?? "JPY";
  if (c.pricingModel === "revenue_rate") return rate(c.ratePpm ?? null);
  if (c.pricingModel === "unit_rate") return `単価 ${money(c.unitAmount ?? null, currency)}`;
  return money(c.flatAmount ?? null, currency);
}

/**
 * 1行の見出し。選ぶ画面（文書の作成・案件に繋ぐ・計算書の対象）で使う。
 * 横に並べるので、省くのは値が無いものだけ。
 */
export function ConditionLabel(
  { c, showKind, omitCode }: {
    c: LabelledCondition;
    showKind?: boolean;
    /** 条件番号の列が別にあるとき。同じ番号を2回出さない。 */
    omitCode?: boolean;
  }
) {
  const license = isLicenseCondition(c);
  return (
    <>
      {showKind && <span className="tag">{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</span>}
      {license && !omitCode && <span className="code">{c.conditionNo ?? `#${c.id}`}</span>}
      {c.work?.title && <span>{c.work.title}</span>}
      {!license && <span>{c.name}</span>}
      <span className="faint">{c.counterparty?.name ?? "相手先なし"}</span>
      {license
        ? <span className="tag">{dealModelLabel(c)}</span>
        : <span className="num">{conditionAmountLabel(c)}</span>}
    </>
  );
}

/** 文字だけで要るとき（確認のダイアログ・表の1セル）。 */
export function conditionLabelText(c: LabelledCondition): string {
  const license = isLicenseCondition(c);
  return [
    license ? (c.conditionNo ?? `#${c.id}`) : null,
    c.work?.title ?? null,
    license ? null : c.name,
    c.counterparty?.name ?? null,
    license ? dealModelLabel(c) : conditionAmountLabel(c)
  ].filter(Boolean).join(" ／ ");
}
