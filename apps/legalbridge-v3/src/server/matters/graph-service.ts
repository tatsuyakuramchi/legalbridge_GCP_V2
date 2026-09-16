import type { Transactable } from "../core/db.js";
import { dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";

/**
 * 案件の「繋がりの整理」。
 *
 * 条件・実績・文書・支払は、それぞれの画面が自分から見える繋がりだけを出す。
 * 改訂（版が変わる）・下書き・無効・訂正版・実績の結びつけが絡むと、どこが
 * ねじれているかを 1 か所で見られなかった。ここは案件を軸に一式を集め、
 * 機械的に見つかる不整合を名指しで出す。直す操作は既存の API を画面から呼ぶ。
 *
 * 集め方：案件に紐づく条件 → その系列（改訂の全版）→ 版に付いた実績、
 * 版に繋いだ文書、版に割り当たった支払。案件に直接付いた文書も加える。
 */

export interface GraphCondition {
  id: number; conditionNo: string | null; name: string; kind: string; status: string;
  series: number; supersededById: number | null; effectiveFrom: string | null;
  currency: string; flatAmount: number | null; linkedToMatter: boolean; closedAt: string | null;
}
export interface GraphEvent {
  id: number; conditionId: number; eventType: string; occurredOn: string | null; amount: number;
  status: string; documentId: number | null; documentNo: string | null; documentStatus: string | null;
  followUp: string | null; varianceNote: string | null;
}
export interface GraphDocument {
  id: number; documentNo: string | null; status: string; templateKey: string | null; templateLabel: string | null;
  issuedAt: string | null; matterId: number | null; supersedesId: number | null;
  conditionIds: number[]; eventIds: number[]; draftEventIds: number[];
}
export interface GraphPayment {
  id: number; paymentNo: string | null; status: string; amount: number; currency: string; dueOn: string | null;
  allocations: Array<{ conditionId: number; eventId: number | null; amount: number }>;
}
export interface GraphIssue {
  code: "event_on_dead_document" | "document_has_old_version" | "document_condition_not_in_matter"
      | "old_version_linked_to_matter" | "inspection_without_order" | "drafts_share_events" | "event_on_old_version";
  message: string;
  /** 直すときの手がかり。画面がボタンにする。 */
  eventId?: number; documentId?: number; conditionId?: number; currentConditionId?: number;
}
export interface MatterGraph {
  matter: { id: number; matterNo: string | null; title: string; kind: string };
  conditions: GraphCondition[];
  events: GraphEvent[];
  documents: GraphDocument[];
  payments: GraphPayment[];
  issues: GraphIssue[];
}

const ORDER_KEYS = new Set(["purchase_order", "intl_purchase_order"]);
const INSPECTION_KEYS = new Set(["inspection_certificate", "acceptance_certificate", "delivery_note"]);

/** 機械的に見つかる不整合。純粋関数にして試験できるようにしてある。 */
export function findIssues(g: Omit<MatterGraph, "issues">): GraphIssue[] {
  const out: GraphIssue[] = [];
  const byId = new Map(g.conditions.map((c) => [c.id, c]));
  const label = (c: GraphCondition | undefined, id: number) => c?.conditionNo ?? `#${id}`;
  const current = (c: GraphCondition): GraphCondition => {
    let x = c; const seen = new Set<number>();
    while (x.supersededById && !seen.has(x.id)) { seen.add(x.id); const n = byId.get(x.supersededById); if (!n) break; x = n; }
    return x;
  };
  const docNo = (d: GraphDocument) => d.documentNo ?? `下書き #${d.id}`;

  for (const e of g.events) {
    if (e.status !== "active") continue;
    if (e.documentId && (e.documentStatus === "void" || e.documentStatus === "superseded")) {
      out.push({ code: "event_on_dead_document", eventId: e.id, documentId: e.documentId, conditionId: e.conditionId,
        message: `実績 #${e.id}（${e.occurredOn ?? "—"}）が${e.documentStatus === "void" ? "無効" : "差し替え済み"}の文書 ${e.documentNo ?? `#${e.documentId}`} に結びついたままです。外すと作り直せます` });
    }
    const c = byId.get(e.conditionId);
    if (c && c.status === "superseded") {
      out.push({ code: "event_on_old_version", eventId: e.id, conditionId: c.id, currentConditionId: current(c).id,
        message: `実績 #${e.id} は旧版 ${label(c, c.id)} に付いています（今の版 ${label(current(c), current(c).id)}）。文書は系列で見るので、このままで問題ありません` });
    }
  }
  for (const d of g.documents) {
    if (d.status === "void" || d.status === "superseded") continue;
    for (const cid of d.conditionIds) {
      const c = byId.get(cid);
      if (!c) continue;
      if (c.status === "superseded") {
        const cur = current(c);
        out.push({ code: "document_has_old_version", documentId: d.id, conditionId: c.id, currentConditionId: cur.id,
          message: `${docNo(d)} に旧版 ${label(c, c.id)} が載っています（今の版 ${label(cur, cur.id)}）${d.status === "draft" ? "。下書きなので今の版に差し替えられます" : "。決定済みの記録なのでそのままで構いません"}` });
      }
      const series = g.conditions.filter((x) => x.series === c.series);
      if (!series.some((x) => x.linkedToMatter)) {
        out.push({ code: "document_condition_not_in_matter", documentId: d.id, conditionId: c.id,
          message: `${docNo(d)} の条件 ${label(c, c.id)} はこの案件に紐づいていません` });
      }
    }
    if (INSPECTION_KEYS.has(d.templateKey ?? "")) {
      const seriesOfDoc = new Set(d.conditionIds.map((id) => byId.get(id)?.series).filter((s): s is number => s !== undefined));
      const hasOrder = g.documents.some((o) => ORDER_KEYS.has(o.templateKey ?? "") && o.status === "issued"
        && o.conditionIds.some((id) => seriesOfDoc.has(byId.get(id)?.series ?? -1)));
      if (seriesOfDoc.size && !hasOrder) {
        out.push({ code: "inspection_without_order", documentId: d.id,
          message: `${docNo(d)} の条件には決定済みの発注書がありません。検収書の発注番号が空になります（条件の「発注番号（外部）」に控えると出ます）` });
      }
    }
  }
  for (const c of g.conditions) {
    if (c.status === "superseded" && c.linkedToMatter) {
      const cur = current(c);
      out.push({ code: "old_version_linked_to_matter", conditionId: c.id, currentConditionId: cur.id,
        message: `旧版 ${label(c, c.id)} が案件に紐づいたままです（今の版 ${label(cur, cur.id)}）。115 の SQL か「今の版へ付け替える」で直せます` });
    }
  }
  const drafts = g.documents.filter((d) => d.status === "draft" && d.draftEventIds.length);
  for (let i = 0; i < drafts.length; i += 1) {
    for (let j = i + 1; j < drafts.length; j += 1) {
      const shared = drafts[i].draftEventIds.filter((id) => drafts[j].draftEventIds.includes(id));
      if (shared.length) {
        out.push({ code: "drafts_share_events", documentId: drafts[i].id,
          message: `下書き #${drafts[i].id} と #${drafts[j].id} が同じ実績（#${shared.join("・")}）を指しています。片方は要らないはずです` });
      }
    }
  }
  return out;
}

export class MatterGraphService {
  constructor(private readonly database: Transactable) {}

  async graph(matterId: number): Promise<MatterGraph> {
    try {
      const head = await this.database.query(
        "SELECT id, matter_no, title, kind FROM matters WHERE id = $1", [matterId]);
      const m = head.rows[0] as Record<string, any> | undefined;
      if (!m) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      // 案件に紐づく条件の系列 → 全版
      const conds = await this.database.query(
        `WITH linked AS (
           SELECT c.id, COALESCE(c.series_id, c.id) AS series
             FROM matter_links ml JOIN conditions c ON c.id::text = ml.target_ref
            WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
         ),
         doc_conds AS (
           SELECT c.id, COALESCE(c.series_id, c.id) AS series
             FROM documents d JOIN document_conditions dc ON dc.document_id = d.id
             JOIN conditions c ON c.id = dc.condition_id
            WHERE d.matter_id = $1
         ),
         series AS (SELECT DISTINCT series FROM linked UNION SELECT DISTINCT series FROM doc_conds)
         SELECT c.id, c.condition_no, c.name, c.kind, c.status, COALESCE(c.series_id, c.id) AS series,
                c.superseded_by_id, c.effective_from, c.currency, c.flat_amount, c.closed_at,
                EXISTS (SELECT 1 FROM linked l WHERE l.id = c.id) AS linked_to_matter
           FROM conditions c
          WHERE COALESCE(c.series_id, c.id) IN (SELECT series FROM series)
          ORDER BY series, c.id`, [matterId]);
      const conditions: GraphCondition[] = (conds.rows as any[]).map((r) => ({
        id: Number(r.id), conditionNo: str(r.condition_no), name: String(r.name ?? ""), kind: String(r.kind),
        status: String(r.status), series: Number(r.series), supersededById: int(r.superseded_by_id),
        effectiveFrom: dateStr(r.effective_from), currency: String(r.currency ?? "JPY"),
        flatAmount: int(r.flat_amount), linkedToMatter: Boolean(r.linked_to_matter),
        closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null
      }));
      const ids = conditions.map((c) => c.id);

      const evs = ids.length ? await this.database.query(
        `SELECT e.id, e.condition_id, e.event_type, e.occurred_on, e.amount, e.status, e.document_id,
                d.document_no, d.status AS document_status, e.follow_up, e.variance_note
           FROM condition_events e LEFT JOIN documents d ON d.id = e.document_id
          WHERE e.condition_id = ANY($1::bigint[])
          ORDER BY e.occurred_on, e.id`, [ids]) : { rows: [] as any[] };
      const events: GraphEvent[] = (evs.rows as any[]).map((r) => ({
        id: Number(r.id), conditionId: Number(r.condition_id), eventType: String(r.event_type),
        occurredOn: dateStr(r.occurred_on), amount: Number(r.amount ?? 0), status: String(r.status),
        documentId: int(r.document_id), documentNo: str(r.document_no), documentStatus: str(r.document_status),
        followUp: str(r.follow_up), varianceNote: str(r.variance_note)
      }));

      const docs = await this.database.query(
        `SELECT DISTINCT d.id, d.document_no, d.status, d.issued_at, d.matter_id, d.supersedes_id,
                t.template_key, t.label AS template_label, d.manual_inputs -> '_eventIds' AS draft_event_ids
           FROM documents d
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE d.matter_id = $1
             OR d.id IN (SELECT dc.document_id FROM document_conditions dc WHERE dc.condition_id = ANY($2::bigint[]))
          ORDER BY d.id`, [matterId, ids]);
      const docIds = (docs.rows as any[]).map((r) => Number(r.id));
      const links = docIds.length ? await this.database.query(
        "SELECT document_id, condition_id FROM document_conditions WHERE document_id = ANY($1::bigint[]) ORDER BY line_no",
        [docIds]) : { rows: [] as any[] };
      const documents: GraphDocument[] = (docs.rows as any[]).map((r) => {
        const id = Number(r.id);
        const raw = r.draft_event_ids;
        const draftEventIds = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isFinite(n)) : [];
        return {
          id, documentNo: str(r.document_no), status: String(r.status), templateKey: str(r.template_key),
          templateLabel: str(r.template_label), issuedAt: dateStr(r.issued_at), matterId: int(r.matter_id),
          supersedesId: int(r.supersedes_id),
          conditionIds: (links.rows as any[]).filter((l) => Number(l.document_id) === id).map((l) => Number(l.condition_id)),
          eventIds: events.filter((e) => e.documentId === id).map((e) => e.id),
          draftEventIds
        };
      });

      const pays = ids.length ? await this.database.query(
        `SELECT y.id, y.payment_no, y.status, y.amount, y.currency, y.due_on,
                al.condition_id, al.event_id, al.amount AS allocated
           FROM payments y JOIN payment_allocations al ON al.payment_id = y.id
          WHERE al.condition_id = ANY($1::bigint[])
          ORDER BY y.id, al.id`, [ids]) : { rows: [] as any[] };
      const payments: GraphPayment[] = [];
      for (const r of pays.rows as any[]) {
        let p = payments.find((x) => x.id === Number(r.id));
        if (!p) {
          p = { id: Number(r.id), paymentNo: str(r.payment_no), status: String(r.status), amount: Number(r.amount ?? 0),
                currency: String(r.currency ?? "JPY"), dueOn: dateStr(r.due_on), allocations: [] };
          payments.push(p);
        }
        p.allocations.push({ conditionId: Number(r.condition_id), eventId: int(r.event_id), amount: num(r.allocated) ?? 0 });
      }

      const base = {
        matter: { id: Number(m.id), matterNo: str(m.matter_no), title: String(m.title ?? ""), kind: String(m.kind) },
        conditions, events, documents, payments
      };
      return { ...base, issues: findIssues(base) };
    } catch (error) { throw translate(error); }
  }
}
