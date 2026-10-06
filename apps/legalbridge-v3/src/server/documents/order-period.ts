/**
 * 発注書の「納期」と「役務提供期間」の出し分け。
 *
 * 品目には 成果物納品（DELIVERABLE）と 役務提供（SERVICE）がある。成果物は
 * 納期の 1 日、役務は提供期間（開始〜終了）を書く。以前は納期の 1 日しか
 * 持てず、「10月20日〜25日の作業」が 1 ページ目に「October 25, 2026」とだけ
 * 出て、仕様欄の期間と食い違っていた。
 *
 * 定期支払（SUBSCRIPTION）の行は本文が自分で役務提供期間を出すので、ここでは
 * 触らない。
 */
import type { Row } from "./legacy-totals.js";

export type DeliveryKind = "DELIVERABLE" | "SERVICE";
type Lang = "ja" | "en";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const ymd = (value: unknown): [number, number, number] | null => {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const iso = (value: unknown): string | null => {
  const d = ymd(value);
  return d ? String(value).trim().slice(0, 10) : null;
};

const oneDate = ([y, m, d]: [number, number, number], lang: Lang) =>
  lang === "en" ? `${MONTHS[m - 1]} ${d}, ${y}` : `${y}年${m}月${d}日`;

/**
 * 期間を短く書く。同じ年月なら「October 20 – 25, 2026」「2026年10月20日〜25日」、
 * 同じ年なら「October 20 – November 3, 2026」「2026年10月20日〜11月3日」。
 * 片方だけなら「From …」「Until …」／「…〜」「〜…」。
 */
export function formatPeriod(from: unknown, to: unknown, lang: Lang): string {
  const a = ymd(from);
  const b = ymd(to);
  if (a && b) {
    if (a.join() === b.join()) return oneDate(a, lang);
    if (lang === "en") {
      if (a[0] === b[0] && a[1] === b[1]) return `${MONTHS[a[1] - 1]} ${a[2]} – ${b[2]}, ${a[0]}`;
      if (a[0] === b[0]) return `${MONTHS[a[1] - 1]} ${a[2]} – ${MONTHS[b[1] - 1]} ${b[2]}, ${a[0]}`;
      return `${oneDate(a, lang)} – ${oneDate(b, lang)}`;
    }
    if (a[0] === b[0] && a[1] === b[1]) return `${oneDate(a, lang)}〜${b[2]}日`;
    if (a[0] === b[0]) return `${oneDate(a, lang)}〜${b[1]}月${b[2]}日`;
    return `${oneDate(a, lang)}〜${oneDate(b, lang)}`;
  }
  if (a) return lang === "en" ? `From ${oneDate(a, lang)}` : `${oneDate(a, lang)}〜`;
  if (b) return lang === "en" ? `Until ${oneDate(b, lang)}` : `〜${oneDate(b, lang)}`;
  return "";
}

const isSubscription = (row: Row) => String(row.calc_method ?? "") === "SUBSCRIPTION";

/** 行が役務提供か。人が選んだ値（delivery_kind）だけを見る。 */
export const isServiceRow = (row: Row) =>
  !isSubscription(row) && String(row.delivery_kind ?? "") === "SERVICE";

/** 役務提供の行の期間。開始・終了が無ければ納期の 1 日に落ちる。 */
const servicePeriodOf = (row: Row): { from: string | null; to: string | null } => {
  const from = iso(row.term_start);
  const to = iso(row.term_end);
  if (from || to) return { from, to };
  const due = iso(row.delivery_date);
  return { from: due, to: due };
};

/**
 * 品目の行に、本文が差す「期間の見出しと値」を足す。役務提供の行だけ。
 * 成果物の行・定期支払の行は本文の既定の出し方（納期／役務提供期間）のまま。
 */
export function withPeriodText(items: Row[], lang: Lang): Row[] {
  return items.map((row) => {
    if (!isServiceRow(row)) return row;
    const { from, to } = servicePeriodOf(row);
    const text = formatPeriod(from, to, lang);
    if (!text) return row;
    return { ...row, period_label: lang === "en" ? "Service period" : "役務提供期間", period_text: text };
  });
}

/**
 * 1 ページ目の「納期（または役務提供期間）」の見出しと値。
 *
 * 行が 1 本（または全部同じ期間）ならその期間をそのまま書く。ばらけていれば
 * 一番早い日〜一番遅い日に「（明細参照）」を付ける。見出しは、全部が役務なら
 * 「役務提供期間」、全部が成果物なら「納期」、混ざっていれば既定（両方の併記）。
 * 返り値が null（summary が null）なら、呼び手の従来の出し方に任せる。
 */
export function orderPeriodSummary(items: Row[], lang: Lang): { heading: string; summary: string | null } | null {
  const target = items.filter((row) => !isSubscription(row));
  const service = target.filter(isServiceRow);
  if (!service.length) {
    // 全部を「成果物納品」と決めてあれば見出しを「納期」だけにする。値は従来どおり。
    const allDeliverable = target.length > 0
      && target.every((row) => String(row.delivery_kind ?? "") === "DELIVERABLE");
    return allDeliverable ? { heading: lang === "en" ? "Delivery" : "納期", summary: null } : null;
  }
  const spans = target.map((row) => {
    if (isServiceRow(row)) return servicePeriodOf(row);
    const due = iso(row.delivery_date);
    return { from: due, to: due };
  }).filter((s) => s.from || s.to);
  const heading = service.length === target.length
    ? (lang === "en" ? "Service period" : "役務提供期間")
    : "";
  if (!spans.length) return { heading, summary: "" };
  const keys = new Set(spans.map((s) => `${s.from ?? ""}|${s.to ?? ""}`));
  if (keys.size === 1) return { heading, summary: formatPeriod(spans[0].from, spans[0].to, lang) };
  const all = spans.flatMap((s) => [s.from, s.to]).filter((d): d is string => Boolean(d)).sort();
  const text = formatPeriod(all[0], all[all.length - 1], lang);
  return { heading, summary: lang === "en" ? `${text} (see details)` : `${text}（明細参照）` };
}

/**
 * 契約形式から、品目の既定の種類を引く。委任・準委任は役務提供、請負・売買は
 * 成果物納品。どちらとも言えない（空・利用許諾など）は決めない（null）。
 * 画面で人が選び直せる。
 */
export function deliveryKindFor(contractForm: unknown): DeliveryKind | null {
  const text = String(contractForm ?? "").trim();
  if (!text) return null;
  if (/委任|mandate|service|consult/i.test(text)) return "SERVICE";
  if (/請負|売買|contract for work|sale/i.test(text)) return "DELIVERABLE";
  return null;
}
