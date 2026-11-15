import { payDateFromDelivery } from "../conditions/payment-terms.js";

/**
 * 店舗イベント審判業務の発注書（ひな形：発注書）の中身を、その月の開催日から組む。
 *
 *   1 取引先 × 1 か月 ＝ 発注書 1 枚（役務完了報告もまとめて 1 枚）
 *   明細の行 ＝ イベント名・店舗・単価が同じ開催日のまとまり（数量＝日数）
 *     同じイベントを何日やっても 1 行。違うイベント（または違う店舗・単価）は行を分ける
 *   経費 ＝ 交通費のある開催日ごとに 1 行（発生日＝開催日、税込の実費）
 *
 * 委託料は税込で受け、税抜は 1 円未満を切り捨てる（13,000 → 11,818）。
 * 紙・DB・画面の三か所で同じ計算をするので、ここ 1 か所に置く（画面もこれを読む）。
 * サーバの道具（db）は持ち込まない。
 */

export interface JudgeDay {
  /** 開催日（YYYY-MM-DD）。 */
  date: string;
  /** 開始時刻（HH:MM）。紙には「12:00〜」と終わりを書かずに出す。 */
  startTime: string;
  eventName: string;
  storeId: number;
  /** 委託料（税込・1 日あたり）。 */
  feeIncTax: number;
  /** 交通費（税込の実費）。無ければ null か 0。 */
  travelIncTax: number | null;
}

export interface JudgeStore { id: number; name: string; shortName: string }

export interface JudgeLine {
  /** まとまりの鍵（イベント名｜店舗｜単価）。 */
  key: string;
  eventName: string;
  store: JudgeStore;
  dates: string[];
  quantity: number;
  /** 単価（税抜）。 */
  unitPrice: number;
  /** 金額（税抜）＝ 単価 × 日数。 */
  amount: number;
  itemName: string;
  spec: string;
  /** 役務提供期間。1 日なら同じ日。 */
  termStart: string;
  termEnd: string;
}

export interface JudgeExpense { date: string; amount: number }

export interface JudgePlan {
  /** 対象の月（YYYY-MM）。開催日の最初の月。 */
  month: string | null;
  /** 件名。「ホビステ11月開催ジャッジ業務」。 */
  subject: string;
  lines: JudgeLine[];
  expenses: JudgeExpense[];
  subtotal: number;
  travelTotal: number;
  /** 支払期日（最後の開催日から。個人は翌月 20 日、法人は翌月末日）。 */
  payOn: string | null;
  issues: string[];
}

/** 業務内容の定型文。過去の発注書（ARC-PO-2026-1083 ほか）と同じ文。 */
export const JUDGE_DUTIES = [
  "●審判業務(発注者が主催する大会において、競技規則に基づく独立した判定業務、試合結果の記録、規則違反に対する適切な措置の実施、試合の円滑な進行管理、審判としての専門知識の提供、競技規則の適用に関する専門的判断の提供、判定に関する質問への回答、試合後の審判報告書の作成)",
  "●競技イベント遂行業務(大会の進行管理に関する専門的サービスの提供、会場設営および撤去作業の実施、参加者受付および案内業務の実施、大会スケジュール管理、参加者からの競技に関する問い合わせへの対応)"
].join("\n");

/** 契約形式。紙の「契約種別」に出る。 */
export const JUDGE_CONTRACT_FORM = "準委任";
/** 案件の業務名（店舗事業｜取引先｜この名前）。 */
export const JUDGE_BUSINESS_NAME = "店舗イベント審判業務";

const WEEKDAY = "日月火水木金土";

/** 税込 → 税抜（1 円未満切り捨て）。浮動小数の誤差を避けて整数で割る。 */
export function exTaxOf(incTax: number): number {
  const n = Math.round(Number(incTax) || 0);
  return n > 0 ? Math.floor((n * 10) / 11) : 0;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): { y: number; m: number; d: number; wd: string } | null {
  const hit = DATE.exec(String(date ?? ""));
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d, wd: WEEKDAY[dt.getUTCDay()] };
}

/** 2026/11/29(日) 12:00〜 */
export function whenText(date: string, startTime: string): string {
  const p = parts(date);
  if (!p) return "";
  const time = String(startTime ?? "").trim();
  return `${p.y}/${p.m}/${p.d}(${p.wd})${time ? ` ${time}〜` : ""}`;
}

/** 1 日：審判業務（2026/11/29‗HBST大宮）／複数日：審判業務（氷星杯 2日‗HBST大宮） */
export function itemNameOf(eventName: string, dates: string[], store: JudgeStore): string {
  const short = store.shortName || store.name;
  if (dates.length === 1) {
    const p = parts(dates[0]);
    return `審判業務（${p ? `${p.y}/${p.m}/${p.d}` : dates[0]}‗${short}）`;
  }
  return `審判業務（${eventName} ${dates.length}日‗${short}）`;
}

export function specOf(eventName: string, days: Array<{ date: string; startTime: string }>, store: JudgeStore): string {
  return [
    `イベント名：${eventName}`,
    ...days.map((d) => `日時：${whenText(d.date, d.startTime)}`),
    `場所：${store.name}`,
    JUDGE_DUTIES
  ].join("\n");
}

export function planJudgeOrder(input: {
  days: JudgeDay[]; stores: JudgeStore[]; partyKind?: string | null;
}): JudgePlan {
  const issues: string[] = [];
  const storeOf = new Map(input.stores.map((s) => [s.id, s]));
  const days = [...(input.days ?? [])]
    .map((d) => ({ ...d, eventName: String(d.eventName ?? "").trim(), startTime: String(d.startTime ?? "").trim() }))
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
  if (!days.length) issues.push("開催日を 1 日以上入れてください");
  const seen = new Set<string>();
  const valid = days.filter((d, i) => {
    const no = `${i + 1} 行目`;
    let ok = true;
    if (!parts(d.date)) { issues.push(`${no}：開催日が読めません（${d.date || "空"}）`); ok = false; }
    if (!d.eventName) { issues.push(`${no}：イベント名が空です`); ok = false; }
    if (!storeOf.has(d.storeId)) { issues.push(`${no}：店舗が選ばれていません`); ok = false; }
    if (!(exTaxOf(d.feeIncTax) > 0)) { issues.push(`${no}：委託料（税込）を入れてください`); ok = false; }
    if (d.travelIncTax !== null && d.travelIncTax !== undefined && (!Number.isFinite(Number(d.travelIncTax)) || Number(d.travelIncTax) < 0)) {
      issues.push(`${no}：交通費が読めません`); ok = false;
    }
    const dup = `${d.date}|${d.storeId}|${d.eventName}|${d.startTime}`;
    if (ok && seen.has(dup)) { issues.push(`${no}：同じ日・同じ店舗・同じイベントが 2 回入っています`); ok = false; }
    seen.add(dup);
    return ok;
  });
  const months = [...new Set(valid.map((d) => d.date.slice(0, 7)))];
  if (months.length > 1) issues.push(`開催日が ${months.join("・")} にまたがっています。発注書は 1 か月ごとに分けてください`);

  const groups = new Map<string, { eventName: string; store: JudgeStore; unitPrice: number; days: typeof valid }>();
  for (const d of valid) {
    const store = storeOf.get(d.storeId)!;
    const unitPrice = exTaxOf(d.feeIncTax);
    const key = `${d.eventName}|${store.id}|${unitPrice}`;
    const g = groups.get(key) ?? { eventName: d.eventName, store, unitPrice, days: [] };
    g.days.push(d);
    groups.set(key, g);
  }
  const lines: JudgeLine[] = [...groups.entries()].map(([key, g]) => {
    const dates = g.days.map((d) => d.date);
    return {
      key, eventName: g.eventName, store: g.store, dates,
      quantity: dates.length, unitPrice: g.unitPrice, amount: g.unitPrice * dates.length,
      itemName: itemNameOf(g.eventName, dates, g.store),
      spec: specOf(g.eventName, g.days, g.store),
      termStart: dates[0], termEnd: dates[dates.length - 1]
    };
  });
  const expenses = valid
    .filter((d) => Math.round(Number(d.travelIncTax ?? 0)) > 0)
    .map((d) => ({ date: d.date, amount: Math.round(Number(d.travelIncTax)) }));
  const first = valid.length ? parts(valid[0].date) : null;
  const last = valid.length ? valid[valid.length - 1].date : null;
  return {
    month: first ? `${first.y}-${String(first.m).padStart(2, "0")}` : null,
    subject: `ホビステ${first ? first.m : "○"}月開催ジャッジ業務`,
    lines, expenses,
    subtotal: lines.reduce((a, l) => a + l.amount, 0),
    travelTotal: expenses.reduce((a, e) => a + e.amount, 0),
    payOn: last ? payDateFromDelivery(last, input.partyKind ?? null) : null,
    issues
  };
}
