import { dateStr, inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ConditionRepository } from "./repository.js";
import { allocateNumber } from "../core/numbering.js";
import type { ConditionScope } from "../core/model.js";

/**
 * 書込サービス。V2 で「編集が一部にしか効かない」原因だった列単位APIをやめ、
 * 業務事実の単位で1トランザクションにまとめる。
 * V3 では事実の保存先が1箇所なので、書くのは常に1行。
 * 代わりに「参照で追随するもの」を数えて返し、利用者が影響範囲を確認できるようにする。
 */
export interface WriteResult {
  /** 実際に書き換えた保存先。 */
  changed: Array<{ target: string; rows: number }>;
  /** 書き換えていないが、参照によって表示が変わるもの。 */
  resolvesThrough: Array<{ target: string; rows: number }>;
  /** 改訂になった場合の新しい条件ID。 */
  revisedTo?: number;
}

export interface ConditionInput {
  /** 作った条件をこの案件に繋ぐ。案件から作ったときに渡す。 */
  matterId?: number | null;
  name: string;
  /** in＝取得（費用側）、out＝許諾（収入側）。 */
  direction: "in" | "out";
  kind: "license" | "product" | "service" | "expense" | "fee";
  counterpartyId: number;
  agreementId?: number | null;
  workId?: number | null;
  workPartId?: number | null;
  exclusivity?: "exclusive" | "non_exclusive" | null;
  sublicensable?: boolean | null;
  termStart?: string | null;
  termEnd?: string | null;
  currency?: string;
  pricingModel?: "fixed" | "unit_rate" | "revenue_rate" | "subscription" | "none";
  ratePpm?: number | null;
  unitAmount?: number | null;
  flatAmount?: number | null;
  mgAmount?: number | null;
  agAmount?: number | null;
  taxCategory?: "taxable" | "reduced" | "exempt";
  paymentTerms?: string | null;
  cycle?: string | null;
  notes?: string | null;
  /** 仕様・成果物。発注書・検収書の明細の「仕様・成果物」に出る。 */
  spec?: string | null;
  /** 成果物の帰属先。orderer=発注者（譲渡型）/ contractor=受注者（利用許諾型）。 */
  deliverableOwnership?: "orderer" | "contractor" | null;
  /** 外部で出した発注書の番号。V3 で出した発注書があればそちらを優先する。 */
  orderNo?: string | null;
  conditionNo?: string | null;
  scopes?: ConditionScope[];
}

export interface EconomicsPatch {
  name?: string;
  ratePpm?: number | null;
  flatAmount?: number | null;
  unitAmount?: number | null;
  mgAmount?: number | null;
  agAmount?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  paymentTerms?: string | null;
  taxCategory?: "taxable" | "reduced" | "exempt";
  notes?: string | null;
  /** 作品と独占性。登録のときに入れられるのに、編集で直せなかった。 */
  workId?: number | null;
  exclusivity?: "exclusive" | "non_exclusive" | null;
  spec?: string | null;
  deliverableOwnership?: "orderer" | "contractor" | null;
  orderNo?: string | null;
}

const ECONOMICS_COLUMNS: Record<keyof EconomicsPatch, string> = {
  name: "name", ratePpm: "rate_ppm", flatAmount: "flat_amount", unitAmount: "unit_amount",
  mgAmount: "mg_amount", agAmount: "ag_amount", termStart: "term_start", termEnd: "term_end",
  paymentTerms: "payment_terms", taxCategory: "tax_category", notes: "notes",
  workId: "work_id", exclusivity: "exclusivity",
  spec: "spec", deliverableOwnership: "deliverable_ownership", orderNo: "order_no"
};

// 改訂で引き継ぐ列（id・状態・監査列を除く条件の中身すべて）。
const COPY_COLUMNS = [
  "condition_no", "agreement_id", "parent_id", "direction", "kind", "name", "counterparty_id",
  "work_id", "work_part_id", "exclusivity", "sublicensable", "term_start", "term_end",
  "currency", "pricing_model", "rate_ppm", "unit_amount", "flat_amount", "mg_amount", "ag_amount",
  "royalty_base", "deductible_costs", "tax_category", "withholding_note", "payment_terms",
  "cycle", "notes", "series_id", "effective_from", "spec", "deliverable_ownership", "order_no"
];

export class ConditionWriteService {
  private readonly repository: ConditionRepository;
  constructor(private readonly database: Transactable) {
    this.repository = new ConditionRepository(database);
  }

  /**
   * 条件の登録。
   *
   * 価格方式に必要な値が無い状態を作らせない。V3 のスキーマは
   * 「unit_rate なら unit_amount がある」を CHECK で要求しており、移行では
   * V1 の宣言と実データの食い違いを101件直している。同じ穴を入口で塞ぐ。
   */
  async create(input: ConditionInput, actor: string): Promise<{ id: number; conditionNo: string | null }> {
    const name = String(input.name ?? "").trim();
    if (!name) throw new DomainError("VALIDATION", "条件名は必須です");

    const pricing = input.pricingModel ?? "none";
    const required: Record<string, unknown> = {
      unit_rate: input.unitAmount, revenue_rate: input.ratePpm, fixed: input.flatAmount
    };
    if (pricing in required && (required[pricing] === undefined || required[pricing] === null)) {
      const label = { unit_rate: "単価", revenue_rate: "料率", fixed: "定額" }[pricing as string];
      throw new DomainError("VALIDATION", `${label}を入れてください。値の無い計算方式は選べません`);
    }
    if (input.ratePpm !== undefined && input.ratePpm !== null
        && (input.ratePpm < 0 || input.ratePpm > 1_000_000)) {
      throw new DomainError("VALIDATION", "料率は 0〜100%（0〜1000000 ppm）の範囲です");
    }
    if (input.termStart && input.termEnd && input.termEnd < input.termStart) {
      throw new DomainError("VALIDATION", "終了日が開始日より前です");
    }
    if (input.workPartId && !input.workId) {
      throw new DomainError("VALIDATION", "パートを指定するなら作品も指定してください");
    }

    try {
      return await inTransaction(this.database, async (client) => {
        const party = await client.query(
          "SELECT id, name FROM parties WHERE id = $1", [input.counterpartyId]);
        if (!party.rows[0]) {
          throw new DomainError("NOT_FOUND", `取引先 ${input.counterpartyId} が見つかりません`);
        }
        if (input.workId) {
          const w = await client.query("SELECT id FROM works WHERE id = $1", [input.workId]);
          if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${input.workId} が見つかりません`);
        }
        if (input.workPartId) {
          const wp = await client.query(
            "SELECT id FROM work_parts WHERE id = $1 AND work_id = $2",
            [input.workPartId, input.workId]);
          if (!wp.rows[0]) {
            throw new DomainError("VALIDATION", "指定したパートはその作品のものではありません");
          }
        }

        const no = String(input.conditionNo ?? "").trim()
          || await allocateNumber(client, { prefix: "CL", table: "conditions", column: "condition_no" });

        const inserted = await client.query(
          `INSERT INTO conditions (condition_no, agreement_id, direction, kind, name, counterparty_id,
                                   work_id, work_part_id, exclusivity, sublicensable,
                                   term_start, term_end, currency, pricing_model,
                                   rate_ppm, unit_amount, flat_amount, mg_amount, ag_amount,
                                   tax_category, payment_terms, cycle, status, notes,
                                   spec, deliverable_ownership, order_no)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, $16, $17, $18, $19, $20, $21, $22, 'active', $23, $24, $25, $26)
           RETURNING id, condition_no`,
          [no, input.agreementId ?? null, input.direction, input.kind, name, input.counterpartyId,
           input.workId ?? null, input.workPartId ?? null,
           input.exclusivity ?? null, input.sublicensable ?? null,
           input.termStart ?? null, input.termEnd ?? null, input.currency ?? "JPY", pricing,
           input.ratePpm ?? null, input.unitAmount ?? null, input.flatAmount ?? null,
           input.mgAmount ?? null, input.agAmount ?? null,
           input.taxCategory ?? "taxable", input.paymentTerms ?? null, input.cycle ?? null,
           input.notes ?? null, input.spec ?? null, input.deliverableOwnership ?? null,
           input.orderNo ?? null]);
        const row = inserted.rows[0] as { id: number; condition_no: string | null };
        const id = Number(row.id);

        // 許諾範囲。1件も入れなければ、その次元は無制限として扱われる。
        for (const [index, scope] of (input.scopes ?? []).entries()) {
          const label = String(scope.label ?? "").trim();
          if (!label) continue;
          await client.query(
            `INSERT INTO condition_scopes (condition_id, scope_type, label, code, sort_order)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (condition_id, scope_type, label) DO NOTHING`,
            [id, scope.scopeType, label, scope.code ?? null, index]);
        }

        await recordAudit(client, {
          actor, action: "condition.create", targetType: "condition", targetId: id,
          detail: { name, direction: input.direction, kind: input.kind,
                    conditionNo: row.condition_no, counterparty: party.rows[0].name,
                    pricingModel: pricing }
        });
        // 案件から作られたなら、その場で繋ぐ。あとから繋ぐ導線を通らせると
        // 「作ったのに案件に出てこない」が起きる。
        if (input.matterId) {
          const m = await client.query(
            "SELECT id FROM matters WHERE id = $1", [input.matterId]);
          if (!m.rows[0]) {
            throw new DomainError("NOT_FOUND", `案件 ${input.matterId} が見つかりません`);
          }
          await client.query(
            `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
             VALUES ($1, 'condition', $2, 'covers', $3::jsonb)
             ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
            [input.matterId, String(id),
             JSON.stringify({ conditionNo: row.condition_no, kind: input.kind })]);
        }

        return { id, conditionNo: row.condition_no };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 相手先の変更。書くのは conditions.counterparty_id の1行だけ。
   * 文書・支払・案件は参照で追随するので書き換えない。
   */
  async changeCounterparty(id: number, partyId: number, actor: string): Promise<WriteResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await this.repository.requireExisting(client, id);
        const party = await client.query("SELECT id, name FROM parties WHERE id = $1", [partyId]);
        if (!party.rows[0]) throw new DomainError("NOT_FOUND", `取引先 ${partyId} が見つかりません`);

        const updated = await client.query(
          "UPDATE conditions SET counterparty_id = $2, updated_at = now() WHERE id = $1 RETURNING id",
          [id, partyId]
        );
        const resolvesThrough = await this.countReferences(client, id);
        await recordAudit(client, {
          actor, action: "condition.change_counterparty", targetType: "condition", targetId: id,
          detail: { from: before.counterparty_id, to: partyId, name: party.rows[0].name }
        });
        return {
          changed: [{ target: "conditions.counterparty_id", rows: updated.rowCount ?? 0 }],
          resolvesThrough
        };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 金額・期間などの変更。V2 には存在しなかった経路。
   * 実績（condition_events）を持つ条件は履歴を壊さないため改訂（新しい行）にする。
   */
  async updateEconomics(
    id: number, patch: EconomicsPatch, actor: string, effectiveFrom?: string | null
  ): Promise<WriteResult> {
    const entries = (Object.keys(patch) as Array<keyof EconomicsPatch>)
      .filter((key) => patch[key] !== undefined)
      .map((key) => ({ column: ECONOMICS_COLUMNS[key], value: patch[key] as unknown }));
    if (!entries.length) throw new DomainError("VALIDATION", "変更する項目がありません");

    try {
      return await inTransaction(this.database, async (client) => {
        const before = await this.repository.requireExisting(client, id);
        if (before.status === "void") {
          throw new DomainError("CONFLICT", "無効化された条件は編集できません");
        }
        if (before.status === "superseded") {
          throw new DomainError("CONFLICT", "旧版の条件は編集できません。最新版を編集してください");
        }
        if (patch.workId) {
          const w = await client.query("SELECT id FROM works WHERE id = $1", [patch.workId]);
          if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${patch.workId} が見つかりません`);
        }

        // 未来の日付を指定されたら「予約」にする。契約変更を締結した日に
        // 記録できないと、その日まで人が覚えているしかない。
        const startsLater = effectiveFrom !== null && effectiveFrom !== undefined
          && effectiveFrom > await this.today(client);

        if (startsLater) {
          if (before.status === "scheduled") {
            // 予約そのものを直しているだけ。まだ効いていないので上書きでよい。
            return await this.updateInPlace(client, id, entries, actor,
              { effective_from: effectiveFrom });
          }
          const pending = await client.query(
            `SELECT id, condition_no, effective_from FROM conditions
              WHERE series_id = $1 AND status = 'scheduled' AND id <> $2
              ORDER BY effective_from LIMIT 1`,
            [before.series_id ?? id, id]);
          const already = pending.rows[0] as
            { condition_no: string | null; effective_from: unknown } | undefined;
          if (already) {
            throw new DomainError("CONFLICT",
              `すでに ${dateStr(already.effective_from) ?? "?"} 適用の改訂が予定されています。` +
              "先にそれを直すか取り消してください");
          }
          const revisedTo = await this.revise(client, id, entries, effectiveFrom, "scheduled");
          await recordAudit(client, {
            actor, action: "condition.schedule_revision", targetType: "condition", targetId: id,
            detail: { patch, revisedTo, effectiveFrom }
          });
          return {
            changed: [{ target: `conditions（${effectiveFrom} 適用の改訂を予約）`, rows: 1 }],
            resolvesThrough: await this.countReferences(client, id),
            revisedTo
          };
        }

        const consumed = await client.query(
          "SELECT count(*)::int AS n FROM condition_events WHERE condition_id = $1 AND status = 'active'",
          [id]
        );
        const hasHistory = Number((consumed.rows[0] as { n: number }).n) > 0;

        if (!hasHistory) {
          const sets = entries.map((e, i) => `${e.column} = $${i + 2}`).join(", ");
          const updated = await client.query(
            `UPDATE conditions SET ${sets}, updated_at = now() WHERE id = $1 RETURNING id`,
            [id, ...entries.map((e) => e.value)]
          );
          await recordAudit(client, {
            actor, action: "condition.update", targetType: "condition", targetId: id,
            detail: { patch, mode: "in_place" }
          });
          return {
            changed: [{ target: "conditions", rows: updated.rowCount ?? 0 }],
            resolvesThrough: await this.countReferences(client, id)
          };
        }

        // 実績があるので改訂する。旧版は残し、新版へ superseded_by_id で繋ぐ。
        // 適用日の指定が無ければ今日から。JS の時計ではなく SQL の current_date に
        // 任せる（時差で1日ずれる）。
        const revisedTo = await this.revise(client, id, entries, effectiveFrom ?? null, "active");
        await recordAudit(client, {
          actor, action: "condition.revise", targetType: "condition", targetId: id,
          detail: { patch, revisedTo, reason: "実績があるため改訂" }
        });
        return {
          changed: [
            { target: "conditions（新版を作成）", rows: 1 },
            { target: "conditions（旧版を superseded に）", rows: 1 }
          ],
          resolvesThrough: await this.countReferences(client, id),
          revisedTo
        };
      });
    } catch (error) { throw translate(error); }
  }

  /** 許諾範囲の置き換え。地域・言語・媒体をまとめて差し替える。 */
  async replaceScopes(id: number, scopes: ConditionScope[], actor: string): Promise<WriteResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.repository.requireExisting(client, id);
        const removed = await client.query("DELETE FROM condition_scopes WHERE condition_id = $1", [id]);
        let written = 0;
        for (const [index, scope] of scopes.entries()) {
          const label = String(scope.label ?? "").trim();
          if (!label) continue;
          const r = await client.query(
            `INSERT INTO condition_scopes (condition_id, scope_type, label, code, sort_order)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (condition_id, scope_type, label) DO NOTHING`,
            [id, scope.scopeType, label, scope.code ?? null, index]
          );
          written += r.rowCount ?? 0;
        }
        await recordAudit(client, {
          actor, action: "condition.replace_scopes", targetType: "condition", targetId: id,
          detail: { removed: removed.rowCount ?? 0, written }
        });
        return {
          changed: [{ target: "condition_scopes", rows: written }],
          resolvesThrough: await this.countReferences(client, id)
        };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 改訂版を作る。
   *
   * status='active' なら即座に効かせて旧版を superseded にする。
   * status='scheduled' なら旧版は生きたまま置く。active のまま2行あると、
   * conditions を status='active' で絞っている8箇所が同じ条件を二重に数える。
   */
  /** データベースの今日。アプリの時計と食い違わせない（時差で1日ずれる）。 */
  private async today(client: Queryable): Promise<string> {
    const r = await client.query("SELECT current_date AS d");
    return String(dateStr((r.rows[0] as { d: unknown }).d));
  }

  /** その場で書き換える。実績が無い版と、まだ効いていない予約の版に使う。 */
  private async updateInPlace(
    client: Queryable, id: number, entries: Array<{ column: string; value: unknown }>,
    actor: string, extra: Record<string, unknown> = {}
  ): Promise<WriteResult> {
    const all = [...entries, ...Object.entries(extra).map(([column, value]) => ({ column, value }))];
    const sets = all.map((e, i) => `${e.column} = $${i + 2}`).join(", ");
    const updated = await client.query(
      `UPDATE conditions SET ${sets}, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, ...all.map((e) => e.value)]);
    await recordAudit(client, {
      actor, action: "condition.update", targetType: "condition", targetId: id,
      detail: { patch: Object.fromEntries(all.map((e) => [e.column, e.value])), mode: "in_place" }
    });
    return {
      changed: [{ target: "conditions", rows: updated.rowCount ?? 0 }],
      resolvesThrough: await this.countReferences(client, id)
    };
  }

  private async revise(
    client: Queryable, id: number, entries: Array<{ column: string; value: unknown }>,
    effectiveFrom: string | null, status: "active" | "scheduled"
  ) {
    const overrides = new Map(entries.map((e) => [e.column, e.value]));
    // 条件番号は一意なので改訂版には採り直す。基底番号に -R2, -R3 と重ねて系列を辿れるようにする。
    overrides.set("condition_no", await this.nextRevisionNo(client, id));
    // null は「今日から」。パラメータではなく SQL の current_date を置く。
    const RAW_TODAY = Symbol("current_date");
    overrides.set("effective_from", effectiveFrom ?? (RAW_TODAY as unknown as string));
    const params: unknown[] = [id];
    const selected = COPY_COLUMNS.map((column) => {
      if (!overrides.has(column)) return `c.${column}`;
      const value = overrides.get(column);
      if (typeof value === "symbol") return "current_date";
      params.push(value);
      return `$${params.length}`;
    });
    params.push(status);
    const inserted = await client.query(
      `INSERT INTO conditions (${COPY_COLUMNS.join(", ")}, status)
       SELECT ${selected.join(", ")}, $${params.length} FROM conditions c WHERE c.id = $1
       RETURNING id`,
      params
    );
    const newId = Number((inserted.rows[0] as { id: number }).id);
    if (status === "active") {
      await client.query(
        "UPDATE conditions SET status = 'superseded', superseded_by_id = $2, updated_at = now() WHERE id = $1",
        [id, newId]
      );
    }
    // 範囲も引き継ぐ
    await client.query(
      `INSERT INTO condition_scopes (condition_id, scope_type, label, code, sort_order)
       SELECT $2, scope_type, label, code, sort_order FROM condition_scopes WHERE condition_id = $1
       ON CONFLICT DO NOTHING`,
      [id, newId]
    );
    await this.carrySchedules(client, id, newId, effectiveFrom);
    return newId;
  }

  /** 改訂版の条件番号。CL-2026-00042 → CL-2026-00042-R2 → -R3。 */
  /**
   * 適用日以降の予定明細を新版へ移す。
   *
   * 移すのであって写さない。両方の版に同じ月の行が残ると、予定の合計が
   * 二重になる。実績が付いた行は動かさない（実績はそれが起きた版のもの）。
   * 金額は予定のまま持っていく。改訂で単価が変わっていれば、新版の明細を
   * 開いて直す（勝手に書き換えると、いくらの予定だったのかが消える）。
   */
  private async carrySchedules(
    client: Queryable, fromId: number, toId: number, effectiveFrom: string | null
  ) {
    const moved = await client.query(
      `UPDATE condition_schedules s
          SET condition_id = $2
        WHERE s.condition_id = $1
          AND ($3::date IS NULL OR s.due_on IS NULL OR s.due_on >= $3::date)
          AND NOT EXISTS (SELECT 1 FROM condition_events e
                           WHERE e.schedule_id = s.id AND e.status = 'active')
        RETURNING s.id`,
      [fromId, toId, effectiveFrom]);
    // 番号は版ごとに 1 から振り直す。第7回から始まる明細は読みにくい。
    const rows = (moved.rows as Array<{ id: number }>).map((r) => Number(r.id));
    if (!rows.length) return 0;
    await client.query(
      `UPDATE condition_schedules t SET seq = r.rn
         FROM (SELECT id, row_number() OVER (ORDER BY due_on NULLS LAST, seq, id) AS rn
                 FROM condition_schedules WHERE condition_id = $1) r
        WHERE t.id = r.id AND t.seq IS DISTINCT FROM r.rn`, [toId]);
    return rows.length;
  }

  private async nextRevisionNo(client: Queryable, id: number): Promise<string | null> {
    const r = await client.query(
      `SELECT split_part(condition_no, '-R', 1) AS base FROM conditions WHERE id = $1`, [id]);
    const base = (r.rows[0] as { base: string | null } | undefined)?.base ?? null;
    if (!base) return null;                       // 番号が無い条件はそのまま番号なしで作る
    const used = await client.query(
      `SELECT count(*)::int AS n FROM conditions
        WHERE condition_no = $1 OR condition_no LIKE $1 || '-R%'`, [base]);
    return `${base}-R${Number((used.rows[0] as { n: number }).n) + 1}`;
  }

  /** 書き換えないが参照で追随するものを数える。UI に「反映先」として出す。 */
  private async countReferences(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT
         (SELECT count(*)::int FROM document_conditions WHERE condition_id = $1)                AS documents,
         (SELECT count(*)::int FROM payment_allocations WHERE condition_id = $1)                AS payments,
         (SELECT count(*)::int FROM matter_links
           WHERE target_type = 'condition' AND target_ref = $1::text)                           AS matters,
         (SELECT count(*)::int FROM conditions WHERE parent_id = $1)                            AS children`,
      [id]
    );
    const row = r.rows[0] as Record<string, number>;
    return [
      { target: "この条件を出力した文書", rows: Number(row.documents ?? 0) },
      { target: "この条件に割り当てた支払", rows: Number(row.payments ?? 0) },
      { target: "この条件を参照する案件", rows: Number(row.matters ?? 0) },
      { target: "この条件から派生した条件", rows: Number(row.children ?? 0) }
    ].filter((entry) => entry.rows > 0);
  }
}
