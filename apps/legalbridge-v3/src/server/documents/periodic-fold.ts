/**
 * 定期課金の明細を「回ごとの行」から「1行のまとめ」に畳む。
 *
 * 定期課金の条件は予定明細を回ごとに立てる（12か月なら12回）。台帳の中では
 * それが正しい。回ごとに期日も支払日も違うし、実績も回ごとに付く。
 *
 * ただし紙に出すときは話が別で、同じ品目・同じ仕様・同じ額の行が12本
 * 縦に並ぶ。読む側には「同じことが12回書いてある」だけの表になり、
 * 発注書が2ページに伸びる。V2 まではこれをそのまま刷っていた。
 *
 * ここでは、続けて並んだ同じ内容の回をひとまとめにして
 *
 *     保守運用（月額）  数量 12  単価 35,000  金額 420,000
 *     仕様：… ／ 2026年4月分 〜 2027年3月分　全12回（毎月）　1回あたり 35,000
 *
 * の1行にする。畳むのは中身が本当に同じ回だけで、額が違う回・変更の記録が
 * 付いた回・検収状態の違う回は畳まない。畳めない回が混ざっていれば、そこで
 * まとまりが切れて別の行になる（12回のうち9月だけ増額、なら3行になる）。
 *
 * 畳んでも台帳の予定明細・実績は1件も変わらない。変わるのは紙の見た目だけ。
 */

import { num, rows as rowsOf, yen, type Row } from "./legacy-totals.js";

/** 畳む対象の計算方式。定期課金だけ。 */
const SUBSCRIPTION = "SUBSCRIPTION";

const text = (value: unknown): string => String(value ?? "").trim();
const dateOf = (value: unknown): string | null => {
  const t = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

const ymd = (d: string) => d.split("-").map(Number) as [number, number, number];
/** 2つの日付が何か月離れているか。日は見ない（月末と月末は1か月）。 */
const monthsApart = (a: string, b: string) => {
  const [ay, am] = ymd(a);
  const [by, bm] = ymd(b);
  return (by - ay) * 12 + (bm - am);
};

/**
 * 回と回のあいだの月数。ぜんぶ同じ間隔で並んでいるときだけ返す。
 * ばらけていれば null（「毎月」と刷って嘘になるより、書かないほうがよい）。
 */
export function monthGap(dates: Array<string | null>): number | null {
  const days = dates.filter((d): d is string => Boolean(d));
  if (days.length < 2 || days.length !== dates.length) return null;
  const gaps = days.slice(1).map((d, i) => monthsApart(days[i], d));
  const first = gaps[0];
  if (first <= 0 || gaps.some((g) => g !== first)) return null;
  return first;
}

/** 回の間隔の呼び方。期日が1か月おきなら「毎月」、3か月おきなら「3か月ごと」。 */
export function intervalLabel(dates: Array<string | null>): string | null {
  const gap = monthGap(dates);
  if (gap === null) return null;
  if (gap === 1) return "毎月";
  if (gap === 12) return "毎年";
  return `${gap}か月ごと`;
}

/** ひな形の「周期」の選択肢。発注書は定期支払の行をこれで刷り分ける。 */
const CYCLE_OF: Record<number, string> = {
  1: "MONTHLY", 3: "QUARTERLY", 6: "SEMIANNUAL", 12: "ANNUAL"
};

/** 月末日か。29日〜31日の扱いを合わせるため、その月の日数で見る。 */
const isMonthEnd = (date: string) => {
  const [y, m, d] = ymd(date);
  return d === new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * 定期支払の刷り方（周期・毎周期の支払日・支払月）。
 *
 * 発注書のひな形は定期支払の行を「役務提供期間＋周期＋支払日」で刷る。
 * 回ごとの行を畳むと、その3つを回の並びから読み取れる。読み取れない
 * （間隔も支払日もばらけている）ときは何も入れず、人が入れる欄として残す。
 */
export function billingShape(run: Row[]): Row {
  const dues = run.map((r) => dateOf(r.delivery_date));
  const pays = run.map((r) => dateOf(r.payment_date));
  const out: Row = {};
  const gap = monthGap(dues);
  if (gap !== null && CYCLE_OF[gap]) out.cycle = CYCLE_OF[gap];

  const days = pays.filter((d): d is string => Boolean(d));
  if (days.length === pays.length && days.length) {
    if (days.every(isMonthEnd)) out.billing_day = 31;
    else {
      const day = ymd(days[0])[2];
      if (days.every((d) => ymd(d)[2] === day)) out.billing_day = day;
    }
    if (dues.every((d): d is string => Boolean(d))) {
      const offsets = days.map((d, i) => monthsApart(dues[i] as string, d));
      const first = offsets[0];
      if (offsets.every((o) => o === first)) {
        const timing = ({ 0: "SAME_MONTH", 1: "NEXT_MONTH", 2: "MONTH_AFTER_NEXT" } as Record<number, string>)[first];
        if (timing) out.billing_timing = timing;
      }
    }
  }
  return out;
}

/** 日付の欄のまとめ方。全部同じならその日、違えば「最初 〜 最後」。 */
function rangeOf(values: unknown[]): string | null {
  const seen = values.map((v) => text(v)).filter(Boolean);
  if (!seen.length) return null;
  if (seen.length !== values.length) return null;
  const unique = [...new Set(seen)];
  if (unique.length === 1) return unique[0];
  return `${seen[0]} 〜 ${seen[seen.length - 1]}`;
}

/**
 * 畳んでよい回かどうかの見分け。ここに挙げた欄が全部同じ回だけがまとまる。
 * 品目名（＝回の名前「2026年4月分」）は回ごとに違って当たり前なので見ない。
 */
const SAME_KEYS = [
  "condition_id", "spec", "unit_price", "quantity", "amount_ex_tax",
  "payment_terms", "tax_category", "deliverable_ownership", "reward_label",
  "order_no", "condition_no", "inspection_status"
];

const sameContent = (a: Row, b: Row): boolean =>
  SAME_KEYS.every((key) => text(a[key]) === text(b[key]));

/**
 * 畳める行か。定期課金で、変更の記録が付いていないこと。
 *
 * 金額を予定から動かした回（減額検収・追加）は、なぜ動いたのかが紙に残る
 * ようになっている。畳むとその1回がまとまりの中に消えるので、畳まない。
 */
function foldable(row: Row): boolean {
  if (text(row.calc_method) !== SUBSCRIPTION) return false;
  if (text(row.changeNote)) return false;
  const ordered = num(row.ordered_amount_ex_tax, Number.NaN);
  const actual = num(row.inspected_amount_ex_tax ?? row.amount_ex_tax, Number.NaN);
  if (Number.isFinite(ordered) && Number.isFinite(actual) && ordered !== actual) return false;
  return true;
}

/** まとめの1行に書く説明。仕様の下に足して紙に出す。 */
export function periodSummary(run: Row[]): string {
  const labels = run.map((r) => text(r.item_name)).filter(Boolean);
  const dates = run.map((r) => dateOf(r.delivery_date));
  const span = labels.length === run.length && labels[0] !== labels[labels.length - 1]
    ? `${labels[0]} 〜 ${labels[labels.length - 1]}`
    : rangeOf(run.map((r) => r.delivery_date)) ?? "";
  const interval = intervalLabel(dates);
  const unit = num(run[0].unit_price ?? run[0].amount_ex_tax, Number.NaN);
  const times = `全${run.length}回${interval ? `（${interval}）` : ""}`;
  const each = Number.isFinite(unit) && unit > 0 ? `1回あたり ${yen(unit)}` : "";
  return [span, times, each].filter(Boolean).join("　");
}

/** 仕様の本文にまとめの説明を足す。もともとの仕様は消さない。 */
function specWith(spec: unknown, summary: string): string {
  const base = String(spec ?? "").replace(/\s+$/, "");
  return base ? `${base}\n${summary}` : summary;
}

/** 続けて並んだ同じ内容の回をひとまとまりにする。 */
function runsOf(lines: Row[]): Row[][] {
  const out: Row[][] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && foldable(last[0]) && foldable(line) && sameContent(last[0], line)) last.push(line);
    else out.push([line]);
  }
  return out;
}

/** まとまりを1行にする。回が1つだけのまとまりは、そのままの行を返す。 */
function foldRun(run: Row[]): Row {
  const first = run[0];
  if (run.length < 2) return first;
  const n = run.length;
  const summary = periodSummary(run);
  const spec = specWith(first.spec ?? first.description, summary);
  const perTime = num(first.amount_ex_tax ?? first.inspected_amount_ex_tax);
  // 数量は「回あたりの数量 × 回数」。回あたりが空なら空のまま（勝手に回数を
  // 数量として刷ると、単価 × 数量 が金額と合わなくなる）。
  const perQty = num(first.quantity, Number.NaN);
  const quantity = Number.isFinite(perQty) ? perQty * n : null;
  const orderedEach = num(first.ordered_amount_ex_tax, Number.NaN);
  const money: Row = { amount_ex_tax: perTime * n };
  if (first.inspected_amount_ex_tax !== undefined) money.inspected_amount_ex_tax = perTime * n;
  if (Number.isFinite(orderedEach)) money.ordered_amount_ex_tax = orderedEach * n;

  return {
    ...first,
    // 回の名前（「2026年4月分」）ではなく、条件の名前をまとめの品目名にする。
    item_name: text(first.condition_name) || text(first.item_name),
    spec,
    ...(first.description === undefined ? {} : { description: spec }),
    quantity,
    ...(first.inspected_quantity === undefined ? {} : { inspected_quantity: quantity }),
    ...money,
    delivery_date: rangeOf(run.map((r) => r.delivery_date)),
    payment_date: rangeOf(run.map((r) => r.payment_date)),
    ...(first.inspection_date === undefined
      ? {} : { inspection_date: rangeOf(run.map((r) => r.inspection_date)) }),
    ...(first.paid_date === undefined
      ? {} : { paid_date: rangeOf(run.map((r) => r.paid_date)) }),
    term_start: first.term_start ?? first.delivery_date ?? null,
    term_end: run[n - 1].term_end ?? run[n - 1].delivery_date ?? null,
    // 畳んだことを本文からも読めるようにしておく。改訂したひな形はこれを
    // 直接差せる（いまのひな形は仕様の中の説明として読む）。
    // 周期・支払日・支払月。ひな形の定期支払の枝がこれを読む。
    // 人が入れた値があればそちらを残す（読み取りは当て推量なので上書きしない）。
    ...Object.fromEntries(Object.entries(billingShape(run))
      .filter(([key]) => first[key] === undefined || first[key] === null || first[key] === "")),
    period_count: n,
    period_interval: intervalLabel(run.map((r) => dateOf(r.delivery_date))),
    period_summary: summary,
    period_amount_each: perTime,
    folded: true
  };
}

/**
 * 明細を畳む。定期課金の回が続いているところだけがまとまり、
 * それ以外の行は順番も中身もそのまま通る。
 */
export function foldPeriodicLines(lines: unknown): Row[] {
  const list = rowsOf(lines);
  if (list.length < 2) return list;
  return runsOf(list).map(foldRun);
}
