import { int, str, type Queryable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import { timingOf, type Timing } from "../royalty/ledger-service.js";
import { ppmToPct } from "../royalty/economics.js";
import type { RoyaltyReceiptService } from "../royalty/receipts.js";

/**
 * 作品 › 権利とお金の流れ（docs/navigation.md §5）。
 *
 *   作者（IN 条件）── 当社の作品（原作 → この作品 → 派生作品）── 取引先（OUT 条件）
 *
 * 取引先からの入金は OUT 条件に基づいて受け取り、作者へ IN 条件に基づいて払う。どの許諾先の入金が
 * どの作者に払いになるかは、台帳・入金のパネルと同じ決まりで決める（同じ利用形態・IN の作品が OUT の
 * 作品かその祖先・許諾先専用の条件が勝つ）。画面に見える関係と実際のお金の流れが食い違わないように。
 */

export interface FlowWork { id: number; title: string }
export interface FlowIn {
  id: number; conditionNo: string | null; name: string;
  partyId: number; partyName: string; workId: number | null; workTitle: string | null;
  usageType: string | null; usageLabel: string; pricingModel: string;
  ratePct: number | null; unitAmount: number | null; timing: Timing;
  targetPartyId: number | null; targetPartyName: string | null;
}
export interface FlowOut {
  id: number; conditionNo: string | null; name: string;
  partyId: number; partyName: string; workId: number | null; workTitle: string | null;
  usageType: string | null; usageLabel: string; languages: string[]; regions: string[];
  agreementNo: string | null;
  /** この許諾先の入金で払いが出る作者の条件。 */
  covers: number[];
}
export interface FlowMoney {
  outId: number;
  /** 直近 12 か月に入金済みの額（この許諾先に割り当てたもの）。 */
  received: number;
  /** 作者（取引先 id）ごとの、この許諾先からの報告で出た許諾料。 */
  byAuthor: Record<number, number>;
  /** 作者の報告・計算書が済んでいない入金の件数。 */
  open: number;
}
export interface FlowWarning { kind: "uncovered" | "missing_author" | "duplicate"; message: string; conditionIds: number[] }

export interface RightsFlow {
  work: FlowWork;
  /** 元の作品（近い順）。 */
  ancestors: FlowWork[];
  /** 派生作品（言語版など）。 */
  descendants: FlowWork[];
  ins: FlowIn[]; outs: FlowOut[];
  money: FlowMoney[];
  warnings: FlowWarning[];
}

/**
 * OUT 条件に効く IN 条件（純粋関数）。lineageOf は作品 → その作品と祖先の id。
 * 同じ利用形態・IN の作品が OUT の作品かその祖先・許諾先専用の条件はその許諾先だけで、ある作者に専用の条件が
 * あれば、その作者の一律の条件は外す（royalty/receipts.ts の coveringIns と同じ）。
 */
export function coversOf(out: Pick<FlowOut, "usageType" | "workId" | "partyId">, ins: FlowIn[],
                         lineageOf: (workId: number) => number[]): number[] {
  if (!out.workId) return [];
  const up = lineageOf(out.workId);
  const candidates = ins.filter((c) => c.usageType === out.usageType && c.workId !== null && up.includes(c.workId));
  return candidates.filter((c) => {
    if (c.targetPartyId) return c.targetPartyId === out.partyId;
    return !candidates.some((x) => x !== c && x.targetPartyId === out.partyId && x.partyId === c.partyId && x.workId === c.workId);
  }).map((c) => c.id);
}

/** 確かめてほしいこと（純粋関数）。 */
export function flowWarnings(ins: FlowIn[], outs: FlowOut[]): FlowWarning[] {
  const out: FlowWarning[] = [];
  const authors = [...new Map(ins.map((c) => [c.partyId, c.partyName])).entries()];
  for (const o of outs) {
    if (!o.covers.length) {
      out.push({ kind: "uncovered", conditionIds: [o.id],
        message: `許諾先 ${o.partyName}（${o.usageLabel}）に効く作者の条件がありません。入金があっても作者に払いが出ません` });
      continue;
    }
    // ほかの利用形態では許諾料をもらっている作者に、この許諾先からは払いが出ない（条件の入れ忘れのことがある）。
    const covered = new Set(ins.filter((c) => o.covers.includes(c.id)).map((c) => c.partyId));
    const missing = authors.filter(([id]) => !covered.has(id) && ins.some((c) => c.partyId === id && c.usageType !== o.usageType));
    for (const [id, name] of missing) {
      out.push({ kind: "missing_author", conditionIds: [o.id, ...ins.filter((c) => c.partyId === id).map((c) => c.id)],
        message: `許諾先 ${o.partyName}（${o.usageLabel}）の入金は ${name} に払いが出ません（${name} に${o.usageLabel}の条件がありません）` });
    }
  }
  const groups = new Map<string, FlowIn[]>();
  for (const c of ins) {
    const k = `${c.partyId}|${c.workId}|${c.usageType}|${c.targetPartyId ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    out.push({ kind: "duplicate", conditionIds: list.map((c) => c.id),
      message: `${list[0].partyName} × ${list[0].workTitle ?? "作品"} × ${list[0].usageLabel} の条件が ${list.length} 本あります（${list.map((c) => c.conditionNo ?? `#${c.id}`).join("・")}）` });
  }
  return out;
}

const FAMILY_SQL = `
  WITH RECURSIVE up(wid, depth) AS (
    SELECT $1::bigint, 0
    UNION
    SELECT l.parent_work_id, up.depth + 1 FROM work_lineage l JOIN up ON l.child_work_id = up.wid WHERE up.depth < 20
  ), down(wid, depth) AS (
    SELECT $1::bigint, 0
    UNION
    SELECT l.child_work_id, down.depth + 1 FROM work_lineage l JOIN down ON l.parent_work_id = down.wid WHERE down.depth < 20
  )
  SELECT 'up' AS dir, u.wid, min(u.depth) AS depth, w.title FROM up u JOIN works w ON w.id = u.wid GROUP BY u.wid, w.title
  UNION ALL
  SELECT 'down', d.wid, min(d.depth), w.title FROM down d JOIN works w ON w.id = d.wid GROUP BY d.wid, w.title`;

export class WorkRightsFlowService {
  constructor(private readonly database: Queryable, private readonly receipts?: Pick<RoyaltyReceiptService, "list">) {}

  async forWork(workId: number, today = new Date().toISOString().slice(0, 10)): Promise<RightsFlow> {
    const q = this.database;
    try {
      const fam = (await q.query(FAMILY_SQL, [workId])).rows as Array<{ dir: string; wid: number; depth: number; title: string }>;
      const self = fam.find((f) => f.dir === "up" && Number(f.depth) === 0);
      if (!self) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);
      const ancestors = fam.filter((f) => f.dir === "up" && Number(f.depth) > 0).sort((a, b) => a.depth - b.depth)
        .map((f) => ({ id: Number(f.wid), title: String(f.title) }));
      const descendants = fam.filter((f) => f.dir === "down" && Number(f.depth) > 0).sort((a, b) => a.depth - b.depth)
        .map((f) => ({ id: Number(f.wid), title: String(f.title) }));
      const upIds = [workId, ...ancestors.map((w) => w.id)];
      const downIds = [workId, ...descendants.map((w) => w.id)];

      // 作者の条件は この作品とその祖先 に付いたもの、許諾先は この作品とその派生 に付いたもの。
      const inRows = (await q.query(
        `SELECT c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name, c.work_id, w.title AS work_title,
                c.usage_type, c.pricing_model, c.rate_ppm, c.unit_amount, c.statement_timing, c.settlement_mode,
                c.target_party_id, tp.name AS target_party_name
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN parties tp ON tp.id = c.target_party_id
           LEFT JOIN works w ON w.id = c.work_id
          WHERE c.direction = 'in' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
            AND c.pricing_model IN ('revenue_rate', 'unit_rate') AND c.work_id = ANY($1::bigint[])
          ORDER BY p.name, c.condition_no NULLS LAST, c.id`, [upIds])).rows as Array<Record<string, any>>;
      const ins: FlowIn[] = inRows.map((c) => ({
        id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
        partyId: Number(c.counterparty_id), partyName: String(c.party_name ?? ""),
        workId: int(c.work_id), workTitle: str(c.work_title),
        usageType: str(c.usage_type), usageLabel: conditionUsageLabel(c.usage_type), pricingModel: String(c.pricing_model),
        ratePct: c.rate_ppm === null ? null : ppmToPct(Number(c.rate_ppm)), unitAmount: int(c.unit_amount),
        timing: timingOf(c.statement_timing, c.usage_type, c.settlement_mode),
        targetPartyId: int(c.target_party_id), targetPartyName: str(c.target_party_name)
      }));

      const outRows = (await q.query(
        `SELECT c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name, c.work_id, w.title AS work_title,
                c.usage_type, COALESCE(m.agreement_no, m_d.agreement_no) AS agreement_no,
                (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                  WHERE sc.condition_id = c.id AND sc.scope_type = 'language') AS languages,
                (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                  WHERE sc.condition_id = c.id AND sc.scope_type = 'region') AS regions
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
           LEFT JOIN agreements m_d ON m_d.id = c.agreement_id
           LEFT JOIN agreements m ON m.id = CASE WHEN m_d.kind IN ('supplement', 'termination') THEN m_d.parent_id ELSE m_d.id END
          WHERE c.direction = 'out' AND c.status IN ('active', 'scheduled')
            AND c.usage_type IN ('sublicense', 'oem') AND c.work_id = ANY($1::bigint[])
          ORDER BY p.name, c.condition_no NULLS LAST, c.id`, [downIds])).rows as Array<Record<string, any>>;
      // 派生作品の祖先は「この作品の祖先 ＋ この作品から派生作品までの道」。親子の表から作品ごとに引く。
      const links = (await q.query(
        "SELECT parent_work_id, child_work_id FROM work_lineage WHERE child_work_id = ANY($1::bigint[])", [downIds])).rows as
        Array<{ parent_work_id: number; child_work_id: number }>;
      const lineageOf = (id: number): number[] => {
        const seen = new Set<number>([id]);
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop()!;
          for (const l of links.filter((x) => Number(x.child_work_id) === cur)) {
            const parent = Number(l.parent_work_id);
            if (!seen.has(parent)) { seen.add(parent); stack.push(parent); }
          }
          if (cur === workId) for (const a of upIds) seen.add(a);
        }
        return [...seen];
      };
      const strip = (xs: unknown, all: string) => (Array.isArray(xs) ? xs.map(String) : []).filter((x) => x !== all);
      const outs: FlowOut[] = outRows.map((o) => {
        const base = {
          id: Number(o.id), conditionNo: str(o.condition_no), name: String(o.name ?? ""),
          partyId: Number(o.counterparty_id), partyName: String(o.party_name ?? ""),
          workId: int(o.work_id), workTitle: str(o.work_title),
          usageType: str(o.usage_type), usageLabel: conditionUsageLabel(o.usage_type),
          languages: strip(o.languages, "全言語"), regions: strip(o.regions, "全世界"), agreementNo: str(o.agreement_no)
        };
        return { ...base, covers: coversOf(base, ins, lineageOf) };
      });

      // 直近 12 か月のお金。入金は OUT 条件（改訂の全版）に割り当てた入金済みの額、作者への額はその許諾先からの報告の許諾料。
      const from = new Date(`${today}T00:00:00Z`); from.setUTCFullYear(from.getUTCFullYear() - 1);
      const since = from.toISOString().slice(0, 10);
      const outIds = outs.map((o) => o.id);
      const received = outIds.length ? (await q.query(
        `SELECT o.id AS out_id, COALESCE(sum(al.amount), 0)::bigint AS amount
           FROM conditions o
           JOIN conditions x ON COALESCE(x.series_id, x.id) = COALESCE(o.series_id, o.id)
           JOIN payment_allocations al ON al.condition_id = x.id
           JOIN payments p ON p.id = al.payment_id
          WHERE o.id = ANY($1::bigint[]) AND p.direction = 'in' AND p.status = 'paid' AND p.paid_on >= $2::date
          GROUP BY o.id`, [outIds, since])).rows as Array<{ out_id: number; amount: string }> : [];
      const paid = outIds.length ? (await q.query(
        `SELECT o.id AS out_id, c.counterparty_id, COALESCE(sum(e.amount), 0)::bigint AS amount
           FROM conditions o
           JOIN conditions x ON COALESCE(x.series_id, x.id) = COALESCE(o.series_id, o.id)
           JOIN condition_events e ON e.out_condition_id = x.id AND e.status = 'active' AND e.occurred_on >= $2::date
           JOIN conditions c ON c.id = e.condition_id
          WHERE o.id = ANY($1::bigint[])
          GROUP BY o.id, c.counterparty_id`, [outIds, since])).rows as Array<{ out_id: number; counterparty_id: number; amount: string }> : [];
      const money: FlowMoney[] = [];
      for (const o of outs) {
        let open = 0;
        if (this.receipts) {
          const r = await this.receipts.list({ outConditionId: o.id, from: since, state: "open" });
          open = r.receipts.length;
        }
        money.push({
          outId: o.id,
          received: Number(received.find((r) => Number(r.out_id) === o.id)?.amount ?? 0),
          byAuthor: Object.fromEntries(paid.filter((r) => Number(r.out_id) === o.id)
            .map((r) => [Number(r.counterparty_id), Number(r.amount)])),
          open
        });
      }

      return {
        work: { id: workId, title: String(self.title) }, ancestors, descendants,
        ins, outs, money, warnings: flowWarnings(ins, outs)
      };
    } catch (error) { throw translate(error); }
  }
}
