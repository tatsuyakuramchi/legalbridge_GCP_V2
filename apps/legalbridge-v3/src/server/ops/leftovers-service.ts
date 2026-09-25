import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { DISPOSE_ORDER, disposable, heldBy, type DisposeResult, type Leftover, type LeftoverKind }
  from "./leftovers.js";
import type { DocumentIssueService } from "../documents/issue-service.js";
import type { ConditionEventService } from "../conditions/event-service.js";
import type { ConditionWriteService } from "../conditions/write-service.js";

/**
 * 修正の残骸を拾い、選ばれたものを捨てる。
 *
 * 判定（何が捨てられるか）は leftovers.ts、消す手順はそれぞれの持ち主の
 * サービスに任せる。ここは拾って並べ、順番に渡すだけ。断る条件を書き写すと
 * いつか本体とずれる。
 *
 * 捨てるのは1件ずつ独立して流す（inTransaction は入れ子にできないので、
 * まとめて1つの取引にはできない）。途中で断られても、そこまでは捨てたまま
 * 残る。どれが捨てられてどれが断られたかを1件ずつ返す。
 */

/** 条件の削除を止めるもの。write-service の判定と同じ並び。 */
const CONDITION_HOLDERS = `
  (SELECT count(*)::int FROM condition_events WHERE condition_id = c.id)              AS h_events,
  (SELECT count(*)::int FROM condition_events WHERE out_condition_id = c.id)          AS h_out_refs,
  (SELECT count(*)::int FROM document_conditions WHERE condition_id = c.id)           AS h_documents,
  (SELECT count(*)::int FROM payment_allocations WHERE condition_id = c.id)           AS h_payments,
  (SELECT count(*)::int FROM statements WHERE condition_id = c.id)
    + (SELECT count(*)::int FROM statement_lines WHERE condition_id = c.id)           AS h_statements,
  (SELECT count(*)::int FROM matter_links
    WHERE target_type = 'condition' AND target_ref = c.id::text)                      AS h_matters,
  (SELECT count(*)::int FROM conditions WHERE parent_id = c.id)                       AS h_children,
  (SELECT count(*)::int FROM conditions WHERE superseded_by_id = c.id)                AS h_older`;

const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

export class LeftoverService {
  constructor(
    private readonly database: Transactable,
    private readonly parts: {
      documents: DocumentIssueService;
      events: ConditionEventService;
      conditions: ConditionWriteService;
    }
  ) {}

  async list(): Promise<Leftover[]> {
    try {
      const [drafts, events, conditions] = await Promise.all([
        this.drafts(), this.voidedEvents(), this.voidedConditions()
      ]);
      return [...drafts, ...events, ...conditions];
    } catch (error) { throw translate(error); }
  }

  /**
   * 出していない文書。番号を振ったものは対象にしない（出した記録）。
   *
   * 番号の無い void も拾う。発行前に「やっぱり要らない」で無効にしたもので、
   * 外には何も出ていない。
   */
  private async drafts(): Promise<Leftover[]> {
    const r = await this.database.query(
      `SELECT d.id, d.status, d.created_at, d.supersedes_id, d.supersede_reason,
              t.template_key, o.document_no AS supersedes_no,
              (SELECT count(*)::int FROM condition_events e WHERE e.document_id = d.id) AS h_events,
              (SELECT count(*)::int FROM matter_communications m WHERE m.document_id = d.id) AS h_notes,
              (SELECT count(*)::int FROM documents x WHERE x.supersedes_id = d.id) AS h_successors,
              (SELECT string_agg(DISTINCT c.name, '・') FROM document_conditions dc
                 JOIN conditions c ON c.id = dc.condition_id
                WHERE dc.document_id = d.id) AS condition_names,
              m.matter_no
         FROM documents d
         LEFT JOIN documents o ON o.id = d.supersedes_id
         LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
         LEFT JOIN document_templates t ON t.id = tv.template_id
         LEFT JOIN matters m ON m.id = d.matter_id
        WHERE d.document_no IS NULL AND d.status IN ('draft', 'void')
        ORDER BY d.created_at NULLS LAST, d.id`);
    return (r.rows as any[]).map((row) => {
      const holders = heldBy([
        ["結びついた実績", Number(row.h_events ?? 0)],
        ["やり取りの記録", Number(row.h_notes ?? 0)],
        ["この文書を退かせる版", Number(row.h_successors ?? 0)]
      ]);
      const supersedes = str(row.supersedes_no);
      return {
        kind: "draft" as LeftoverKind,
        id: Number(row.id),
        label: `下書き #${row.id}${row.template_key ? `（${row.template_key}）` : ""}`,
        origin: supersedes
          ? `${supersedes} の訂正版の作りかけ${row.supersede_reason ? `：${row.supersede_reason}` : ""}`
          : row.status === "void" ? "出す前に無効にした下書き" : "作りかけの下書き",
        createdAt: iso(row.created_at),
        context: [str(row.matter_no), str(row.condition_names)].filter(Boolean).join("　") || null,
        disposable: disposable(holders),
        // 訂正版は「金額の直し」の途中の産物。捨てると元の文書が直っていない
        // まま残るので、片づけのつもりで直しを取り消すことになる。
        caution: supersedes
          ? `${supersedes} の直しかけです。捨てると ${supersedes} は直っていないまま残ります`
          : null,
        holders
      };
    });
  }

  /** 無効にした実績。支払の割当と計算書の行が付いていれば残す。 */
  private async voidedEvents(): Promise<Leftover[]> {
    const r = await this.database.query(
      `SELECT e.id, e.condition_id, e.occurred_on, e.amount, e.created_at,
              c.condition_no, c.name AS condition_name, p.name AS party_name,
              -- 取り消しの理由は実績の備考ではなく監査記録にある。
              (SELECT a.detail ->> 'reason' FROM audit_events a
                WHERE a.action = 'condition.event_void'
                  AND (a.detail ->> 'eventId')::bigint = e.id
                ORDER BY a.id DESC LIMIT 1) AS void_reason,
              (SELECT a.occurred_at FROM audit_events a
                WHERE a.action = 'condition.event_void'
                  AND (a.detail ->> 'eventId')::bigint = e.id
                ORDER BY a.id DESC LIMIT 1) AS voided_at,
              (SELECT count(*)::int FROM payment_allocations a WHERE a.event_id = e.id) AS h_allocations,
              (SELECT count(*)::int FROM statement_lines l WHERE l.event_id = e.id) AS h_statement_lines
         FROM condition_events e
         JOIN conditions c ON c.id = e.condition_id
         LEFT JOIN parties p ON p.id = c.counterparty_id
        WHERE e.status = 'void'
        ORDER BY e.occurred_on NULLS LAST, e.id`);
    return (r.rows as any[]).map((row) => {
      const holders = heldBy([
        ["支払の割当", Number(row.h_allocations ?? 0)],
        ["計算書の行", Number(row.h_statement_lines ?? 0)]
      ]);
      return {
        kind: "event" as LeftoverKind,
        id: Number(row.id),
        // pg は date 列を Date で返す。String() で切ると「Sat Sep 05」になる。
        label: `実績 #${row.id}（${dateStr(row.occurred_on) ?? "日付なし"}）`,
        origin: str(row.void_reason) ? `取り消し：${str(row.void_reason)}` : "取り消した実績",
        createdAt: iso(row.voided_at ?? row.created_at),
        context: [str(row.condition_no), str(row.condition_name), str(row.party_name)]
          .filter(Boolean).join("　") || null,
        disposable: disposable(holders),
        caution: null,
        holders
      };
    });
  }

  /** 無効にした条件。判定は既存の2段階削除と同じ。 */
  private async voidedConditions(): Promise<Leftover[]> {
    const r = await this.database.query(
      `SELECT c.id, c.condition_no, c.name, c.created_at,
              p.name AS party_name, ${CONDITION_HOLDERS},
              -- 無効にした理由は列に持たない。監査記録から最後のものを拾う。
              (SELECT a.detail ->> 'reason' FROM audit_events a
                WHERE a.action = 'condition.void' AND a.target_type = 'condition'
                  AND a.target_id = c.id
                ORDER BY a.id DESC LIMIT 1) AS void_reason,
              (SELECT a.occurred_at FROM audit_events a
                WHERE a.action = 'condition.void' AND a.target_type = 'condition'
                  AND a.target_id = c.id
                ORDER BY a.id DESC LIMIT 1) AS voided_at
         FROM conditions c
         LEFT JOIN parties p ON p.id = c.counterparty_id
        WHERE c.status = 'void'
        ORDER BY c.condition_no NULLS LAST, c.id`);
    return (r.rows as any[]).map((row) => {
      const holders = heldBy([
        ["実績", Number(row.h_events ?? 0)],
        ["この条件をアウト条件にした実績", Number(row.h_out_refs ?? 0)],
        ["文書", Number(row.h_documents ?? 0)],
        ["支払の割当", Number(row.h_payments ?? 0)],
        ["計算書", Number(row.h_statements ?? 0)],
        ["案件", Number(row.h_matters ?? 0)],
        ["派生した条件", Number(row.h_children ?? 0)],
        ["この版に改訂された旧版", Number(row.h_older ?? 0)]
      ]);
      return {
        kind: "condition" as LeftoverKind,
        id: Number(row.id),
        label: `${str(row.condition_no) ?? `条件 #${row.id}`}　${String(row.name ?? "")}`,
        origin: str(row.void_reason) ? `無効化：${str(row.void_reason)}` : "無効にした条件",
        // 並べたいのは「いつ無効にしたか」。作った日ではない。
        createdAt: iso(row.voided_at ?? row.created_at),
        context: str(row.party_name),
        disposable: disposable(holders),
        caution: null,
        holders
      };
    });
  }

  /**
   * 選ばれたものを捨てる。文書 → 実績 → 条件 の順。
   *
   * 実績を先に外さないと、条件が実績に引き止められて消せない。1件ずつ独立
   * して流し、断られたものは理由を添えて返す（まとめて巻き戻すと、消せた
   * ものまで戻ってしまい、何度やっても同じところで止まる）。
   */
  async dispose(
    picks: Array<{ kind: LeftoverKind; id: number }>, reason: string, actor: string
  ): Promise<DisposeResult[]> {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "捨てる理由は必須です");
    if (!picks.length) throw new DomainError("VALIDATION", "捨てるものが選ばれていません");

    const known = new Map((await this.list()).map((i) => [`${i.kind}:${i.id}`, i]));
    const ordered = [...picks].sort(
      (a, b) => DISPOSE_ORDER.indexOf(a.kind) - DISPOSE_ORDER.indexOf(b.kind));

    const out: DisposeResult[] = [];
    for (const pick of ordered) {
      const item = known.get(`${pick.kind}:${pick.id}`);
      const label = item?.label ?? `${pick.kind} #${pick.id}`;
      if (!item) {
        // 一覧に無いものは捨てない。出した記録・生きている行を id で名指し
        // されても、ここから先へは通さない（最後の関門は持ち主のサービス）。
        // 「もう無い」と言うと、生きている行が消えたと読めてしまう。
        out.push({ ...pick, label, removed: false,
          message: "片づけの対象ではありません。出した記録と生きている行は捨てません"
            + "（誰かが先に片づけた可能性もあります。一覧を読み直してください）" });
        continue;
      }
      try {
        await this.disposeOne(item, why, actor);
        out.push({ ...pick, label, removed: true, message: null });
      } catch (error) {
        out.push({ ...pick, label, removed: false, message: (error as Error).message });
      }
    }
    return out;
  }

  private async disposeOne(item: Leftover, why: string, actor: string): Promise<void> {
    if (item.kind === "draft") {
      await this.parts.documents.discardDraft(item.id, why, actor);
      return;
    }
    if (item.kind === "event") {
      const r = await this.database.query(
        "SELECT condition_id FROM condition_events WHERE id = $1", [item.id]);
      const conditionId = Number((r.rows[0] as { condition_id?: number } | undefined)?.condition_id);
      if (!conditionId) throw new DomainError("NOT_FOUND", `実績 ${item.id} が見つかりません`);
      await this.parts.events.discardVoided(conditionId, item.id, why, actor);
      return;
    }
    await this.parts.conditions.remove(item.id, actor, why);
  }
}
