/**
 * 案件の件名を軸から組む。
 *
 * 自由入力だと「挿絵 追加発注」「NDA（新規取次）」「統合検証」が混ざり、
 * 一覧で何の案件か読めなかった。軸（作品か業務）が決まれば件名は決まる。
 * 人が打つのは「区分」か「業務名」だけ。上書きしたら title_manual が立ち、
 * 以後は組み直さない。
 *
 *   作品案件 … 作品名｜制作＋許諾 ／ 作品名｜許諾のみ ／ 作品名（未決定なら区分を出さない）
 *   業務案件 … 事業区分｜相手先｜業務名
 *   その他   … 組まない（軸が無い）。人が打つ
 */
export type MatterKind = "work" | "outsourcing" | "single";
export type BusinessLine = "store" | "admin";

export const BUSINESS_LINE_LABEL: Record<BusinessLine, string> = { store: "店舗事業", admin: "管理事業" };

export interface TitleAxis {
  kind: MatterKind;
  workTitle?: string | null;
  /** 制作委託があるか。null は未決定。 */
  production?: boolean | null;
  businessLine?: BusinessLine | null;
  partyName?: string | null;
  businessName?: string | null;
}

export function composeMatterTitle(axis: TitleAxis): string | null {
  const t = (v: unknown) => String(v ?? "").trim();
  if (axis.kind === "work") {
    const work = t(axis.workTitle);
    if (!work) return null;
    const part = axis.production === true ? "制作＋許諾" : axis.production === false ? "許諾のみ" : "";
    return part ? `${work}｜${part}` : work;
  }
  if (axis.kind === "outsourcing") {
    const parts = [
      axis.businessLine ? BUSINESS_LINE_LABEL[axis.businessLine] : "",
      t(axis.partyName), t(axis.businessName)
    ].filter(Boolean);
    return parts.length ? parts.join("｜") : null;
  }
  return null;
}
