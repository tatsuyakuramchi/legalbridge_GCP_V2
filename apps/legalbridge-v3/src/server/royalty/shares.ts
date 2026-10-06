import type { Queryable } from "../core/db.js";
import { int, str } from "../core/db.js";
import { DomainError } from "../core/errors.js";

/**
 * 共著の取り分（A-068。docs/royalty-shares.md）。
 *
 * 作品に対する許諾料率は条件明細 1 本（全体率）が持つ。当社から複数の権利者へ
 * 直接払う作品だけ、条件に「誰に何 %」の取り分明細が付く。計算は条件 1 本で
 * 全体額を出し、ここで受取人ごとの額に割る。
 */

export const SHARE_TOTAL_PPM = 1_000_000;

export interface ConditionShareRow {
  partyId: number;
  partyName: string;
  partyKind: string | null;
  sharePpm: number;
  sortOrder: number;
  note: string | null;
}

/**
 * 全体額を取り分で割る。
 *
 * 決まり（事業部と合意）：
 *   1. 受取人ごとに 全体額 × 取り分 を四捨五入する。
 *   2. 四捨五入の合計が全体額を超えたら、繰り上げ幅（四捨五入で増えた端数）が
 *      大きい行から順に 1 円ずつ引いて全体額に収める。同点なら後ろの行から引く。
 *   3. 合計が全体額を下回るぶんはそのまま（全体率を超えないことだけを守る）。
 *
 * 例：9,045 を 50/50 → 4,522.5 と 4,522.5 → 四捨五入で 4,523 × 2 = 9,046 は
 * 超過なので、後ろの行を 4,522 にして 4,523 + 4,522 = 9,045。
 */
export function allocateShares(total: number, sharesPpm: number[]): number[] {
  if (!sharesPpm.length) return [];
  const whole = Math.round(Number(total) || 0);
  const exact = sharesPpm.map((ppm) => (whole * (Number(ppm) || 0)) / SHARE_TOTAL_PPM);
  const out = exact.map((v) => Math.round(v));
  let over = out.reduce((a, b) => a + b, 0) - whole;
  if (over <= 0) return out;
  // 繰り上げ幅の大きい順。同点なら後ろ（index の大きい方）を先に引く。
  const order = out.map((v, i) => ({ i, up: v - exact[i] }))
    .sort((a, b) => (b.up - a.up) || (b.i - a.i))
    .map((x) => x.i);
  for (const i of order) {
    if (over <= 0) break;
    if (out[i] > 0) { out[i] -= 1; over -= 1; }
  }
  return out;
}

/** 条件の取り分明細。無ければ空（＝条件の相手先 1 者に 100%）。 */
export async function loadShares(client: Queryable, conditionId: number): Promise<ConditionShareRow[]> {
  // 取り分は改訂の系列で 1 組。どの版から引いても、いちばん新しい版に付いた組を返す。
  const r = await client.query(
    `WITH series AS (
       SELECT x.id FROM conditions x
        WHERE COALESCE(x.series_id, x.id) = (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = $1)
     ), latest AS (
       SELECT max(s.condition_id) AS condition_id FROM condition_shares s WHERE s.condition_id IN (SELECT id FROM series)
     )
     SELECT s.party_id, p.name AS party_name, p.kind AS party_kind, s.share_ppm, s.sort_order, s.note
       FROM condition_shares s
       JOIN parties p ON p.id = s.party_id
      WHERE s.condition_id = (SELECT condition_id FROM latest)
      ORDER BY s.sort_order, s.id`, [conditionId]);
  return (r.rows as Array<Record<string, any>>).map((row) => ({
    partyId: Number(row.party_id),
    partyName: String(row.party_name ?? ""),
    partyKind: str(row.party_kind),
    sharePpm: Number(row.share_ppm),
    sortOrder: int(row.sort_order) ?? 0,
    note: str(row.note)
  }));
}

/** 取り分のある条件で受取人を選んでいるか確かめ、その行を返す。 */
export function pickShare(shares: ConditionShareRow[], payeePartyId: number | null | undefined): ConditionShareRow | null {
  if (!shares.length) {
    if (payeePartyId) {
      throw new DomainError("VALIDATION", "この条件には取り分がありません。受取人は条件の相手先です");
    }
    return null;
  }
  if (!payeePartyId) {
    throw new DomainError("VALIDATION",
      `取り分のある条件です。受取人を選んでください（${shares.map((s) => `${s.partyName} ${s.sharePpm / 10000}%`).join("・")}）`);
  }
  const found = shares.find((s) => s.partyId === Number(payeePartyId));
  if (!found) {
    throw new DomainError("VALIDATION", "選んだ受取人はこの条件の取り分にありません");
  }
  return found;
}

/** 取り分の入力の検証。合計 100%、同じ権利者は 1 回、2 者以上（1 者なら取り分は要らない）。 */
export function validateShareInput(
  rows: Array<{ partyId: number; sharePpm: number }>
): void {
  if (!rows.length) return;
  if (rows.length < 2) {
    throw new DomainError("VALIDATION", "取り分は 2 者以上で入れてください（1 者なら条件の相手先だけで足ります）");
  }
  const seen = new Set<number>();
  let sum = 0;
  for (const row of rows) {
    const id = Number(row.partyId);
    if (!(id > 0)) throw new DomainError("VALIDATION", "権利者を選んでください");
    if (seen.has(id)) throw new DomainError("VALIDATION", "同じ権利者が 2 回入っています");
    seen.add(id);
    const ppm = Number(row.sharePpm);
    if (!Number.isInteger(ppm) || ppm <= 0 || ppm > SHARE_TOTAL_PPM) {
      throw new DomainError("VALIDATION", "取り分は 0% より大きく 100% 以下で入れてください");
    }
    sum += ppm;
  }
  if (sum !== SHARE_TOTAL_PPM) {
    throw new DomainError("VALIDATION", `取り分の合計を 100% にしてください（いまは ${sum / 10000}%）`);
  }
}
