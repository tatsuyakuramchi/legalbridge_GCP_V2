import type { Queryable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import type { IssueStatementInput, StatementIssuer } from "./statement-issue.js";

/**
 * 同じ人・同じ回の計算書が 2 枚に分かれているものを、1 枚の訂正版にまとめる。
 *
 * まとめて締めるは、受取人として載る分（共著の取り分）と、その人が相手先の条件（単独の作品）を
 * 別の紙にしていた。同じ回に同じ人へ計算書も支払も 2 本になるので、人ごとに 1 枚に変えた
 * （close-service）。その前に出した 2 枚組を、ここで 1 枚にまとめ直す。
 *
 *   - 対象：決定済みの計算書で、宛先（受取人か相手先）・対象期間・通貨が同じものが 2 枚以上あり、
 *     受取人宛ての紙と本人宛ての紙が混ざっている組
 *   - 載せる条件・実績・受取人はそのまま。元の決定日（遅いほう）で、元の紙を全部退かせる訂正版にする
 *   - 額は変えない。いま計算し直して合計が元の合計と違えばまとめない
 *   - 支払：元の紙から立った未払いの支払（予定・承認済み）を取り消し、まとめた紙から 1 本立て直す
 *     （期日は元の支払のいちばん遅い日）。支払済みが 1 本でもあればまとめない
 */

export interface MergeGroup {
  key: string;
  partyId: number;
  partyName: string;
  periodLabel: string | null;
  currency: string;
  documents: Array<{ id: number; documentNo: string | null; payee: boolean; netAmount: number; issuedOn: string | null }>;
  netAmount: number;
  payments: Array<{ id: number; paymentNo: string | null; status: string; dueOn: string | null; amount: number }>;
  status: "ready" | "paid" | "draft" | "amount" | "error";
  message: string | null;
}

export interface MergeResult {
  key: string; partyName: string;
  status: "merged" | "skipped" | "error";
  newDocumentNo?: string | null; paymentNo?: string | null; message?: string;
}

interface Payments {
  cancel(paymentId: number, reason: string, actor: string): Promise<unknown>;
  createFromStatementDocument(documentId: number, actor: string, options?: { dueOn?: string | null }): Promise<{ paymentNo?: string | null }>;
}

const STATEMENT_KEYS = ["royalty_statement", "royalty_statement_pub"];
export const MERGE_REASON = "受取人としての分と本人の分を 1 枚にまとめる";

export class StatementMergeService {
  constructor(
    private readonly database: Queryable,
    private readonly issuer: Pick<StatementIssuer, "issue" | "previewBundle">,
    private readonly payments: Payments | null = null
  ) {}

  async preview(): Promise<{ groups: MergeGroup[] }> {
    try {
      const plans = await this.plans();
      return { groups: plans.map((p) => p.group) };
    } catch (error) { throw translate(error); }
  }

  async run(keys: string[], actor: string): Promise<{ merged: number; results: MergeResult[] }> {
    if (!this.payments) throw new DomainError("UNAVAILABLE", "支払の口がありません");
    const plans = await this.plans();
    const byKey = new Map(plans.map((p) => [p.group.key, p]));
    const results: MergeResult[] = [];
    for (const key of [...new Set(keys)]) {
      const plan = byKey.get(key);
      if (!plan) { results.push({ key, partyName: "", status: "skipped", message: "まとめる組ではありません（もうまとめたか、対象が変わりました）" }); continue; }
      const g = plan.group;
      if (g.status !== "ready") { results.push({ key, partyName: g.partyName, status: "skipped", message: g.message ?? "" }); continue; }
      try {
        const docs = [...g.documents].sort((a, b) => a.id - b.id);
        const input: IssueStatementInput = {
          entries: plan.entries,
          supersedes: docs.map((d) => d.id),
          reason: MERGE_REASON,
          issuedOn: plan.issuedOn,
          templateKey: plan.templateKey,
          matterId: plan.matterId,
          agreementId: plan.agreementId,
          manualInputs: plan.manualInputs,
          periodLabel: g.periodLabel
        };
        const made = await this.issuer.issue(input, actor);
        // 元の紙の未払いの支払を取り消して、まとめた紙から 1 本立て直す。
        try {
          for (const p of g.payments) await this.payments.cancel(p.id, MERGE_REASON, actor);
          const dueOn = g.payments.map((p) => p.dueOn).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
          const paid = await this.payments.createFromStatementDocument(made.document.id, actor, { dueOn });
          results.push({ key, partyName: g.partyName, status: "merged",
                         newDocumentNo: made.document.documentNo ?? null, paymentNo: paid.paymentNo ?? null });
        } catch (error) {
          results.push({ key, partyName: g.partyName, status: "error", newDocumentNo: made.document.documentNo ?? null,
            message: `計算書は ${made.document.documentNo ?? ""} にまとめましたが、支払を立て直せませんでした（${error instanceof Error ? error.message : String(error)}）。支払の画面で確認してください` });
        }
      } catch (error) {
        results.push({ key, partyName: g.partyName, status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { merged: results.filter((r) => r.status === "merged").length, results };
  }

  private async plans() {
    const head = (await this.database.query(
      `SELECT d.id, d.document_no, d.manual_inputs, d.matter_id, d.agreement_id, t.template_key,
              to_char(d.issued_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS issued_on,
              COALESCE(d.rendered_values ->> 'pubPeriodLabel', d.manual_inputs ->> 'rs_period_label') AS period_label,
              EXISTS (SELECT 1 FROM documents x WHERE x.supersedes_id = d.id AND x.status = 'draft') AS has_draft,
              s.id AS statement_id, s.condition_id, s.payee_party_id, s.period, s.net_amount, s.currency,
              COALESCE(s.payee_party_id, c.counterparty_id) AS party_id, p.name AS party_name
         FROM documents d
         JOIN document_template_versions tv ON tv.id = d.template_version_id
         JOIN document_templates t ON t.id = tv.template_id
         JOIN statements s ON s.document_id = d.id
         JOIN conditions c ON c.id = s.condition_id
         JOIN parties p ON p.id = COALESCE(s.payee_party_id, c.counterparty_id)
        WHERE d.status = 'issued' AND t.template_key = ANY($1::text[])
        ORDER BY d.id, s.id`, [STATEMENT_KEYS])).rows as Array<Record<string, any>>;

    // 文書ごと → 宛先・期間・通貨で組にする。
    type Doc = { id: number; documentNo: string | null; rows: Array<Record<string, any>> };
    const docs = new Map<number, Doc>();
    for (const r of head) {
      const d = docs.get(Number(r.id)) ?? { id: Number(r.id), documentNo: str(r.document_no), rows: [] };
      d.rows.push(r); docs.set(d.id, d);
    }
    const groups = new Map<string, Doc[]>();
    for (const d of docs.values()) {
      const parties = new Set(d.rows.map((r) => Number(r.party_id)));
      if (parties.size !== 1) continue;
      const first = d.rows[0]!;
      const key = `${first.party_id}|${str(first.period_label) ?? ""}|${first.currency ?? "JPY"}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    const candidates = [...groups.entries()].filter(([, ds]) => ds.length >= 2
      && ds.some((d) => d.rows.some((r) => r.payee_party_id)) && ds.some((d) => d.rows.some((r) => !r.payee_party_id)));
    if (!candidates.length) return [];

    const statementIds = candidates.flatMap(([, ds]) => ds.flatMap((d) => d.rows.map((r) => Number(r.statement_id))));
    const ev = (await this.database.query(
      `SELECT s.id AS statement_id, e.id AS event_id
         FROM statements s
         JOIN condition_events e ON e.status = 'active'
          AND (e.id IN (SELECT l.event_id FROM statement_lines l WHERE l.statement_id = s.id)
               OR (e.document_id = s.document_id AND e.condition_id = s.condition_id))
        WHERE s.id = ANY($1::bigint[])
        ORDER BY s.id, e.id`, [statementIds])).rows as Array<{ statement_id: number; event_id: number }>;
    const eventsOf = new Map<number, number[]>();
    for (const e of ev) eventsOf.set(Number(e.statement_id), [...new Set([...(eventsOf.get(Number(e.statement_id)) ?? []), Number(e.event_id)])]);

    const out = [];
    for (const [key, ds] of candidates) {
      const first = ds[0]!.rows[0]!;
      const partyId = Number(first.party_id);
      const entries = ds.flatMap((d) => d.rows.map((r) => ({
        conditionId: Number(r.condition_id),
        payeePartyId: r.payee_party_id ? Number(r.payee_party_id) : null,
        eventIds: eventsOf.get(Number(r.statement_id)) ?? [],
        period: str(r.period)
      })));
      const eventIds = [...new Set(entries.flatMap((e) => e.eventIds))];
      const netAmount = ds.reduce((a, d) => a + d.rows.reduce((b, r) => b + Number(r.net_amount ?? 0), 0), 0);
      const pays = eventIds.length ? (await this.database.query(
        `SELECT DISTINCT p.id, p.payment_no, p.status, p.due_on, p.amount
           FROM payments p JOIN payment_allocations a ON a.payment_id = p.id
          WHERE p.party_id = $1 AND p.status <> 'canceled' AND a.event_id = ANY($2::bigint[])
          ORDER BY p.id`, [partyId, eventIds])).rows as Array<Record<string, any>> : [];
      const group: MergeGroup = {
        key, partyId, partyName: String(first.party_name ?? ""), periodLabel: str(first.period_label),
        currency: String(first.currency ?? "JPY"),
        documents: ds.map((d) => ({ id: d.id, documentNo: d.documentNo, payee: d.rows.some((r) => r.payee_party_id),
                                    netAmount: d.rows.reduce((b, r) => b + Number(r.net_amount ?? 0), 0),
                                    issuedOn: str(d.rows[0]!.issued_on) })),
        netAmount,
        payments: pays.map((p) => ({ id: Number(p.id), paymentNo: str(p.payment_no), status: String(p.status),
                                     dueOn: dateStr(p.due_on), amount: Number(p.amount ?? 0) })),
        status: "ready", message: null
      };
      if (group.payments.some((p) => p.status === "paid")) {
        Object.assign(group, { status: "paid", message: "支払済みの支払があるのでまとめません" });
      } else if (ds.some((d) => d.rows[0]!.has_draft === true)) {
        Object.assign(group, { status: "draft", message: "訂正版の下書きが開いています。それを決定するか捨ててください" });
      } else {
        try {
          const previews = await this.issuer.previewBundle(entries, ds.map((d) => d.id));
          const now = previews.reduce((a, p) => a + p.amounts.netMinor, 0);
          if (now !== netAmount) {
            Object.assign(group, { status: "amount",
              message: `いま計算し直すと合計が変わります（${netAmount.toLocaleString("ja-JP")} → ${now.toLocaleString("ja-JP")}）。個別に確認してください` });
          }
        } catch (error) {
          Object.assign(group, { status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
      // 手入力は、受取人宛てでない紙（本人宛て）のものを土台に。焼き付けた行・受取人は組み直す。
      const baseDoc = ds.find((d) => !d.rows.some((r) => r.payee_party_id)) ?? ds[0]!;
      const manual = { ...(baseDoc.rows[0]!.manual_inputs ?? {}) } as Record<string, unknown>;
      for (const k of Object.keys(manual)) {
        if (k.startsWith("rs_") || k === "_payeePartyId" || k === "_supersedesExtra" || k === "statementMode") delete manual[k];
      }
      const templateKey = ds.some((d) => d.rows[0]!.template_key === "royalty_statement_pub") ? "royalty_statement_pub" : String(first.template_key);
      const issuedOn = ds.map((d) => str(d.rows[0]!.issued_on)).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
      out.push({ group, entries, manualInputs: manual, templateKey, issuedOn,
                 matterId: baseDoc.rows[0]!.matter_id ? Number(baseDoc.rows[0]!.matter_id) : null,
                 agreementId: baseDoc.rows[0]!.agreement_id ? Number(baseDoc.rows[0]!.agreement_id) : null });
    }
    return out.sort((a, b) => a.group.partyName.localeCompare(b.group.partyName, "ja"));
  }
}
