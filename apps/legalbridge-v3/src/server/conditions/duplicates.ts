import { type Transactable, dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ConditionWriteService } from "./write-service.js";

/**
 * 同じ内容で重複している条件明細を見つけて畳む。
 *
 * ★ この道具は「判じない」ことが仕事
 *
 * 以前、明細がバイト単位で同じ検収書3枚を重複と判じて無効にした。実際には
 * 相手先も発注番号も口座も違う、4人ぶんの別々の取引だった。同じ作業を4人に
 * 頼めば、明細は同じ文字になる。
 *
 * そこから2つ決めてある。
 *
 * 1. 指紋に相手先・作品・金額・期間・名前を全部入れる。どれか1つでも違えば
 *    別物として扱う。狭すぎて拾えない重複は人が探せばよいが、広すぎて
 *    拾ってしまった別物は、無効にしてから気づくことになる。
 * 2. 中身（実績・文書・支払）を持っている条件が束に2本以上あれば、機械は
 *    どちらを残すか決めない。そう言って人に返す。
 *
 * ★ 無効化には歯止めを付ける
 *
 * conditions の無効化そのもの（ConditionWriteService.void）は、実績や紙を
 * 抱えたままでも通る。重複整理でそれをやると、発行済みの紙が無効な条件を
 * 指したまま残る。ここでは中身を持つ条件は畳まず、理由を返す。
 */

export interface DuplicateMember {
  id: number;
  conditionNo: string | null;
  name: string;
  status: string;
  createdAt: string | null;
  /** その条件がぶら下げているもの。畳めるかはこれで決まる。 */
  carries: {
    events: number; documents: number; payments: number;
    schedules: number; children: number;
  };
  /** 中身を持っているか（実績・文書・支払のどれか）。 */
  hasRecords: boolean;
  /** 畳めない理由。畳めるなら null。 */
  blocked: string | null;
}

export interface DuplicateGroup {
  /** 指紋。相手先・作品・種別・計算方式・金額・期間・名前。 */
  key: string;
  partyName: string | null;
  workTitle: string | null;
  name: string;
  kind: string;
  pricingModel: string;
  amount: number | null;
  termStart: string | null;
  termEnd: string | null;
  members: DuplicateMember[];
  /** 残す1本。決められないときは null。 */
  keepId: number | null;
  /** 畳める候補。決められないときは空。 */
  voidIds: number[];
  verdict: "keep_one" | "all_empty" | "undecidable";
  note: string;
}

export interface DuplicateView {
  matter: { id: number; matterNo: string | null; title: string };
  groups: DuplicateGroup[];
  summary: { groups: number; conditions: number; voidable: number; undecidable: number };
}

export class ConditionDuplicateService {
  constructor(
    private readonly database: Transactable,
    private readonly writes = new ConditionWriteService(database)
  ) {}

  async forMatter(matterId: number): Promise<DuplicateView> {
    try {
      const head = await this.database.query(
        "SELECT id, matter_no, title FROM matters WHERE id = $1", [matterId]);
      const matter = head.rows[0] as
        { id: number; matter_no: string | null; title: string } | undefined;
      if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.status, c.created_at,
                c.kind, c.pricing_model,
                COALESCE(c.flat_amount, c.unit_amount) AS amount, c.rate_ppm,
                c.term_start, c.term_end,
                c.counterparty_id, p.name AS party_name,
                c.work_id, w.title AS work_title,
                (SELECT count(*)::int FROM condition_events e
                  WHERE e.condition_id = c.id AND e.status = 'active')        AS events,
                (SELECT count(*)::int FROM document_conditions dc
                   JOIN documents d ON d.id = dc.document_id AND d.status <> 'void'
                  WHERE dc.condition_id = c.id)                               AS documents,
                (SELECT count(*)::int FROM payment_allocations al
                   JOIN payments y ON y.id = al.payment_id AND y.status <> 'canceled'
                  WHERE al.condition_id = c.id)                               AS payments,
                (SELECT count(*)::int FROM condition_schedules s
                  WHERE s.condition_id = c.id)                                AS schedules,
                (SELECT count(*)::int FROM conditions x
                  WHERE x.parent_id = c.id AND x.status <> 'void')            AS children
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works   w ON w.id = c.work_id
          WHERE c.status IN ('active', 'draft', 'scheduled')
            AND EXISTS (SELECT 1 FROM matter_links ml
                         WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
                           AND ml.target_ref = c.id::text)
          ORDER BY c.id`, [matterId]);

      const byKey = new Map<string, DuplicateGroup>();
      for (const row of r.rows as any[]) {
        const key = fingerprintOf(row);
        const group = byKey.get(key) ?? {
          key,
          partyName: str(row.party_name), workTitle: str(row.work_title),
          name: String(row.name ?? ""), kind: String(row.kind ?? ""),
          pricingModel: String(row.pricing_model ?? ""),
          amount: int(row.amount),
          termStart: dateStr(row.term_start), termEnd: dateStr(row.term_end),
          members: [], keepId: null, voidIds: [], verdict: "undecidable", note: ""
        };
        group.members.push(memberOf(row));
        byKey.set(key, group);
      }

      const groups = [...byKey.values()]
        .filter((g) => g.members.length > 1)
        .map(decide)
        .sort((a, b) => (a.verdict === "undecidable" ? -1 : 0) - (b.verdict === "undecidable" ? -1 : 0)
          || (a.partyName ?? "").localeCompare(b.partyName ?? "", "ja"));

      return {
        matter: { id: Number(matter.id), matterNo: str(matter.matter_no),
                  title: String(matter.title ?? "") },
        groups,
        summary: {
          groups: groups.length,
          conditions: groups.reduce((a, g) => a + g.members.length, 0),
          voidable: groups.reduce((a, g) => a + g.voidIds.length, 0),
          undecidable: groups.filter((g) => g.verdict === "undecidable").length
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 選んだ重複を畳む。
   *
   * 中身を持っている条件は畳まない。抱えたまま無効にすると、発行済みの紙が
   * 無効な条件を指したまま残る。紙ごと畳みたいなら案件の「旧分を畳む」を
   * 先に通してから、ここへ来る。
   */
  async voidAll(matterId: number, conditionIds: number[], reason: string, actor: string) {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "無効にする理由を書いてください");
    const ids = [...new Set(conditionIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "無効にする条件を選んでください");

    const view = await this.forMatter(matterId);
    const known = new Map<number, DuplicateMember>();
    for (const g of view.groups) for (const m of g.members) known.set(m.id, m);

    const outcomes: Array<{ id: number; conditionNo: string | null;
                            ok: boolean; error: string | null }> = [];
    for (const id of ids) {
      const member = known.get(id);
      if (!member) {
        outcomes.push({ id, conditionNo: null, ok: false,
                        error: "この案件の重複の中にありません" });
        continue;
      }
      if (member.blocked) {
        outcomes.push({ id, conditionNo: member.conditionNo, ok: false, error: member.blocked });
        continue;
      }
      try {
        await this.writes.void(id, why, actor);
        outcomes.push({ id, conditionNo: member.conditionNo, ok: true, error: null });
      } catch (error) {
        outcomes.push({ id, conditionNo: member.conditionNo, ok: false,
                        error: error instanceof Error ? error.message : String(error) });
      }
    }
    await recordAudit(this.database, {
      actor, action: "condition.duplicates_void", targetType: "matter", targetId: matterId,
      detail: { reason: why, conditionIds: ids,
                ok: outcomes.filter((o) => o.ok).length,
                failed: outcomes.filter((o) => !o.ok).length }
    });
    return {
      ok: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o) => !o.ok).length,
      outcomes
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * 同じ内容かどうかの指紋。
 *
 * 相手先・作品・種別・計算方式・金額・料率・契約期間・名前を全部入れる。
 * どれか1つでも違えば別物。金額と名前だけで括ると、同じ作業を4人に頼んだ
 * 束が1本に見える（実際にそれで本物の紙を3枚消した）。
 */
export function fingerprintOf(row: {
  counterparty_id?: unknown; work_id?: unknown; kind?: unknown; pricing_model?: unknown;
  amount?: unknown; rate_ppm?: unknown; term_start?: unknown; term_end?: unknown; name?: unknown;
}): string {
  return [
    String(row.counterparty_id ?? ""), String(row.work_id ?? ""),
    String(row.kind ?? ""), String(row.pricing_model ?? ""),
    String(row.amount ?? ""), String(row.rate_ppm ?? ""),
    dateStr(row.term_start) ?? "", dateStr(row.term_end) ?? "",
    String(row.name ?? "").trim()
  ].join("\u0001");
}

function memberOf(row: any): DuplicateMember {
  const carries = {
    events: Number(row.events ?? 0), documents: Number(row.documents ?? 0),
    payments: Number(row.payments ?? 0), schedules: Number(row.schedules ?? 0),
    children: Number(row.children ?? 0)
  };
  const hasRecords = carries.events > 0 || carries.documents > 0 || carries.payments > 0;
  const held = [
    carries.events && `実績 ${carries.events} 件`,
    carries.documents && `文書 ${carries.documents} 枚`,
    carries.payments && `支払 ${carries.payments} 件`,
    carries.children && `派生条件 ${carries.children} 本`
  ].filter(Boolean).join("・");
  return {
    id: Number(row.id), conditionNo: str(row.condition_no),
    name: String(row.name ?? ""), status: String(row.status ?? ""),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    carries, hasRecords,
    // 中身を抱えたまま無効にすると、発行済みの紙が無効な条件を指したまま残る。
    blocked: hasRecords || carries.children
      ? `${held}がぶら下がっています。先に紙と支払を畳んでください`
      : null
  };
}

/**
 * どれを残すか。
 *
 * 中身を持つものが1本だけなら、それを残して空の残りを畳む。全部空なら
 * いちばん古い1本を残す（番号の若いほうが先に相手へ出ている見込み）。
 * 2本以上が中身を持っていたら**決めない**。同じ内容に見えても別々の取引
 * だったことがある。
 */
export function decide(group: DuplicateGroup): DuplicateGroup {
  const withRecords = group.members.filter((m) => m.hasRecords || m.carries.children);
  if (withRecords.length > 1) {
    return { ...group, keepId: null, voidIds: [], verdict: "undecidable",
      note: `${withRecords.length} 本が中身を持っています。`
        + "同じ内容に見えても別々の取引だったことがあるので、機械では決めません。"
        + "1本ずつ中身を見てください" };
  }
  if (withRecords.length === 1) {
    const keep = withRecords[0]!;
    return { ...group, keepId: keep.id,
      voidIds: group.members.filter((m) => m.id !== keep.id && !m.blocked).map((m) => m.id),
      verdict: "keep_one",
      note: `${keep.conditionNo ?? `#${keep.id}`} だけが中身を持っています。残りは空です` };
  }
  const oldest = [...group.members].sort((a, b) => a.id - b.id)[0]!;
  return { ...group, keepId: oldest.id,
    voidIds: group.members.filter((m) => m.id !== oldest.id).map((m) => m.id),
    verdict: "all_empty",
    note: "どれも中身を持っていません。いちばん古い1本を残す案にしてあります"
      + "（残すものは選び直せます）" };
}
