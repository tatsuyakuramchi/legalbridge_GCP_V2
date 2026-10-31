import { inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import { WORK_LINEAGE_UP_SQL, timingOf, type Timing } from "../royalty/ledger-service.js";
import { ppmToPct } from "../royalty/economics.js";

/**
 * 監査 › 条件の点検（docs/navigation.md §6）。
 *
 * 入金の突き合わせ・計算書・回号を狂わせる条件を洗い出す。直すのは各画面（条件明細）だが、
 * 決済の型だけはここで決められる（台帳の出し方と同じ PUT /royalty-ledger/timing）。
 *
 *   重複         … 同じ作者 × 作品 × 構成要素 × 利用形態 × 対象の許諾先 に生きた許諾（IN）の条件が 2 本以上。
 *                  入金・報告がどちらに付くか決まらない。
 *   決済の型が空 … 許諾料の条件で決済の型（settlement_mode）が無い。出し方（時限式／イベント式）が推測のまま。
 *   根拠の文書なし … 許諾（IN）の条件が契約に載っておらず、決定済みの文書にも繋がっていない。
 *   作者に届かない許諾 … 再許諾・他社販売の許諾（OUT）に、効く作者の条件が 1 本も無い。入金しても作者に払いが出ない。
 */

export interface CheckCondition {
  id: number; conditionNo: string | null; name: string;
  partyId: number | null; partyName: string | null; workId: number | null; workTitle: string | null;
  usageType: string | null; usageLabel: string; ratePct: number | null;
  settlementMode: string | null; timing: Timing; agreementNo: string | null;
  /** 付いている報告（実績）と、決定した文書の数。まとめるときにどちらを残すかの目安。 */
  events: number; documents: number;
}
export interface ConditionCheck {
  duplicates: Array<{ key: string; conditions: CheckCondition[] }>;
  noMode: CheckCondition[];
  noBasis: CheckCondition[];
  uncovered: CheckCondition[];
}

const SELECT = `
  SELECT c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name, c.work_id, w.title AS work_title,
         c.usage_type, c.rate_ppm, c.pricing_model, c.settlement_mode, c.statement_timing, c.work_part_id, c.target_party_id,
         COALESCE(m.agreement_no, m_d.agreement_no) AS agreement_no,
         (SELECT count(*)::int FROM condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS events,
         (SELECT count(DISTINCT d.id)::int FROM document_conditions dc JOIN documents d ON d.id = dc.document_id
           WHERE dc.condition_id = c.id AND d.status = 'issued') AS documents
    FROM conditions c
    LEFT JOIN parties p ON p.id = c.counterparty_id
    LEFT JOIN works w ON w.id = c.work_id
    LEFT JOIN agreements m_d ON m_d.id = c.agreement_id
    LEFT JOIN agreements m ON m.id = CASE WHEN m_d.kind IN ('supplement', 'termination') THEN m_d.parent_id ELSE m_d.id END`;

const LIVE_IN = `c.direction = 'in' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')`;

const toCondition = (c: Record<string, any>): CheckCondition => ({
  id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
  partyId: int(c.counterparty_id), partyName: str(c.party_name), workId: int(c.work_id), workTitle: str(c.work_title),
  usageType: str(c.usage_type), usageLabel: conditionUsageLabel(c.usage_type),
  ratePct: c.rate_ppm === null || c.rate_ppm === undefined ? null : ppmToPct(Number(c.rate_ppm)),
  settlementMode: str(c.settlement_mode), timing: timingOf(c.statement_timing, c.usage_type, c.settlement_mode),
  agreementNo: str(c.agreement_no), events: Number(c.events ?? 0), documents: Number(c.documents ?? 0)
});

/** 重複のまとまり（純粋関数）。同じ作者 × 作品 × 構成要素 × 利用形態 × 対象の許諾先。 */
export function duplicateGroups(rows: Array<Record<string, any>>): Array<{ key: string; conditions: CheckCondition[] }> {
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const r of rows) {
    if (!r.work_id || !r.counterparty_id) continue;
    const key = [r.counterparty_id, r.work_id, r.work_part_id ?? "", r.usage_type ?? "", r.target_party_id ?? ""].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, conditions: list.map(toCondition) }));
}

/**
 * まとめられない理由（純粋関数）。残す条件 keep に寄せる条件 drop の状態から。
 * 決定した文書・支払・計算書・共著の取り分が付いた条件は、寄せると紙と台帳が食い違うので扱わない
 * （条件明細で個別に整理する）。料率・単価・通貨が違えば重複ではない（別の取り決め）。
 */
export function mergeBlockers(keep: Record<string, any>, drop: Record<string, any>): string[] {
  const out: string[] = [];
  const same = (k: string) => String(keep[k] ?? "") === String(drop[k] ?? "");
  for (const k of ["counterparty_id", "work_id", "work_part_id", "usage_type", "target_party_id"]) {
    if (!same(k)) out.push("作者・作品・構成要素・利用形態・対象の許諾先が同じ条件だけまとめられます");
  }
  if (!same("rate_ppm") || !same("unit_amount") || !same("currency")) out.push("料率・単価・通貨が違うので重複ではありません（別の取り決め）");
  if (Number(drop.documents ?? 0) > 0) out.push("寄せる条件に決定した文書があります");
  if (Number(drop.payments ?? 0) > 0) out.push("寄せる条件に支払が立っています");
  if (Number(drop.statements ?? 0) > 0) out.push("寄せる条件に計算書があります");
  if (Number(drop.shares ?? 0) > 0) out.push("寄せる条件に共著の取り分があります");
  if (!["active", "scheduled"].includes(String(keep.status)) || !["active", "scheduled"].includes(String(drop.status))) {
    out.push("生きている条件どうしだけまとめられます");
  }
  return [...new Set(out)];
}

export class ConditionCheckService {
  constructor(private readonly database: Queryable & Partial<Transactable>) {}

  /**
   * 重複した条件をまとめる。drop の報告（実績）・予定の行・依頼の繋がりを keep に移し、drop を無効にする。
   * 報告は回（drop の締め）から外し、keep の回へは発生日で入る。
   */
  async merge(keepId: number, dropIds: number[], actor: string): Promise<{ keep: number; dropped: number[]; movedEvents: number }> {
    const ids = [...new Set(dropIds.filter((x) => x !== keepId))];
    if (!ids.length) throw new DomainError("VALIDATION", "寄せる条件を選んでください");
    try {
      return await inTransaction(this.database as Transactable, async (client) => {
        const rows = (await client.query(
          `SELECT c.id, c.condition_no, c.status, c.counterparty_id, c.work_id, c.work_part_id, c.usage_type, c.target_party_id,
                  c.rate_ppm, c.unit_amount, c.currency,
                  (SELECT count(DISTINCT d.id)::int FROM document_conditions dc JOIN documents d ON d.id = dc.document_id
                    WHERE dc.condition_id = c.id AND d.status = 'issued') AS documents,
                  (SELECT count(*)::int FROM payment_allocations al JOIN payments p ON p.id = al.payment_id
                    WHERE al.condition_id = c.id AND p.status <> 'canceled') AS payments,
                  (SELECT count(*)::int FROM statements st WHERE st.condition_id = c.id) AS statements,
                  (SELECT count(*)::int FROM condition_shares sh WHERE sh.condition_id = c.id) AS shares
             FROM conditions c WHERE c.id = ANY($1::bigint[]) FOR UPDATE OF c`, [[keepId, ...ids]])).rows as Array<Record<string, any>>;
        const keep = rows.find((r) => Number(r.id) === keepId);
        if (!keep) throw new DomainError("NOT_FOUND", `条件 ${keepId} が見つかりません`);
        let moved = 0;
        for (const id of ids) {
          const drop = rows.find((r) => Number(r.id) === id);
          if (!drop) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
          const blockers = mergeBlockers(keep, drop);
          if (blockers.length) {
            throw new DomainError("CONFLICT", `${drop.condition_no ?? `#${id}`} はまとめられません：${blockers.join("／")}`);
          }
          const ev = await client.query(
            `UPDATE condition_events SET condition_id = $2, schedule_id = NULL
              WHERE condition_id = $1 AND status = 'active' RETURNING id`, [id, keepId]);
          moved += ev.rows.length;
          await client.query("UPDATE royalty_expected_lines SET condition_id = $2 WHERE condition_id = $1", [id, keepId]);
          await client.query(
            `UPDATE intake_request_links SET target_id = $2
              WHERE target_type = 'condition' AND target_id = $1
                AND NOT EXISTS (SELECT 1 FROM intake_request_links x
                                 WHERE x.request_id = intake_request_links.request_id AND x.target_type = 'condition' AND x.target_id = $2)`,
            [id, keepId]);
          await client.query(
            `UPDATE conditions SET status = 'void', updated_at = now(),
                    notes = concat_ws(E'\n', NULLIF(notes, ''), $2::text)
              WHERE id = $1`, [id, `無効化：${keep.condition_no ?? `#${keepId}`} と重複していたのでまとめた`]);
          await recordAudit(client, {
            actor, action: "condition.merge", targetType: "condition", targetId: keepId,
            detail: { dropped: id, droppedNo: str(drop.condition_no), movedEvents: ev.rows.map((r: any) => Number(r.id)) }
          });
          await recordAudit(client, {
            actor, action: "condition.void", targetType: "condition", targetId: id,
            detail: { reason: `重複のため ${keep.condition_no ?? `#${keepId}`} にまとめた`, mergedInto: keepId }
          });
        }
        return { keep: keepId, dropped: ids, movedEvents: moved };
      });
    } catch (error) { throw translate(error); }
  }

  async run(): Promise<ConditionCheck> {
    const q = this.database;
    try {
      const live = (await q.query(`${SELECT} WHERE ${LIVE_IN} ORDER BY p.name, w.title, c.condition_no NULLS LAST, c.id`)).rows as Array<Record<string, any>>;
      const noMode = live.filter((c) => !c.settlement_mode && ["revenue_rate", "unit_rate"].includes(String(c.pricing_model ?? "")));
      const noBasis = (await q.query(
        `${SELECT} WHERE ${LIVE_IN} AND c.agreement_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM document_conditions dc JOIN documents d ON d.id = dc.document_id
                             WHERE dc.condition_id = c.id AND d.status = 'issued')
          ORDER BY p.name, w.title, c.id`)).rows as Array<Record<string, any>>;
      const uncovered = (await q.query(
        `${SELECT} WHERE c.direction = 'out' AND c.status IN ('active', 'scheduled')
            AND c.usage_type IN ('sublicense', 'oem') AND c.work_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM conditions i
                             WHERE i.direction = 'in' AND i.kind = 'license' AND i.status IN ('active', 'scheduled')
                               AND i.usage_type = c.usage_type
                               AND i.work_id = ANY(${WORK_LINEAGE_UP_SQL("c.work_id")})
                               AND (i.target_party_id IS NULL OR i.target_party_id = c.counterparty_id))
          ORDER BY p.name, w.title, c.id`)).rows as Array<Record<string, any>>;
      return {
        duplicates: duplicateGroups(live),
        noMode: noMode.map(toCondition),
        noBasis: noBasis.map(toCondition),
        uncovered: uncovered.map(toCondition)
      };
    } catch (error) { throw translate(error); }
  }
}
