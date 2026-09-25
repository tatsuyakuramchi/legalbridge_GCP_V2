import { dateStr, inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { buildFlow, currentStep, type DocumentStyle, type FlowFacts, type FlowStep } from "./flow.js";
import { MATTER_NUMBER, liveAgreementsOf, type MatterKind } from "./write-service.js";
import { allocateNumber } from "../core/numbering.js";

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
  // 作品案件は 制作委託 → 許諾 の流れをひとつで包むので、委託料系も繋げる。
  // 委託料系を繋いだ時点で「制作委託あり」に倒す（linkCondition）。
  work: [
    { value: "license", label: "許諾料" },
    { value: "product", label: "製品（グッズ等）" },
    { value: "service", label: "委託料" },
    { value: "expense", label: "実費" },
    { value: "fee", label: "手数料" }
  ],
  outsourcing: [
    { value: "service", label: "委託料" },
    { value: "expense", label: "実費" },
    { value: "fee", label: "手数料" }
  ],
  // その他案件（新しい契約スキームの立案・プロジェクト単位の運用）でも、
  // 金銭の条件を持つことはある。中身が決め打ちにならないので、どの種類も繋げる。
  single: [
    { value: "license", label: "許諾料" },
    { value: "product", label: "製品（グッズ等）" },
    { value: "service", label: "委託料" },
    { value: "expense", label: "実費" },
    { value: "fee", label: "手数料" }
  ]
};

export class MatterLinkService {
  constructor(private readonly database: Transactable) {}

  /** 条件を繋ぐ。取引モデルに合わない種類は理由を添えて断る。 */
  async attachCondition(matterId: number, conditionId: number, actor: string) {
    try {
      return await inTransaction(this.database, async (client) =>
        this.linkCondition(client, matterId, conditionId, actor));
    } catch (error) { throw translate(error); }
  }

  /**
   * 条件をまとめて繋ぐ。
   *
   * 1件ずつしか繋げず、10本の条件を持つ案件では10回押していた。合わない条件
   * （取引モデル違い）は、その行だけ理由を返して残りは繋ぐ。案件そのものが
   * 無いときだけ、全体を止める。
   */
  async attachConditions(matterId: number, conditionIds: number[], actor: string): Promise<{
    attached: number; results: Array<{ conditionId: number; attached: boolean; reason?: string }>;
  }> {
    const ids = [...new Set(conditionIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) throw new DomainError("VALIDATION", "条件を選んでください");
    try {
      return await inTransaction(this.database, async (client) => {
        const m = await client.query("SELECT id FROM matters WHERE id = $1", [matterId]);
        if (!m.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);
        const results: Array<{ conditionId: number; attached: boolean; reason?: string }> = [];
        for (const conditionId of ids) {
          try {
            results.push(await this.linkCondition(client, matterId, conditionId, actor));
          } catch (error) {
            // 断る理由はどれも SELECT の結果から出す（書いてから落ちない）ので、
            // 拾ってもこのトランザクションは続けられる。
            results.push({ conditionId, attached: false,
                           reason: (error as DomainError)?.message ?? "繋げません" });
          }
        }
        return { attached: results.filter((r) => r.attached).length, results };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 別の処理のトランザクションの中から繋ぐ（文書の下書きを作るときなど）。
   *
   * 呼ぶ側の主目的は別にあるので、合わない条件は黙って飛ばして繋いだものだけ
   * 返す。ここで止めると、取引モデルに合わない条件が1本あるだけで文書が作れなく
   * なってしまう。
   */
  async attachWithin(
    client: Queryable, matterId: number, conditionIds: number[], actor: string
  ): Promise<number[]> {
    const attached: number[] = [];
    for (const conditionId of [...new Set(conditionIds.map(Number))]) {
      if (!Number.isFinite(conditionId) || conditionId <= 0) continue;
      try {
        const r = await this.linkCondition(client, matterId, conditionId, actor);
        if (r.attached) attached.push(conditionId);
      } catch { /* 合わない条件は繋がないだけ。文書の作成は止めない。 */ }
    }
    return attached;
  }

  /**
   * 条件の側から案件を付ける。無ければその場で作る。
   *
   * 案件が全体の入口なのに、繋ぐ操作が案件の画面にしか無かった。条件を
   * 作った直後に付けられず、あとで案件を開いて探し直すことになっていた。
   *
   * 案件を新しく作るときは、条件から分かることは条件から取る。取引モデルは
   * 条件の種類で決まり、相手先も条件のものを引き継ぐ。人が選ぶのは名前だけ。
   */
  async linkFromCondition(
    conditionId: number,
    input: { matterId?: number | null; title?: string | null; withDocuments?: boolean },
    actor: string
  ): Promise<{ matterId: number; matterNo: string | null; created: boolean;
               attached: boolean; documents: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const c = await client.query(
          `SELECT c.id, c.condition_no, c.name, c.kind, c.counterparty_id
             FROM conditions c WHERE c.id = $1`, [conditionId]);
        const condition = c.rows[0] as any;
        if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);

        let matterId = input.matterId ? Number(input.matterId) : null;
        let matterNo: string | null = null;
        let created = false;

        if (!matterId) {
          const kind = matterKindForCondition(String(condition.kind));
          if (!kind) {
            throw new DomainError("VALIDATION",
              `${condition.kind} の条件から作れる案件がありません。案件の側から繋いでください`);
          }
          const title = String(input.title ?? "").trim()
            || String(condition.name ?? "").trim()
            || `条件 ${condition.condition_no ?? `#${conditionId}`}`;
          const no = await allocateNumber(client, MATTER_NUMBER);
          const inserted = await client.query(
            `INSERT INTO matters (matter_no, title, kind, status, counterparty_id, created_by)
             VALUES ($1, $2, $3, 'open', $4, $5) RETURNING id, matter_no`,
            [no, title, kind, condition.counterparty_id ?? null, actor]);
          const row = inserted.rows[0] as { id: number; matter_no: string | null };
          matterId = Number(row.id);
          matterNo = row.matter_no;
          created = true;
          await recordAudit(client, {
            actor, action: "matter.create", targetType: "matter", targetId: matterId,
            detail: { title, kind, matterNo, fromConditionId: conditionId,
                      counterpartyId: condition.counterparty_id ?? null }
          });
        } else {
          const m = await client.query(
            "SELECT id, matter_no FROM matters WHERE id = $1", [matterId]);
          const found = m.rows[0] as { id: number; matter_no: string | null } | undefined;
          if (!found) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);
          matterNo = found.matter_no;
        }

        const link = await this.linkCondition(client, matterId, conditionId, actor);

        // 条件から出した文書も同じ案件に寄せる。文書だけ案件から外れていると、
        // 案件を開いても発行済みの書類が見えない。すでに別の案件に付いている
        // ものは触らない（横取りになる）。
        let documents = 0;
        if (input.withDocuments !== false) {
          const moved = await client.query(
            `UPDATE documents d SET matter_id = $1
              WHERE d.matter_id IS NULL
                AND d.status <> 'void'
                AND EXISTS (SELECT 1 FROM document_conditions dc
                             WHERE dc.document_id = d.id AND dc.condition_id = $2)
              RETURNING d.id`, [matterId, conditionId]);
          documents = moved.rows.length;
          if (documents) {
            await recordAudit(client, {
              actor, action: "matter.attach_document", targetType: "matter", targetId: matterId,
              detail: { conditionId, documentIds: moved.rows.map((r: any) => Number(r.id)) }
            });
          }
        }

        return { matterId, matterNo, created, attached: link.attached, documents };
      });
    } catch (error) { throw translate(error); }
  }

  /** 繋ぐ本体。作成と同じトランザクションで走らせたいので client を受ける。 */
  private async linkCondition(
    client: Queryable, matterId: number, conditionId: number, actor: string
  ) {
    const m = await client.query(
      "SELECT id, matter_no, kind, production FROM matters WHERE id = $1", [matterId]);
    const matter = m.rows[0] as
      { id: number; matter_no: string | null; kind: MatterKind; production: boolean | null } | undefined;
    if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

    const c = await client.query(
      "SELECT id, condition_no, kind, status, deliverable_ownership FROM conditions WHERE id = $1",
      [conditionId]);
    const condition = c.rows[0] as any;
    if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);

    const allowed = CONDITION_KINDS_BY_MATTER[matter.kind];
    if (!allowed.length) {
      throw new DomainError("VALIDATION",
        `${labelOf(matter.kind)}モデルの案件は条件を持ちません。条件が要るなら取引モデルを変えてください`);
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
      // 作品案件に委託料系の条件、または成果物が受注者に帰属する条件を繋いだら、
      // 「制作委託あり」が未決定のうちは自動で あり に倒す。人が なし と決めたものは触らない。
      const productionLike = ["service", "expense", "fee"].includes(String(condition.kind))
        || condition.deliverable_ownership === "contractor";
      if (matter.kind === "work" && matter.production === null && productionLike) {
        await client.query("UPDATE matters SET production = true WHERE id = $1", [matterId]);
        await recordAudit(client, {
          actor, action: "matter.update", targetType: "matter", targetId: matterId,
          detail: { production: true, reason: "condition", conditionId }
        });
      }
    }
    return { attached: added, conditionId, reason: added ? undefined : "すでに繋がっています" };
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
        `SELECT m.id, m.kind, m.status, m.document_style, m.work_id, m.production, w.title AS work_title
           FROM matters m LEFT JOIN works w ON w.id = m.work_id WHERE m.id = $1`, [matterId]);
      const matter = head.rows[0] as
        { kind: MatterKind; status: string; document_style: string | null;
          work_id: number | string | null; production: boolean | null; work_title: string | null } | undefined;
      if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      const conditions = await this.database.query(
        `SELECT c.id, c.status, c.work_id, c.kind, c.deliverable_ownership,
                a.agreement_no, a.status AS agreement_status, a.kind AS agreement_kind
           FROM matter_links ml
           JOIN conditions c ON c.id::text = ml.target_ref
           LEFT JOIN agreements a ON a.id = c.agreement_id
          WHERE ml.matter_id = $1 AND ml.target_type = 'condition'`, [matterId]);
      const rows = conditions.rows as any[];
      const linkedIds = rows.map((r) => Number(r.id));
      // 実績・計算書・支払は登録した版の id に付いたまま残る。改訂の全版（系列）で数える。
      const series = linkedIds.length
        ? await this.database.query(
            `SELECT x.id FROM conditions x
              WHERE COALESCE(x.series_id, x.id) IN
                    (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = ANY($1::bigint[]))`,
            [linkedIds])
        : { rows: [] as any[] };
      const ids = [...new Set([...linkedIds, ...(series.rows as any[]).map((r) => Number(r.id))])];

      const documents = await this.database.query(
        `SELECT d.status, d.document_no, d.template_version_id, t.label, t.template_key,
                lower(COALESCE(d.rendered_values ->> 'HAS_BASE_CONTRACT',
                               d.manual_inputs ->> 'HAS_BASE_CONTRACT', '')) AS has_base
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

      // 定額の条件が何本あって、何本が払い切れたか（完了扱いも含む）。
      // 改訂の予約中は旧版と新版が両方 active なので、系列で1本と数える。
      // 支払の割当は旧版の id に付いたまま残るので、系列の全版で足す。
      const settled = ids.length
        ? await this.database.query(
            `SELECT count(DISTINCT COALESCE(c.series_id, c.id))::int AS fixed,
                    count(DISTINCT COALESCE(c.series_id, c.id))
                      FILTER (WHERE c.closed_at IS NOT NULL OR COALESCE(pd.paid, 0) >= c.flat_amount)::int AS done
               FROM conditions c
               LEFT JOIN LATERAL (
                 SELECT sum(al.amount) AS paid FROM payment_allocations al
                   JOIN payments y ON y.id = al.payment_id
                  WHERE y.status = 'paid'
                    AND al.condition_id IN (SELECT x.id FROM conditions x
                                             WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))
               ) pd ON true
              WHERE c.id = ANY($1::bigint[]) AND c.status = 'active'
                AND c.pricing_model IN ('fixed', 'unit_rate') AND COALESCE(c.flat_amount, 0) > 0`, [ids])
        : { rows: [{ fixed: 0, done: 0 }] };

      const tasks = await this.database.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'done')::int AS done
           FROM tasks WHERE matter_id = $1`, [matterId]);
      const children = await this.database.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'done')::int AS open
           FROM matters WHERE parent_id = $1`, [matterId]);
      const live = await liveAgreementsOf(this.database, matterId);

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
        documentStyle: (matter.document_style as DocumentStyle | null) ?? null,
        matterStatus: matter.status,
        conditionCount: rows.length,
        activeConditionCount: rows.filter((r) => r.status === "active").length,
        conditionsWithWork: rows.filter((r) => r.work_id !== null).length,
        agreementExecuted: rows.some((r) => r.agreement_status === "executed"),
        agreementNo: rows.find((r) => r.agreement_status === "executed")?.agreement_no ?? null,
        // 基本契約でも単体契約でも済。どちらかは工程の根拠に書く。
        agreementKind: (rows.find((r) => r.agreement_status === "executed")?.agreement_kind as string | undefined) ?? null,
        issuedDocuments: (documents.rows as any[])
          .filter((d) => d.status === "issued")
          .map((d) => ({ documentNo: d.document_no ?? null, label: d.label ?? null })),
        draftDocuments: (documents.rows as any[]).filter((d) => d.status === "draft").length,
        // テンプレートを持たない文書＝取り込んだもの（相手方から受け取った文書）。
        importedDocuments: (documents.rows as any[])
          .filter((d) => d.template_version_id === null && d.status !== "void").length,
        events: byType,
        latestEventOn: latest,
        statements: Number((statements.rows[0] as any)?.n ?? 0),
        payments: {
          total: Number((payments.rows[0] as any)?.total ?? 0),
          paid: Number((payments.rows[0] as any)?.paid ?? 0)
        },
        fixedConditions: {
          total: Number((settled.rows[0] as any)?.fixed ?? 0),
          done: Number((settled.rows[0] as any)?.done ?? 0)
        },
        workId: matter.work_id === null || matter.work_id === undefined ? null : Number(matter.work_id),
        workTitle: matter.work_title ?? null,
        production: matter.production ?? null,
        serviceConditions: rows.filter((r) => r.status === "active"
          && ["service", "expense", "fee"].includes(String(r.kind))).length,
        licenseConditions: rows.filter((r) => r.status === "active"
          && ["license", "product"].includes(String(r.kind))).length,
        contractorOwned: rows.filter((r) => r.deliverable_ownership === "contractor").length,
        liveAgreements: live.map((a) => ({ agreementNo: a.agreementNo, kind: a.kind, currentEnd: a.currentEnd })),
        children: {
          total: Number((children.rows[0] as any)?.total ?? 0),
          open: Number((children.rows[0] as any)?.open ?? 0)
        },
        tasks: {
          total: Number((tasks.rows[0] as any)?.total ?? 0),
          done: Number((tasks.rows[0] as any)?.done ?? 0)
        },
        spotOrders: (documents.rows as any[]).filter((d) =>
          d.status === "issued"
          && ["purchase_order", "intl_purchase_order"].includes(String(d.template_key ?? ""))
          && !["true", "はい", "1", "あり"].includes(String(d.has_base ?? ""))).length
      };

      // 受付箱から繋いだ依頼。表がまだ無い環境（004 の A-052 未適用）では出さない。
      try {
        const intake = await this.database.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE has_unseen_update)::int AS unseen,
                  COALESCE(array_agg(COALESCE(backlog_issue_key, request_no) ORDER BY created_at), '{}') AS keys
             FROM intake_requests
            WHERE matter_id = $1 AND state IN ('accepted', 'duplicate')`, [matterId]);
        const i = intake.rows[0] as any;
        facts.intake = {
          total: Number(i?.total ?? 0), unseen: Number(i?.unseen ?? 0),
          keys: ((i?.keys ?? []) as unknown[]).filter(Boolean).map(String)
        };
      } catch (error) {
        if ((error as { code?: string })?.code !== "42P01") throw error;
      }

      const steps = buildFlow(facts);
      return { steps, current: currentStep(steps), facts };
    } catch (error) { throw translate(error); }
  }
}

const labelOf = (kind: MatterKind) =>
  ({ work: "作品案件", outsourcing: "業務案件", single: "その他案件" })[kind] ?? kind;

/**
 * 条件の種類から案件の種類を決める（条件から案件を新しく作るとき）。
 * 委託料系は作品案件にも繋げるが、条件だけから作るなら業務案件が自然。
 * 許諾料・製品は作品案件。表の逆引きだと重なりで最初に見つかったものになるので、明示する。
 */
export function matterKindForCondition(conditionKind: string): MatterKind | null {
  if (conditionKind === "license" || conditionKind === "product") return "work";
  if (conditionKind === "service" || conditionKind === "expense" || conditionKind === "fee") return "outsourcing";
  return null;
}
