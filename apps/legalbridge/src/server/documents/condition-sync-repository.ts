// 文書確定時の条件明細（condition_lines）同期 — 書込部。
// V1 conditionWrite.ts（upsertDocumentConditions / writeRegionLanguageChildren）の移植。
//   - (document_id, line_no) を一意キーに upsert（line_code は既存再利用 or CL-YYYY-NNNNN 採番）。
//   - material_code → work_materials 解決で source_material_id / source_work_id を結線。
//   - CHECK 整合: 非 royalty は rate/mg/ag を NULL、消化型（royalty/subscription 以外）は
//     amount_ex_tax 既定0。
//   - 新セットに無い旧 line_no は、実績（condition_events）・作品参照（work_material_uses）を
//     持たない行だけ削除（履歴は保全）＝V1 と同じ安全側の置換セマンティクス。
//   - 再発行時は行そのものを新版文書へ移設（moveConditions）＝condition_events の
//     condition_line_id 参照を壊さない。
// 必要権限は grant 066（condition_lines の INSERT/UPDATE/DELETE ほか）。

import {
  derivePaymentScheme, num, splitRegionLanguage, type ConditionSyncInput
} from "./condition-sync.js";

// トランザクション用の最小インターフェース（テストでは台本つきの偽クライアントを渡す）。
export interface ConditionSyncClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  release(): void;
}
export interface ConditionSyncPool {
  connect(): Promise<ConditionSyncClient>;
}

export interface ConditionSyncResult { written: number; deleted: number; lineIds: number[] }

export interface ConditionSyncRepository {
  upsertDocumentConditions(documentId: number, inputs: ConditionSyncInput[]): Promise<ConditionSyncResult>;
  // 再発行: 旧版文書の条件行を新版へ付け替える（実績の condition_line_id 参照を保全）。
  moveConditions(fromDocumentId: number, toDocumentId: number): Promise<number>;
}

const str = (v: unknown): string | null =>
  v == null || String(v).trim() === "" ? null : String(v);

export class PgConditionSyncRepository implements ConditionSyncRepository {
  constructor(private readonly pool: ConditionSyncPool) {}

  async upsertDocumentConditions(documentId: number, inputs: ConditionSyncInput[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const year = new Date().getFullYear();
      const keptLineNos: number[] = [];
      const lineIds: number[] = [];

      // この文書が属する作品（work_id の第一候補）。作品登録④のアップロード（form_data.work_code）、
      // 作品から起こした条件書（work_id）、作品への手動紐づけ（work-link）が同じキーに入る。
      // 2026-09-03: 従来は work_id を書かず source_work_id だけだったため、作品詳細・
      // マトリクス・一括編集（すべて cl.work_id で絞る）に条件が一切出なかった。
      const documentWorkId = await this.resolveDocumentWork(client, documentId);

      for (const c of inputs) {
        const lineNo = Number(c.line_no);
        keptLineNos.push(lineNo);

        // 素材結線（material_code → work_materials）。無ければ明示 source_work_id を採用。
        let materialId: number | null = null;
        let sourceWorkId: number | null = null;
        let materialWorkId: number | null = null;
        const code = str(c.material_code);
        if (code) {
          const found = await client.query(
            `SELECT id, work_id FROM work_materials WHERE material_code = $1 LIMIT 1`, [code]
          );
          if (found.rows[0]) {
            materialId = Number(found.rows[0].id);
            materialWorkId = Number(found.rows[0].work_id);
            sourceWorkId = materialWorkId;
          }
        }
        if (sourceWorkId == null && c.source_work_id != null) {
          sourceWorkId = Number(c.source_work_id);
        }
        // 条件が属する作品: 文書の作品 ＞ 素材の作品（跨ぎ原作では素材の作品は別）＞ 明示値。
        const workId = documentWorkId ?? materialWorkId ?? sourceWorkId;

        const scheme = derivePaymentScheme(c);
        const isRoyalty = scheme === "royalty";
        const isDepletable = !(scheme === "royalty" || scheme === "subscription");

        // line_code: 既存(同 document_id, line_no)を再利用、無ければ採番（V1 と同一形式）。
        const existing = await client.query(
          `SELECT line_code FROM condition_lines WHERE document_id = $1 AND line_no = $2`,
          [documentId, lineNo]
        );
        let lineCode = str(existing.rows[0]?.line_code);
        if (!lineCode) {
          const seq = await client.query(
            `INSERT INTO document_sequences (kind, year, current_value) VALUES ('condition_line', $1, 1)
               ON CONFLICT (kind, year) DO UPDATE SET current_value = document_sequences.current_value + 1
             RETURNING current_value`,
            [year]
          );
          lineCode = `CL-${year}-${String(Number(seq.rows[0].current_value)).padStart(5, "0")}`;
        }

        // 列→値マップ（列ズレ防止のため動的組み立て・V1 と同方式）。
        const row: Record<string, unknown> = {
          document_id: documentId,
          capability_id: documentId,   // 旧 cl.capability_id 参照の互換ミラー（V1 同様）
          legacy_role: "cfc",
          line_no: lineNo,
          line_code: lineCode,
          group_no: c.group_no ?? null,
          work_id: workId,
          source_material_id: materialId,
          source_work_id: sourceWorkId,
          direction: c.direction === "receivable" ? "receivable" : "payable",
          // 向きの明示フラグ（契約取込・アウト条件と同じ語彙）: イン＝当社が支払う（payable）。
          flow_direction: c.direction === "receivable" ? "out" : "in",
          payment_scheme: scheme,
          transaction_kind: str(c.transaction_kind) ?? "license",
          currency: str(c.currency) ?? "JPY",
          // 消化型は金額（税抜）を持つ（条件台帳の固定額・経費・手数料）。無ければ既定0。
          amount_ex_tax: isDepletable ? (num(c.amount_ex_tax) ?? 0) : null,
          unit_amount: num(c.unit_amount),
          rate_pct: isRoyalty ? num(c.rate_pct) : null,
          base_price_label: str(c.base_price_label),
          mg_amount: isRoyalty ? num(c.mg_amount) : null,
          ag_amount: isRoyalty ? num(c.ag_amount) : null,
          calc_type: str(c.calc_type),
          fixed_kind: str(c.fixed_kind),
          subscription_cycle: str(c.subscription_cycle),
          guarantee_type: str(c.guarantee_type),
          region_territory: str(c.region_territory),
          region_language: str(c.region_language),
          applies_scope: str(c.applies_scope),
          formula_text: str(c.formula_text),
          payment_terms: str(c.payment_terms),
          condition_name: str(c.condition_name),
          is_addon: Boolean(c.is_addon),
          manufacturer: str(c.manufacturer),
          seller: str(c.seller),
          max_region: str(c.max_region),
          max_language: str(c.max_language),
          status_flags: "{}",
          is_inbound: c.direction !== "receivable"
        };
        // 条件台帳からの直接書込みだけが持つ列（省略時は書かない＝従来経路・075 未適用でも不変）。
        if (c.counterparty_vendor_id != null) row.counterparty_vendor_id = Number(c.counterparty_vendor_id);
        if (c.notes !== undefined) row.notes = str(c.notes);
        if (c.term_start !== undefined) row.term_start = str(c.term_start);
        if (c.term_end !== undefined) row.term_end = str(c.term_end);
        if (c.line_kind && c.line_kind !== "payment") row.line_kind = c.line_kind;
        if (c.tax_category) row.tax_category = c.tax_category;
        const cols = Object.keys(row);
        const values = cols.map((k) => row[k]);
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const updates = cols
          .filter((k) => k !== "document_id" && k !== "line_no" && k !== "line_code")
          .map((k) => `${k} = EXCLUDED.${k}`)
          .concat(["updated_at = now()"])
          .join(", ");
        const inserted = await client.query(
          `INSERT INTO condition_lines (${cols.join(", ")}, updated_at)
             VALUES (${placeholders.join(", ")}, now())
           ON CONFLICT (document_id, line_no) DO UPDATE SET ${updates}
           RETURNING id`,
          values
        );
        const lineId = Number(inserted.rows[0].id);
        lineIds.push(lineId);

        // 許諾地域/言語の子テーブル（1対N）を置換保存。配列指定を優先し、無ければ
        // 結合文字列を分解して name のみで展開。どちらも無ければ子テーブルは触らない（V1同様）。
        await this.writeChildren(client, lineId, "condition_line_regions", "country",
          c.regions, c.region_territory);
        await this.writeChildren(client, lineId, "condition_line_languages", "language",
          c.languages, c.region_language);
      }

      // 不要行の安全削除（新セットに無い line_no で、実績/作品参照を持たない行のみ）。
      const guard = keptLineNos.length > 0
        ? { sql: "AND cl.line_no <> ALL($2::int[])", params: [documentId, keptLineNos] as unknown[] }
        : { sql: "", params: [documentId] as unknown[] };
      const removed = await client.query(
        `DELETE FROM condition_lines cl
          WHERE cl.document_id = $1 ${guard.sql}
            AND NOT EXISTS (SELECT 1 FROM condition_events e WHERE e.condition_line_id = cl.id)
            AND NOT EXISTS (SELECT 1 FROM work_material_uses w WHERE w.condition_line_id = cl.id)`,
        guard.params
      );

      await client.query("COMMIT");
      return { written: lineIds.length, deleted: Number(removed.rowCount ?? 0), lineIds };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 文書の作品紐づけ（form_data.work_code＝作品コード、または work_id＝V3条件書の作品ID欄。
  // 数字なら作品ID・それ以外は作品コードとして解決）。無ければ null。
  private async resolveDocumentWork(client: ConditionSyncClient, documentId: number): Promise<number | null> {
    const doc = await client.query(
      `SELECT form_data->>'work_code' AS work_code, form_data->>'work_id' AS work_ref
         FROM documents WHERE id = $1`,
      [documentId]
    );
    const ref = str(doc.rows[0]?.work_code) ?? str(doc.rows[0]?.work_ref);
    if (!ref) return null;
    if (/^\d+$/.test(ref)) {
      const byId = await client.query(`SELECT id FROM works WHERE id = $1 LIMIT 1`, [Number(ref)]);
      return byId.rows[0] ? Number(byId.rows[0].id) : null;
    }
    const byCode = await client.query(`SELECT id FROM works WHERE work_code = $1 LIMIT 1`, [ref]);
    if (byCode.rows[0]) return Number(byCode.rows[0].id);
    // 契約取込が付ける参照は「契約番号-作品コード」の連結（例: LIC-LO-2026-0015-W-2026-0001）。
    // 末尾の作品コード（W-YYYY-NNNN）で解決する（2026-09-04・ARC-ILT-2026-0019 の手当てで判明）。
    const suffix = /-(W-\d{4}-\d+)$/.exec(ref)?.[1];
    if (!suffix) return null;
    const bySuffix = await client.query(`SELECT id FROM works WHERE work_code = $1 LIMIT 1`, [suffix]);
    return bySuffix.rows[0] ? Number(bySuffix.rows[0].id) : null;
  }

  private async writeChildren(
    client: ConditionSyncClient, lineId: number, table: string, prefix: string,
    arr: ConditionSyncInput["regions"], joined: string | null | undefined
  ) {
    if (arr === undefined && (joined === undefined || joined === null)) return;
    const items = arr !== undefined ? arr : splitRegionLanguage(joined);
    await client.query(`DELETE FROM ${table} WHERE condition_line_id = $1`, [lineId]);
    for (let i = 0; i < items.length; i += 1) {
      await client.query(
        `INSERT INTO ${table} (condition_line_id, ${prefix}_code, ${prefix}_name, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [lineId, items[i].code, items[i].name, i]
      );
    }
  }

  async moveConditions(fromDocumentId: number, toDocumentId: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const moved = await client.query(
        `UPDATE condition_lines
            SET document_id = $2, capability_id = $2, updated_at = now()
          WHERE document_id = $1
          RETURNING id`,
        [fromDocumentId, toDocumentId]
      );
      await client.query("COMMIT");
      return moved.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

// テスト・ローカル用。行を line_no キーで保持し、置換セマンティクスを模倣する。
export class MemoryConditionSyncRepository implements ConditionSyncRepository {
  readonly documents = new Map<number, Map<number, ConditionSyncInput>>();
  readonly protectedLineNos = new Set<string>();   // `${docId}:${lineNo}` は実績あり＝削除しない
  async upsertDocumentConditions(documentId: number, inputs: ConditionSyncInput[]) {
    const lines = this.documents.get(documentId) ?? new Map<number, ConditionSyncInput>();
    const kept = new Set(inputs.map((c) => Number(c.line_no)));
    let deleted = 0;
    for (const lineNo of [...lines.keys()]) {
      if (!kept.has(lineNo) && !this.protectedLineNos.has(`${documentId}:${lineNo}`)) {
        lines.delete(lineNo);
        deleted += 1;
      }
    }
    inputs.forEach((c) => lines.set(Number(c.line_no), c));
    this.documents.set(documentId, lines);
    return { written: inputs.length, deleted, lineIds: inputs.map((_, i) => i + 1) };
  }
  async moveConditions(fromDocumentId: number, toDocumentId: number) {
    const lines = this.documents.get(fromDocumentId);
    if (!lines) return 0;
    this.documents.delete(fromDocumentId);
    this.documents.set(toDocumentId, lines);
    return lines.size;
  }
}
