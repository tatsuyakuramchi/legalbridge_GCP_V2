import { dateStr, inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { buildFlow, currentStep, type FlowFacts, type FlowStep } from "./flow.js";
import type { MatterKind } from "./write-service.js";

/**
 * 案件に条件と文書を繋ぐ。
 *
 * matter_links の 'condition' は読む処理が3箇所あるのに、書く処理が画面にも
 * サーバにも移行にも無かった。そのため案件を開いても条件タブは常に空で、
 * 経理提出用の帳票の担当者・部署もこの経路で切れて空欄になっていた。
 *
 * 案件は所有せず参照する。繋いでも条件は書き換わらないし、外しても条件は
 * 消えない。案件より条件のほうが寿命が長いため。
 */

/**
 * 取引モデルごとに使える条件の種類。
 * 案件の種別が中身を決める、という V3 の設計をそのまま選択肢にする。
 */
export const CONDITION_KINDS_BY_MATTER: Record<MatterKind, Array<{ value: string; label: string }>> = {
  work: [
    { value: "license", label: "許諾料" },
    { value: "product", label: "製品（グッズ等）" }
  ],
  outsourcing: [
    { value: "service", label: "委託料" },
    { value: "expense", label: "実費" },
    { value: "fee", label: "手数料" }
  ],
  single: []
};

export class MatterLinkService {
  constructor(private readonly database: Transactable) {}

  /** 条件を繋ぐ。取引モデルに合わない種類は理由を添えて断る。 */
  async attachCondition(matterId: number, conditionId: number, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const m = await client.query(
          "SELECT id, matter_no, kind FROM matters WHERE id = $1", [matterId]);
        const matter = m.rows[0] as { id: number; matter_no: string | null; kind: MatterKind } | undefined;
        if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

        const c = await client.query(
          "SELECT id, condition_no, kind, status FROM conditions WHERE id = $1", [conditionId]);
        const condition = c.rows[0] as any;
        if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);

        const allowed = CONDITION_KINDS_BY_MATTER[matter.kind];
        if (!allowed.length) {
          throw new DomainError("VALIDATION",
            "単発の案件は条件を持ちません。条件が要るなら案件の種別を変えてください");
        }
        if (!allowed.some((k) => k.value === condition.kind)) {
          throw new DomainError("VALIDATION",
            `この案件（${labelOf(matter.kind)}）に ${condition.kind} の条件は繋げません。` +
            `使えるのは ${allowed.map((k) => k.label).join("・")} です`);
        }

        const inserted = await client.query(
          `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
           VALUES ($1, 'condition', $2, 'covers', $3::jsonb)
           ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING
           RETURNING id`,
          [matterId, String(conditionId), JSON.stringify({
            conditionNo: condition.condition_no, kind: condition.kind
          })]);
        const added = inserted.rows.length > 0;

        if (added) {
          await recordAudit(client, {
            actor, action: "matter.attach_condition", targetType: "matter", targetId: matterId,
            detail: { conditionId, conditionNo: condition.condition_no, matterNo: matter.matter_no }
          });
        }
        return { attached: added, conditionId, reason: added ? undefined : "すでに繋がっています" };
      });
    } catch (error) { throw translate(error); }
  }

  /** 繋ぎを外す。条件そのものは消さない。 */
  async detachCondition(matterId: number, conditionId: number, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `DELETE FROM matter_links
            WHERE matter_id = $1 AND target_type = 'condition' AND target_ref = $2`,
          [matterId, String(conditionId)]);
        const removed = (r.rowCount ?? 0) > 0;
        if (removed) {
          await recordAudit(client, {
            actor, action: "matter.detach_condition", targetType: "matter", targetId: matterId,
            detail: { conditionId }
          });
        }
        return { removed };
      });
    } catch (error) { throw translate(error); }
  }

  /** 文書を案件に付ける。documents.matter_id を直接持つので参照は1本。 */
  async attachDocument(matterId: number, documentId: number, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const m = await client.query("SELECT id FROM matters WHERE id = $1", [matterId]);
        if (!m.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

        const d = await client.query(
          "SELECT id, document_no, matter_id FROM documents WHERE id = $1", [documentId]);
        const document = d.rows[0] as any;
        if (!document) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (document.matter_id && Number(document.matter_id) !== matterId) {
          throw new DomainError("CONFLICT",
            `この文書は別の案件（#${document.matter_id}）に付いています。先に外してください`);
        }

        await client.query("UPDATE documents SET matter_id = $2 WHERE id = $1", [documentId, matterId]);
        await recordAudit(client, {
          actor, action: "matter.attach_document", targetType: "matter", targetId: matterId,
          detail: { documentId, documentNo: document.document_no }
        });
        return { attached: true, documentId };
      });
    } catch (error) { throw translate(error); }
  }

  async detachDocument(matterId: number, documentId: number, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          "UPDATE documents SET matter_id = NULL WHERE id = $1 AND matter_id = $2",
          [documentId, matterId]);
        const removed = (r.rowCount ?? 0) > 0;
        if (removed) {
          await recordAudit(client, {
            actor, action: "matter.detach_document", targetType: "matter", targetId: matterId,
            detail: { documentId }
          });
        }
        return { removed };
      });
    } catch (error) { throw translate(error); }
  }

  /** 進み具合。段階は保存せず、揃っているものから導く。 */
  async flow(matterId: number): Promise<{ steps: FlowStep[]; current: FlowStep | null; facts: FlowFacts }> {
    try {
      const head = await this.database.query(
        "SELECT id, kind, status FROM matters WHERE id = $1", [matterId]);
      const matter = head.rows[0] as { kind: MatterKind; status: string } | undefined;
      if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      const conditions = await this.database.query(
        `SELECT c.id, c.status, c.work_id, a.agreement_no, a.status AS agreement_status
           FROM matter_links ml
           JOIN conditions c ON c.id::text = ml.target_ref
           LEFT JOIN agreements a ON a.id = c.agreement_id
          WHERE ml.matter_id = $1 AND ml.target_type = 'condition'`, [matterId]);
      const rows = conditions.rows as any[];
      const ids = rows.map((r) => Number(r.id));

      const documents = await this.database.query(
        `SELECT d.status, d.document_no, t.label
           FROM documents d
           LEFT JOIN document_template_versions v ON v.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = v.template_id
          WHERE d.matter_id = $1 ORDER BY d.issued_at NULLS LAST, d.id`, [matterId]);

      const events = ids.length
        ? await this.database.query(
            `SELECT event_type, count(*)::int AS n, max(occurred_on) AS latest
               FROM condition_events
              WHERE condition_id = ANY($1::bigint[]) AND status = 'active'
              GROUP BY event_type`, [ids])
        : { rows: [] as any[] };

      const statements = ids.length
        ? await this.database.query(
            `SELECT count(*)::int AS n FROM statements WHERE condition_id = ANY($1::bigint[])`, [ids])
        : { rows: [{ n: 0 }] };

      const payments = ids.length
        ? await this.database.query(
            `SELECT count(DISTINCT y.id)::int AS total,
                    count(DISTINCT y.id) FILTER (WHERE y.status = 'paid')::int AS paid
               FROM payments y
               JOIN payment_allocations al ON al.payment_id = y.id
              WHERE al.condition_id = ANY($1::bigint[])`, [ids])
        : { rows: [{ total: 0, paid: 0 }] };

      const byType: Record<string, number> = {};
      let latest: string | null = null;
      for (const e of events.rows as any[]) {
        byType[String(e.event_type)] = Number(e.n);
        // Date をそのまま文字列にすると "Tue Jun 30 2026..." になる。
        const on = dateStr(e.latest);
        if (on && (!latest || on > latest)) latest = on;
      }

      const facts: FlowFacts = {
        matterKind: matter.kind,
        matterStatus: matter.status,
        conditionCount: rows.length,
        activeConditionCount: rows.filter((r) => r.status === "active").length,
        conditionsWithWork: rows.filter((r) => r.work_id !== null).length,
        agreementExecuted: rows.some((r) => r.agreement_status === "executed"),
        agreementNo: rows.find((r) => r.agreement_status === "executed")?.agreement_no ?? null,
        issuedDocuments: (documents.rows as any[])
          .filter((d) => d.status === "issued")
          .map((d) => ({ documentNo: d.document_no ?? null, label: d.label ?? null })),
        draftDocuments: (documents.rows as any[]).filter((d) => d.status === "draft").length,
        events: byType,
        latestEventOn: latest,
        statements: Number((statements.rows[0] as any)?.n ?? 0),
        payments: {
          total: Number((payments.rows[0] as any)?.total ?? 0),
          paid: Number((payments.rows[0] as any)?.paid ?? 0)
        }
      };

      const steps = buildFlow(facts);
      return { steps, current: currentStep(steps), facts };
    } catch (error) { throw translate(error); }
  }
}

const labelOf = (kind: MatterKind) =>
  ({ work: "ライセンス", outsourcing: "業務委託", single: "単発" })[kind] ?? kind;
