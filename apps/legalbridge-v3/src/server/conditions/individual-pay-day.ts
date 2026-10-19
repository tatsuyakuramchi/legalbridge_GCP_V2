import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, inTransaction, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { INDIVIDUAL_PAY_DAY } from "./payment-terms.js";

/**
 * 個人への支払日を 20 日に揃える（すでに立っている回）。
 *
 * 個人への支払は 20 日が当社の決まり（payment-terms.ts の forPartyKind）。新しく立てる回は
 * そう出るが、決まりを入れる前に立てた回は支払条件の「末日」のまま残っている。
 * 相手先が個人で、支払日が月の末日の回を、同じ月の 20 日に直す。
 *
 * 直さない回:
 *   - 決定済みの文書（計算書・検収書など）に結ばれた実績がある（紙に支払期日を刷ってある。直すなら訂正版）
 *   - 支払が立っている（取り消されていない支払に割り当てた実績がある）
 *   - 支払日が過去（もう払う日が来ている）
 *   - 取得（IN）以外の条件（当社が払う回だけ）
 *
 * 必ず試算（preview）を見てから直す。試算は何も書かない。
 */

export interface PayDayTarget {
  scheduleId: number;
  conditionId: number;
  conditionNo: string | null;
  conditionName: string;
  partyName: string | null;
  label: string | null;
  payOn: string;
  newPayOn: string;
}

const CANDIDATES = `
  SELECT s.id AS schedule_id, s.label, s.pay_on, c.id AS condition_id, c.condition_no, c.name AS condition_name,
         p.name AS party_name
    FROM condition_schedules s
    JOIN conditions c ON c.id = s.condition_id
    JOIN parties p ON p.id = c.counterparty_id
   WHERE p.kind = 'individual' AND c.direction = 'in' AND c.status = 'active'
     AND s.pay_on IS NOT NULL AND s.pay_on >= $1::date
     AND (s.pay_on + 1) = date_trunc('month', s.pay_on + 1)::date
     AND NOT EXISTS (SELECT 1 FROM condition_events e JOIN documents d ON d.id = e.document_id
                      WHERE e.schedule_id = s.id AND e.status = 'active' AND d.status = 'issued')
     AND NOT EXISTS (SELECT 1 FROM condition_events e
                       JOIN payment_allocations a ON a.event_id = e.id
                       JOIN payments pm ON pm.id = a.payment_id
                      WHERE e.schedule_id = s.id AND pm.status <> 'canceled')
   ORDER BY s.pay_on, p.name, c.id, s.seq`;

/** 月の末日を同じ月の 20 日に。 */
export const individualPayDay = (payOn: string): string => `${payOn.slice(0, 8)}${String(INDIVIDUAL_PAY_DAY).padStart(2, "0")}`;

export class IndividualPayDayService {
  constructor(private readonly database: Transactable, private readonly today = () => new Date().toISOString().slice(0, 10)) {}

  async preview(): Promise<{ targets: PayDayTarget[] }> {
    try { return { targets: await this.targets(this.database) }; }
    catch (error) { throw translate(error); }
  }

  /** 選んだ回（scheduleIds）だけ直す。直す直前にもう一度条件を確かめる（その間に文書・支払が立った回は飛ばす）。 */
  async run(scheduleIds: number[], actor: string): Promise<{ updated: number; targets: PayDayTarget[] }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const wanted = new Set(scheduleIds.map(Number));
        const targets = (await this.targets(client)).filter((t) => wanted.has(t.scheduleId));
        for (const t of targets) {
          await client.query("UPDATE condition_schedules SET pay_on = $2::date WHERE id = $1", [t.scheduleId, t.newPayOn]);
        }
        await recordAudit(client, {
          actor, action: "schedule.individual_pay_day", targetType: "condition_schedule", targetId: 0,
          detail: { day: INDIVIDUAL_PAY_DAY,
                    changed: targets.map((t) => ({ scheduleId: t.scheduleId, from: t.payOn, to: t.newPayOn })) }
        });
        return { updated: targets.length, targets };
      });
    } catch (error) { throw translate(error); }
  }

  private async targets(client: Queryable): Promise<PayDayTarget[]> {
    const rows = (await client.query(CANDIDATES, [this.today()])).rows as Array<Record<string, any>>;
    return rows.map((r) => {
      const payOn = dateStr(r.pay_on)!;
      return {
        scheduleId: Number(r.schedule_id), conditionId: Number(r.condition_id),
        conditionNo: str(r.condition_no), conditionName: String(r.condition_name ?? ""),
        partyName: str(r.party_name), label: str(r.label), payOn, newPayOn: individualPayDay(payOn)
      };
    });
  }
}
