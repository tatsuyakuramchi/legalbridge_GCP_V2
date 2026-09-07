import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ConditionRepository } from "./repository.js";
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
}

const ECONOMICS_COLUMNS: Record<keyof EconomicsPatch, string> = {
  name: "name", ratePpm: "rate_ppm", flatAmount: "flat_amount", unitAmount: "unit_amount",
  mgAmount: "mg_amount", agAmount: "ag_amount", termStart: "term_start", termEnd: "term_end",
  paymentTerms: "payment_terms", taxCategory: "tax_category", notes: "notes"
};

// 改訂で引き継ぐ列（id・状態・監査列を除く条件の中身すべて）。
const COPY_COLUMNS = [
  "condition_no", "agreement_id", "parent_id", "direction", "kind", "name", "counterparty_id",
  "work_id", "work_part_id", "exclusivity", "sublicensable", "term_start", "term_end",
  "currency", "pricing_model", "rate_ppm", "unit_amount", "flat_amount", "mg_amount", "ag_amount",
  "royalty_base", "deductible_costs", "tax_category", "withholding_note", "payment_terms",
  "cycle", "notes"
];

export class ConditionWriteService {
  private readonly repository: ConditionRepository;
  constructor(private readonly database: Transactable) {
    this.repository = new ConditionRepository(database);
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
  async updateEconomics(id: number, patch: EconomicsPatch, actor: string): Promise<WriteResult> {
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
        const revisedTo = await this.revise(client, id, entries);
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

  private async revise(client: Queryable, id: number, entries: Array<{ column: string; value: unknown }>) {
    const overrides = new Map(entries.map((e) => [e.column, e.value]));
    // 条件番号は一意なので改訂版には採り直す。基底番号に -R2, -R3 と重ねて系列を辿れるようにする。
    overrides.set("condition_no", await this.nextRevisionNo(client, id));
    const params: unknown[] = [id];
    const selected = COPY_COLUMNS.map((column) => {
      if (!overrides.has(column)) return `c.${column}`;
      params.push(overrides.get(column));
      return `$${params.length}`;
    });
    const inserted = await client.query(
      `INSERT INTO conditions (${COPY_COLUMNS.join(", ")}, status)
       SELECT ${selected.join(", ")}, 'active' FROM conditions c WHERE c.id = $1
       RETURNING id`,
      params
    );
    const newId = Number((inserted.rows[0] as { id: number }).id);
    await client.query(
      "UPDATE conditions SET status = 'superseded', superseded_by_id = $2, updated_at = now() WHERE id = $1",
      [id, newId]
    );
    // 範囲も引き継ぐ
    await client.query(
      `INSERT INTO condition_scopes (condition_id, scope_type, label, code, sort_order)
       SELECT $2, scope_type, label, code, sort_order FROM condition_scopes WHERE condition_id = $1
       ON CONFLICT DO NOTHING`,
      [id, newId]
    );
    return newId;
  }

  /** 改訂版の条件番号。CL-2026-00042 → CL-2026-00042-R2 → -R3。 */
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
