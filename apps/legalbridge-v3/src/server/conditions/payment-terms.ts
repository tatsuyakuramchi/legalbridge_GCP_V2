/**
 * 支払条件のテキストから支払期日を出す。
 *
 * 「検収月の翌月末払い」のような文言は conditions.payment_terms に入っているが、
 * これまで人が読むだけで計算には使われていなかった。そのため12回の予定を作っても
 * 各回をいつ払うかは毎回人が数えることになる。
 *
 * 読めない書き方は無理に解釈せず null を返す。間違った期日が黙って入るより、
 * 空欄にして人に入れてもらうほうがよい（支払期日は金の動く日なので、
 * 推測で埋めると気づかないままずれる）。
 */

export interface PaymentTerms {
  /** 起点の月から何ヶ月後か。当月=0・翌月=1・翌々月=2。 */
  monthsAfter: number;
  /** 支払日。月末なら "end"。 */
  day: "end" | number;
}

// 具体的なものから並べる。「翌々月」は「翌月」を含むので、順番が入れ替わると
// 翌々月を翌月と読んでしまう。
const MONTHS: Array<[RegExp, number]> = [
  [/翌\s*々\s*月/, 2],
  [/翌\s*月/, 1],
  [/当\s*月/, 0],
  [/同\s*月/, 0]
];

export function parsePaymentTerms(text: string | null | undefined): PaymentTerms | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  // 全角数字を半角に寄せる。V1 の文言は表記が揺れている。
  const s = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // 「翌翌月」と「翌々月」は同じ意味。先に寄せておかないと「翌月」に読める。
    .replace(/翌\s*翌\s*月/g, "翌々月");

  // 「30日以内」「60日以内」は締め日が要るので、月ベースの規則には落とせない。
  if (/日\s*以内/.test(s)) return null;

  // 「月末締め翌月末払い」のように月の語が複数出るときは、いちばん後ろ＝
  // 払いに近いほうを採る。
  // 終わりの位置で比べる。同じ位置で終わるときは、先に見た＝具体的なほうを残す
  // （「翌々月」と「翌月」は同じ位置で終わる）。
  let monthsAfter: number | null = null;
  let bestEnd = -1;
  for (const [pattern, n] of MONTHS) {
    for (const m of s.matchAll(new RegExp(pattern, "g"))) {
      const end = (m.index ?? 0) + m[0].length;
      if (end > bestEnd) { bestEnd = end; monthsAfter = n; }
    }
  }
  if (monthsAfter === null) return null;

  // 「末払い」「末日払い」
  if (/末\s*日?\s*(締|払|支払)/.test(s) || /末\s*$/.test(s)) return { monthsAfter, day: "end" };
  // 「20日払い」「25日支払」
  const day = s.match(/(\d{1,2})\s*日\s*(締|払|支払)?/);
  if (day) {
    const n = Number(day[1]);
    if (n >= 1 && n <= 31) return { monthsAfter, day: n };
  }
  // 月は読めたが日が読めない。末日と決めつけない。
  return null;
}

/** その月の末日。 */
const lastDay = (year: number, monthIndex: number) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * 起点日（その回が発生する日）と支払条件から、支払期日を出す。
 * 起点が無ければ出せない。
 */
export function payOnFor(dueOn: string | null, terms: PaymentTerms | null): string | null {
  if (!dueOn || !terms) return null;
  const base = new Date(`${dueOn}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;

  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + terms.monthsAfter;
  const target = new Date(Date.UTC(year, month, 1));
  const y = target.getUTCFullYear();
  const m = target.getUTCMonth();

  const day = terms.day === "end" ? lastDay(y, m) : Math.min(terms.day, lastDay(y, m));
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}
