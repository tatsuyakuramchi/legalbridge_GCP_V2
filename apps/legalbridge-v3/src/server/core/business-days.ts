/**
 * 営業日（日本）。土日と国民の祝日を除く。
 *
 * 役務提供完了通知書の確認期限（送付日から 10 営業日）と、支払予定日の休日調整に使う。
 * 祝日は法律の規則から計算する（固定日・ハッピーマンデー・春分/秋分の近似式・振替休日・国民の休日）。
 * 一年限りの特例（五輪の年の移動など）は持たない。過ぎた年の特例を全部抱えるより、
 * 規則だけで十分に正しい（通知書の期限は数日の余裕で運用する）。
 */

const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string | null | undefined): Date | null => {
  const t = String(s ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 第 n 月曜日。 */
function nthMonday(y: number, m: number, n: number): Date {
  const first = utc(y, m, 1);
  const offset = (8 - first.getUTCDay()) % 7; // 最初の月曜まで
  return utc(y, m, 1 + offset + (n - 1) * 7);
}

/** 春分・秋分の日（1980〜2099 年の近似式）。 */
const vernal = (y: number) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnal = (y: number) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

const cache = new Map<number, Set<string>>();

/** その年の祝日（振替休日・国民の休日を含む）。 */
export function japaneseHolidays(y: number): Set<string> {
  const hit = cache.get(y);
  if (hit) return hit;
  const base: Date[] = [
    utc(y, 1, 1), nthMonday(y, 1, 2), utc(y, 2, 11), utc(y, 2, 23), utc(y, 3, vernal(y)),
    utc(y, 4, 29), utc(y, 5, 3), utc(y, 5, 4), utc(y, 5, 5), nthMonday(y, 7, 3), utc(y, 8, 11),
    nthMonday(y, 9, 3), utc(y, 9, autumnal(y)), nthMonday(y, 10, 2), utc(y, 11, 3), utc(y, 11, 23)
  ];
  const set = new Set(base.map(iso));
  // 振替休日：祝日が日曜なら、その後の最初の「祝日でない日」。
  for (const d of base) {
    if (d.getUTCDay() !== 0) continue;
    let next = new Date(d.getTime() + DAY);
    while (set.has(iso(next))) next = new Date(next.getTime() + DAY);
    set.add(iso(next));
  }
  // 国民の休日：祝日に挟まれた平日（秋の連休）。
  for (const d of base) {
    const mid = new Date(d.getTime() + DAY);
    const after = new Date(d.getTime() + 2 * DAY);
    if (set.has(iso(after)) && !set.has(iso(mid)) && mid.getUTCDay() !== 0) set.add(iso(mid));
  }
  cache.set(y, set);
  return set;
}

export function isBusinessDay(date: string): boolean {
  const d = parse(date);
  if (!d) return false;
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !japaneseHolidays(d.getUTCFullYear()).has(iso(d));
}

/** 起点の翌日から数えて n 営業日目。n=0 なら起点そのもの。 */
export function addBusinessDays(from: string | null | undefined, n: number): string | null {
  const start = parse(from);
  if (!start || !Number.isFinite(n)) return null;
  let cur = start;
  let left = Math.max(0, Math.round(n));
  while (left > 0) {
    cur = new Date(cur.getTime() + DAY);
    if (isBusinessDay(iso(cur))) left -= 1;
  }
  return iso(cur);
}

/** 休日なら次の営業日。営業日ならそのまま。 */
export function nextBusinessDay(date: string | null | undefined): string | null {
  const d = parse(date);
  if (!d) return null;
  let cur = d;
  while (!isBusinessDay(iso(cur))) cur = new Date(cur.getTime() + DAY);
  return iso(cur);
}
