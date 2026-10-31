import { str, type Queryable } from "../core/db.js";

/**
 * 報告（実績）ごとの、受取人の計算書のそろい具合（A-068 共著の取り分）。
 *
 * 「当社が各人に払う」取り分のある条件では、1 つの報告から受取人ごとに計算書が 1 枚ずつ出る。
 * 報告（condition_events.document_id）は最初に出した 1 枚だけを指し、ほかの受取人の計算書は明細
 * （statement_lines.event_id）で報告に繋がる。document_id だけで「計算書済」と読むと、1 人目を出した時点で
 * 済になってしまうので、受取人ごとの計算書がそろったかをここで数える。
 * 代表が受け取って分ける条件・取り分の無い条件は、1 枚で済（required が空）。
 */

export interface PayeeCoverage {
  /** 計算書が要る受取人（当社が各人に払う取り分のときだけ）。 */
  required: Array<{ partyId: number; name: string }>;
  /** 決定した計算書のある受取人。 */
  issued: number[];
  /** この報告に明細で繋がっている、決定した計算書（document_id 以外も含む）。 */
  documentIds: number[];
}

/** 受取人の計算書がそろったか。取り分の無い・代表が分ける報告は常に true（document_id で判断する）。 */
export const payeesComplete = (c: PayeeCoverage | undefined): boolean =>
  !c || !c.required.length || c.required.every((p) => c.issued.includes(p.partyId));

/** まだ計算書の無い受取人の名前。 */
export const missingPayees = (c: PayeeCoverage | undefined): string[] =>
  !c ? [] : c.required.filter((p) => !c.issued.includes(p.partyId)).map((p) => p.name);

/**
 * 組み立て（純粋関数）。events は報告と系列、shares は系列ごとの取り分（いちばん新しい版のもの）と分配の仕方、
 * lines は決定した計算書の明細（報告・受取人・文書）。
 */
export function buildCoverage(
  events: Array<{ eventId: number; series: number }>,
  shares: Array<{ series: number; conditionId: number; partyId: number; name: string; distribution: string | null }>,
  lines: Array<{ eventId: number; payeePartyId: number | null; documentId: number }>
): Map<number, PayeeCoverage> {
  const out = new Map<number, PayeeCoverage>();
  for (const e of events) {
    const mine = shares.filter((s) => s.series === e.series);
    // 改訂で版が変わっていれば、いちばん新しい版の取り分。
    const latest = mine.length ? Math.max(...mine.map((s) => s.conditionId)) : null;
    const current = mine.filter((s) => s.conditionId === latest);
    const direct = current.length > 0 && current[0].distribution !== "representative";
    const own = lines.filter((l) => l.eventId === e.eventId);
    out.set(e.eventId, {
      required: direct ? current.map((s) => ({ partyId: s.partyId, name: s.name })) : [],
      issued: [...new Set(own.map((l) => l.payeePartyId).filter((x): x is number => x !== null))],
      documentIds: [...new Set(own.map((l) => l.documentId))]
    });
  }
  return out;
}

/** 報告ごとの受取人の計算書のそろい具合を引く。 */
export async function payeeCoverage(q: Queryable, eventIds: number[]): Promise<Map<number, PayeeCoverage>> {
  if (!eventIds.length) return new Map();
  const ev = (await q.query(
    `SELECT e.id AS event_id, COALESCE(c.series_id, c.id) AS series
       FROM condition_events e JOIN conditions c ON c.id = e.condition_id
      WHERE e.id = ANY($1::bigint[])`, [eventIds])).rows as Array<{ event_id: number; series: number }>;
  const series = [...new Set(ev.map((e) => Number(e.series)))];
  const sh = series.length ? (await q.query(
    `SELECT COALESCE(x.series_id, x.id) AS series, x.id AS condition_id, s.party_id, p.name,
            to_jsonb(x) ->> 'distribution' AS distribution
       FROM condition_shares s
       JOIN conditions x ON x.id = s.condition_id
       JOIN parties p ON p.id = s.party_id
      WHERE COALESCE(x.series_id, x.id) = ANY($1::bigint[]) AND x.status <> 'void'
      ORDER BY s.sort_order, s.id`, [series])).rows as Array<Record<string, any>> : [];
  const ln = (await q.query(
    `SELECT l.event_id, s.payee_party_id, s.document_id
       FROM statement_lines l
       JOIN statements s ON s.id = l.statement_id
       JOIN documents d ON d.id = s.document_id AND d.status = 'issued'
      WHERE l.event_id = ANY($1::bigint[])`, [eventIds])).rows as Array<Record<string, any>>;
  return buildCoverage(
    ev.map((e) => ({ eventId: Number(e.event_id), series: Number(e.series) })),
    sh.map((s) => ({ series: Number(s.series), conditionId: Number(s.condition_id), partyId: Number(s.party_id),
                     name: String(s.name ?? ""), distribution: str(s.distribution) })),
    ln.map((l) => ({ eventId: Number(l.event_id), payeePartyId: l.payee_party_id === null ? null : Number(l.payee_party_id),
                     documentId: Number(l.document_id) })));
}
