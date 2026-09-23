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
/**
 * 業務案件の事業区分（A-050）。作品に紐づかない業務委託の置き場所。
 * 出版の編集委託・ボードゲーム事業の外注・イベントの運営委託は作品案件では
 * ないので、ここで分ける。並びは画面の選択肢の順。
 */
export type BusinessLine = "publishing" | "boardgame" | "event" | "store" | "admin" | "other";

export const BUSINESS_LINES: Array<{ value: BusinessLine; label: string; hint: string }> = [
  { value: "publishing", label: "出版事業", hint: "編集・校正・デザインなど、作品に紐づかない出版の業務委託" },
  { value: "boardgame", label: "ボードゲーム事業", hint: "作品に紐づかないボードゲーム事業の外注" },
  { value: "event", label: "イベント事業", hint: "イベントの運営・設営・出展の委託" },
  { value: "store", label: "店舗事業", hint: "店舗の運営に関わる業務委託" },
  { value: "admin", label: "管理事業", hint: "総務・経理・システムなど管理部門の業務委託" },
  { value: "other", label: "その他", hint: "上のどれにも当たらないもの" }
];
export const BUSINESS_LINE_VALUES = BUSINESS_LINES.map((b) => b.value) as [BusinessLine, ...BusinessLine[]];
export const BUSINESS_LINE_LABEL: Record<BusinessLine, string> =
  Object.fromEntries(BUSINESS_LINES.map((b) => [b.value, b.label])) as Record<BusinessLine, string>;

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
