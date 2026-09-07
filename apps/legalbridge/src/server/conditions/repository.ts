import type { DatabasePool } from "../db/pool.js";

// Read-only projection over the shared production condition_lines table.
// Only columns V2 already writes/reads in production are referenced, so this
// stays safe against schema drift and needs no DDL or template change.
export interface ConditionLineRow {
  id: number;
  lineNo: number | null;
  documentId: number | null;
  documentNumber: string | null;
  matterId: number | null;
  templateType: string | null;
  direction: string | null;        // payable / receivable
  flowDirection: string | null;    // in / out
  transactionKind: string | null;
  conditionName: string;
  vendorName: string;
  workTitle: string;
  territory: string | null;
  language: string | null;
  currency: string | null;
  amountExTax: number | null;
  mgAmount: number | null;
  ratePct: number | null;
  termStart: string | null;
  // 有効性（2026-09-02）：巻き直しで旧版になった文書（form_data.superseded_by）の
  // 条件は無効。一覧・詳細に旗を出し、計算書の下地（condition-economics）では弾く。
  // 条件台帳（condition_ledger）の下書き（form_data.ledger_status='draft'）も無効扱い（2026-09-04）。
  effective: boolean;
  supersededBy: string | null;
  ledgerStatus?: "draft" | "final" | null;
}

// Grant-free rollup over condition_lines only (installments/events are not
// granted to the runtime role, so true consumption is a later, granted slice).
export interface ConditionLineSummaryRow {
  direction: string;   // payable / receivable / unknown
  currency: string;    // JPY etc.
  lineCount: number;
  totalAmount: number; // sum of amount_ex_tax
  totalMg: number;     // sum of mg_amount
}

export interface ConditionInstallment {
  installmentNo: number;
  triggerKind: string;
  plannedAmount: number;
  dueDate: string | null;
  settled: boolean;
}
export interface ConditionEvent {
  eventNo: number;
  eventType: string;   // inspection / royalty_calc / payment
  occurredAt: string | null;
  amount: number;
  period: string | null;
  documentId: number | null;
}
export interface ConditionConsumption {
  currency: string | null;
  plannedTotal: number;
  consumedTotal: number;
  balance: number;
  inspectionRequired: boolean;
  inspectionDone: boolean;
  installments: ConditionInstallment[];
  events: ConditionEvent[];
}

export interface ConditionLineDetail extends ConditionLineRow {
  matterCode: string | null;
  matterTitle: string | null;
  // null when the settlement tables are not readable (grant 011 not applied)
  // or when there is no schedule/event data for the line.
  consumption: ConditionConsumption | null;
  exclusivity: string | null;
  sublicenseAllowed: boolean | null;
  paymentScheme: string | null;
  paymentTerms: string | null;
  royaltyBase: string | null;
  deductibleCosts: string | null;
  agAmount: number | null;
  notes: string | null;
  regions: string[];
  languages: string[];
  // 業務委託の行種別・税区分・対象素材・期間・親条件（編集フォーム用・2026-09-07）
  lineKind: string | null;              // payment / expense / fee（利用許諾行は payment）
  taxCategory: string | null;           // taxable / reduced / exempt
  materialCode: string | null;
  sourceMaterialId: number | null;
  sourceMaterialName: string | null;
  workId: number | null;
  termEnd: string | null;
  counterpartyVendorId: number | null;
  parentLicenseConditionId: number | null;
  groupNo: number | null;
  basePriceLabel: string | null;
}

// Portfolio-wide settlement KPIs (grant 011); null when not readable.
export interface ConditionSettlementSummary {
  plannedTotal: number;
  consumedTotal: number;
  consumptionRate: number;        // 0..1
  linesRequiringInspection: number;
  linesInspected: number;
  inspectionRate: number;         // 0..1
}

// 重複警告用（導線ガード）。ある作品に既に紐づく条件行を、作品レベル
// (source_material_id IS NULL) とマテリアル由来 (IS NOT NULL) を区別して返す。
// 消化実績はこれらを別建てで合算するため、新規条件作成時に重複の気づきを与える。
export interface ConditionOverlapLine {
  id: number;
  conditionName: string;
  direction: string | null;          // payable / receivable
  flowDirection: string | null;      // in / out
  sourceMaterialId: number | null;   // null=作品レベル / 値=マテリアル由来
  materialName: string | null;
  amountExTax: number | null;
  mgAmount: number | null;
  currency: string | null;
  documentNumber: string | null;
}
export interface ConditionOverlap {
  workId: number;
  total: number;
  receivableCount: number;
  payableCount: number;
  lines: ConditionOverlapLine[];
}

// 条件明細の詳細編集（2026-09-07）。画面（条件明細 → 詳細 → 編集）から項目単位で直す。
// undefined の項目は触らない。regions / languages は名前の配列（コードは任意）で丸ごと置き換え。
// documentId は「元文書（この条件明細が属する文書）」の付け替え＝紐づけ。null で外す。
export interface ConditionLineUpdate {
  conditionName?: string;
  currency?: string | null;
  amountExTax?: number | null;
  mgAmount?: number | null;
  agAmount?: number | null;
  ratePct?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  exclusivity?: string | null;
  sublicenseAllowed?: boolean | null;
  paymentScheme?: string | null;
  paymentTerms?: string | null;
  royaltyBase?: string | null;
  deductibleCosts?: string | null;
  notes?: string | null;
  transactionKind?: string | null;
  workId?: number | null;
  documentId?: number | null;
  parentLicenseConditionId?: number | null;
  // 業務委託（行種別・税区分・対象素材・相手方・加算グループ・基準価格）
  lineKind?: string | null;
  taxCategory?: string | null;
  materialCode?: string | null;
  sourceMaterialId?: number | null;
  counterpartyVendorId?: number | null;
  groupNo?: number | null;
  basePriceLabel?: string | null;
  regions?: Array<{ code: string | null; name: string }>;
  languages?: Array<{ code: string | null; name: string }>;
}

export interface ConditionLineRepository {
  list(query: string, limit?: number): Promise<ConditionLineRow[]>;
  summary(): Promise<ConditionLineSummaryRow[]>;
  settlement(): Promise<ConditionSettlementSummary | null>;
  find(id: number): Promise<ConditionLineDetail | null>;
  overlap(workId: number): Promise<ConditionOverlap>;
  // 相手方の後付け補修（Phase 17・V1遺産データの取引先欠落用・guarded write）。
  updateCounterparty(id: number, vendorId: number): Promise<{ id: number; vendorName: string }>;
  // 項目単位の編集（guarded write・同じ condition-repair スコープ）。
  update(id: number, patch: ConditionLineUpdate): Promise<{ id: number }>;
}

// 編集可能な列（画面の項目 → 列名）。ここに無い項目は書かない。
const UPDATABLE_COLUMNS: Record<keyof Omit<ConditionLineUpdate, "regions" | "languages">, string> = {
  conditionName: "condition_name",
  currency: "currency",
  amountExTax: "amount_ex_tax",
  mgAmount: "mg_amount",
  agAmount: "ag_amount",
  ratePct: "rate_pct",
  termStart: "term_start",
  termEnd: "term_end",
  exclusivity: "exclusivity",
  sublicenseAllowed: "sublicense_allowed",
  paymentScheme: "payment_scheme",
  paymentTerms: "payment_terms",
  royaltyBase: "royalty_base",
  deductibleCosts: "deductible_costs",
  notes: "notes",
  transactionKind: "transaction_kind",
  workId: "work_id",
  documentId: "document_id",
  parentLicenseConditionId: "parent_license_condition_id",
  lineKind: "line_kind",
  taxCategory: "tax_category",
  materialCode: "material_code",
  sourceMaterialId: "source_material_id",
  counterpartyVendorId: "counterparty_vendor_id",
  groupNo: "group_no",
  basePriceLabel: "base_price_label"
};

export class ConditionRepairError extends Error {
  constructor(message: string, readonly code: "LINE_NOT_FOUND" | "VENDOR_NOT_FOUND" | "WORK_NOT_FOUND" | "DOCUMENT_NOT_FOUND") {
    super(message);
    this.name = "ConditionRepairError";
  }
}

export class PgConditionLineRepository implements ConditionLineRepository {
  constructor(private readonly database: DatabasePool) {}
  async list(query: string, limit = 300) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT cl.id, cl.line_no, cl.document_id, cl.direction, cl.flow_direction,
              cl.transaction_kind, cl.condition_name, cl.currency,
              cl.amount_ex_tax, cl.mg_amount, cl.rate_pct, cl.term_start,
              COALESCE(
                (SELECT string_agg(r.country_name, '・' ORDER BY r.sort_order, r.id)
                   FROM condition_line_regions r WHERE r.condition_line_id = cl.id),
                cl.region_territory
              ) AS region_territory,
              COALESCE(
                (SELECT string_agg(l.language_name, '・' ORDER BY l.sort_order, l.id)
                   FROM condition_line_languages l WHERE l.condition_line_id = cl.id),
                cl.region_language
              ) AS region_language,
              d.document_number, d.matter_id, d.template_type,
              d.lifecycle_status, d.form_data->>'superseded_by' AS superseded_by,
              d.form_data->>'ledger_status' AS ledger_status,
              COALESCE(v.vendor_name, '') AS vendor_name,
              COALESCE(w.title, '')       AS work_title
         FROM condition_lines cl
         LEFT JOIN documents d ON d.id = cl.document_id
         LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
         LEFT JOIN works w ON w.id = cl.work_id
        WHERE ($1 = '%%'
               OR cl.condition_name ILIKE $1
               OR COALESCE(d.document_number, '') ILIKE $1
               OR COALESCE(v.vendor_name, '') ILIKE $1
               OR COALESCE(w.title, '') ILIKE $1
               OR COALESCE(cl.region_territory, '') ILIKE $1
               OR COALESCE(cl.region_language, '') ILIKE $1
               OR EXISTS (SELECT 1 FROM condition_line_regions sr WHERE sr.condition_line_id = cl.id AND sr.country_name ILIKE $1)
               OR EXISTS (SELECT 1 FROM condition_line_languages sl WHERE sl.condition_line_id = cl.id AND sl.language_name ILIKE $1))
          -- 無効化（void）された文書の条件は一覧に出さない（監査2026-08-25 ギャップ3）
          AND (d.id IS NULL OR d.lifecycle_status IS NULL OR d.lifecycle_status <> 'voided')
        ORDER BY cl.id DESC
        LIMIT $2`,
      [keyword, Math.min(Math.max(limit, 1), 1000)]
    );
    return result.rows.map(mapRow);
  }

  async summary() {
    const result = await this.database.query(
      `SELECT COALESCE(NULLIF(cl.direction, ''), 'unknown') AS direction,
              COALESCE(NULLIF(cl.currency, ''), 'JPY')      AS currency,
              COUNT(*)::int                                 AS line_count,
              COALESCE(SUM(cl.amount_ex_tax), 0)            AS total_amount,
              COALESCE(SUM(cl.mg_amount), 0)                AS total_mg
         FROM condition_lines cl
         LEFT JOIN documents d ON d.id = cl.document_id
        WHERE d.id IS NULL OR d.lifecycle_status IS NULL OR d.lifecycle_status <> 'voided'
        GROUP BY 1, 2
        ORDER BY 1, 2`
    );
    return result.rows.map(mapSummary);
  }

  async settlement(): Promise<ConditionSettlementSummary | null> {
    try {
      const result = await this.database.query(
        `SELECT
           COALESCE((SELECT SUM(planned_amount_ex_tax) FROM condition_line_installments), 0) AS planned,
           COALESCE((SELECT SUM(amount_ex_tax) FROM condition_events WHERE voided_at IS NULL), 0) AS consumed,
           (SELECT COUNT(DISTINCT condition_line_id) FROM condition_line_installments
             WHERE trigger_kind = 'on_inspection') AS required,
           (SELECT COUNT(DISTINCT e.condition_line_id) FROM condition_events e
             WHERE e.event_type = 'inspection' AND e.voided_at IS NULL
               AND EXISTS (SELECT 1 FROM condition_line_installments i
                            WHERE i.condition_line_id = e.condition_line_id
                              AND i.trigger_kind = 'on_inspection')) AS inspected`
      );
      const row = result.rows[0];
      const planned = num(row.planned) ?? 0;
      const consumed = num(row.consumed) ?? 0;
      const required = Number(row.required ?? 0);
      const inspected = Number(row.inspected ?? 0);
      if (planned === 0 && consumed === 0 && required === 0) return null;
      return {
        plannedTotal: planned,
        consumedTotal: consumed,
        consumptionRate: planned > 0 ? Math.min(1, consumed / planned) : 0,
        linesRequiringInspection: required,
        linesInspected: inspected,
        inspectionRate: required > 0 ? inspected / required : 0
      };
    } catch (error) {
      if ((error as { code?: string })?.code === "42501") return null;
      throw error;
    }
  }

  async find(id: number) {
    const detail = await this.database.query(
      `SELECT cl.id, cl.line_no, cl.document_id, cl.direction, cl.flow_direction,
              cl.transaction_kind, cl.condition_name, cl.currency,
              cl.amount_ex_tax, cl.mg_amount, cl.ag_amount, cl.rate_pct, cl.term_start,
              cl.region_territory, cl.region_language, cl.exclusivity, cl.sublicense_allowed,
              cl.payment_scheme, cl.payment_terms, cl.royalty_base,
              cl.deductible_costs, cl.notes,
              d.document_number, d.matter_id, d.template_type,
              d.lifecycle_status, d.form_data->>'superseded_by' AS superseded_by,
              d.form_data->>'ledger_status' AS ledger_status,
              m.matter_code, m.title AS matter_title,
              COALESCE(v.vendor_name, '') AS vendor_name,
              COALESCE(w.title, '')       AS work_title
         FROM condition_lines cl
         LEFT JOIN documents d ON d.id = cl.document_id
         LEFT JOIN matters m ON m.id = d.matter_id
         LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
         LEFT JOIN works w ON w.id = cl.work_id
        WHERE cl.id = $1`,
      [id]
    );
    if (!detail.rows[0]) return null;
    // 任意列（075 の line_kind / tax_category、素材・期間・親条件など）は列名を固定せずに読む。
    // 固定列に入れると未適用環境で SELECT ごと失敗し、詳細が「取得できませんでした」になる（2026-09-07）。
    const extra = await this.database.query(
      "SELECT row_to_json(cl) AS line FROM condition_lines cl WHERE cl.id = $1", [id]
    ).then((r) => (r.rows[0]?.line ?? {}) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
    const sourceMaterialId = extra.source_material_id == null ? null : Number(extra.source_material_id);
    const sourceMaterialName = sourceMaterialId
      ? await this.database.query("SELECT material_name FROM work_materials WHERE id = $1", [sourceMaterialId])
        .then((r) => (r.rows[0]?.material_name as string | null) ?? null).catch(() => null)
      : null;
    const [regions, languages] = await Promise.all([
      this.database.query(
        `SELECT country_name FROM condition_line_regions
          WHERE condition_line_id = $1 ORDER BY sort_order, id`, [id]),
      this.database.query(
        `SELECT language_name FROM condition_line_languages
          WHERE condition_line_id = $1 ORDER BY sort_order, id`, [id])
    ]);
    const row = detail.rows[0];
    return {
      ...mapRow(row),
      consumption: await this.consumption(id, row.currency ?? null),
      matterCode: row.matter_code ?? null,
      matterTitle: row.matter_title ?? null,
      exclusivity: row.exclusivity ?? null,
      sublicenseAllowed: row.sublicense_allowed === null || row.sublicense_allowed === undefined
        ? null : Boolean(row.sublicense_allowed),
      paymentScheme: row.payment_scheme ?? null,
      paymentTerms: row.payment_terms ?? null,
      royaltyBase: row.royalty_base ?? null,
      deductibleCosts: row.deductible_costs ?? null,
      agAmount: num(row.ag_amount),
      notes: row.notes ?? null,
      // 業務委託・素材・期間・親条件（2026-09-07 の編集フォーム用）
      lineKind: (extra.line_kind as string | null) ?? null,
      taxCategory: (extra.tax_category as string | null) ?? null,
      materialCode: (extra.material_code as string | null) ?? null,
      sourceMaterialId,
      sourceMaterialName,
      workId: extra.work_id == null ? null : Number(extra.work_id),
      termEnd: extra.term_end ? String(extra.term_end).slice(0, 10) : null,
      counterpartyVendorId: extra.counterparty_vendor_id == null ? null : Number(extra.counterparty_vendor_id),
      parentLicenseConditionId: extra.parent_license_condition_id == null ? null : Number(extra.parent_license_condition_id),
      groupNo: extra.group_no == null ? null : Number(extra.group_no),
      basePriceLabel: (extra.base_price_label as string | null) ?? null,
      regions: regions.rows.length
        ? regions.rows.map((r) => String(r.country_name)).filter(Boolean)
        : legacyScopeNames(row.region_territory),
      languages: languages.rows.length
        ? languages.rows.map((r) => String(r.language_name)).filter(Boolean)
        : legacyScopeNames(row.region_language)
    };
  }

  // 項目単位の編集（grant 066: condition_lines の UPDATE・regions/languages の INSERT/DELETE）。
  // 1 トランザクション。document_id を付け替えるときは capability_id も揃える（moveConditions と同じ）。
  async update(id: number, patch: ConditionLineUpdate): Promise<{ id: number }> {
    // 実在する列だけ更新する（075 未適用なら line_kind / tax_category は無い）。行が無ければ LINE_NOT_FOUND。
    const current = await this.database.query(
      "SELECT row_to_json(cl) AS line FROM condition_lines cl WHERE cl.id = $1", [id]);
    if (!current.rows[0]) throw new ConditionRepairError(`条件明細 ${id} が見つかりません`, "LINE_NOT_FOUND");
    const existingColumns = new Set(Object.keys(current.rows[0].line ?? {}));
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(UPDATABLE_COLUMNS) as Array<[keyof typeof UPDATABLE_COLUMNS, string]>) {
      if (patch[key] === undefined) continue;
      if (!existingColumns.has(column)) continue;
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
      if (key === "documentId" && existingColumns.has("capability_id")) sets.push(`capability_id = $${values.length}`);
    }
    if (patch.regions !== undefined && existingColumns.has("region_territory")) {
      values.push(patch.regions.map((r) => r.name).join("・") || null);
      sets.push(`region_territory = $${values.length}`);
    }
    if (patch.languages !== undefined && existingColumns.has("region_language")) {
      values.push(patch.languages.map((l) => l.name).join("・") || null);
      sets.push(`region_language = $${values.length}`);
    }
    if (patch.workId !== undefined && patch.workId !== null) {
      const work = await this.database.query("SELECT id FROM works WHERE id = $1", [patch.workId]);
      if (!work.rows[0]) throw new ConditionRepairError(`作品 ${patch.workId} が見つかりません`, "WORK_NOT_FOUND");
    }
    if (patch.documentId !== undefined && patch.documentId !== null) {
      const doc = await this.database.query("SELECT id FROM documents WHERE id = $1", [patch.documentId]);
      if (!doc.rows[0]) throw new ConditionRepairError(`文書 ${patch.documentId} が見つかりません`, "DOCUMENT_NOT_FOUND");
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE condition_lines SET ${[...sets, "updated_at = now()"].join(", ")} WHERE id = $1 RETURNING id`,
        values
      );
      if (!updated.rows[0]) throw new ConditionRepairError(`条件明細 ${id} が見つかりません`, "LINE_NOT_FOUND");
      for (const [table, prefix, items] of [
        ["condition_line_regions", "country", patch.regions],
        ["condition_line_languages", "language", patch.languages]
      ] as Array<[string, string, ConditionLineUpdate["regions"]]>) {
        if (items === undefined) continue;
        await client.query(`DELETE FROM ${table} WHERE condition_line_id = $1`, [id]);
        for (let i = 0; i < items.length; i += 1) {
          await client.query(
            `INSERT INTO ${table} (condition_line_id, ${prefix}_code, ${prefix}_name, sort_order) VALUES ($1, $2, $3, $4)`,
            [id, items[i].code, items[i].name, i]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { id };
  }

  // 相手方の後付け補修（guarded・grant 018 の列レベル UPDATE counterparty_vendor_id を再利用）。
  // 名前文字列ではなく取引先マスタIDのみを書く（表示は従来どおり vendors JOIN で解決）。
  async updateCounterparty(id: number, vendorId: number): Promise<{ id: number; vendorName: string }> {
    const vendor = await this.database.query(
      "SELECT vendor_name FROM vendors WHERE id = $1", [vendorId]);
    if (!vendor.rows[0]) {
      throw new ConditionRepairError(`取引先 ${vendorId} が見つかりません`, "VENDOR_NOT_FOUND");
    }
    const updated = await this.database.query(
      "UPDATE condition_lines SET counterparty_vendor_id = $2 WHERE id = $1 RETURNING id", [id, vendorId]);
    if (!updated.rows[0]) {
      throw new ConditionRepairError(`条件明細 ${id} が見つかりません`, "LINE_NOT_FOUND");
    }
    return { id, vendorName: String(vendor.rows[0].vendor_name ?? "") };
  }

  // Real settlement: planned installments vs non-voided events. Degrades to
  // null if the settlement tables are not readable (grant 011 not applied).
  private async consumption(id: number, currency: string | null): Promise<ConditionConsumption | null> {
    try {
      const [installments, events] = await Promise.all([
        this.database.query(
          `SELECT id, installment_no, trigger_kind, planned_amount_ex_tax, due_date
             FROM condition_line_installments
            WHERE condition_line_id = $1 ORDER BY installment_no`, [id]),
        this.database.query(
          `SELECT event_no, event_type, occurred_at, amount_ex_tax, period, document_id, installment_id
             FROM condition_events
            WHERE condition_line_id = $1 AND voided_at IS NULL
            ORDER BY occurred_at, event_no`, [id])
      ]);
      if (!installments.rows.length && !events.rows.length) return null;
      const settledInstallmentIds = new Set(
        events.rows.map((e) => (e.installment_id === null ? null : Number(e.installment_id))).filter((v) => v !== null)
      );
      const plannedTotal = installments.rows.reduce((sum, r) => sum + (num(r.planned_amount_ex_tax) ?? 0), 0);
      const consumedTotal = events.rows.reduce((sum, r) => sum + (num(r.amount_ex_tax) ?? 0), 0);
      const installmentList: ConditionInstallment[] = installments.rows.map((r) => ({
        installmentNo: Number(r.installment_no),
        triggerKind: String(r.trigger_kind ?? ""),
        plannedAmount: num(r.planned_amount_ex_tax) ?? 0,
        dueDate: r.due_date ? String(r.due_date).slice(0, 10) : null,
        settled: settledInstallmentIds.has(Number(r.id))
      }));
      return {
        currency,
        plannedTotal,
        consumedTotal,
        balance: plannedTotal - consumedTotal,
        inspectionRequired: installments.rows.some((r) => r.trigger_kind === "on_inspection"),
        inspectionDone: events.rows.some((e) => e.event_type === "inspection"),
        installments: installmentList,
        events: events.rows.map((r) => ({
          eventNo: Number(r.event_no),
          eventType: String(r.event_type ?? ""),
          occurredAt: r.occurred_at ? new Date(String(r.occurred_at)).toISOString() : null,
          amount: num(r.amount_ex_tax) ?? 0,
          period: r.period ?? null,
          documentId: r.document_id === null ? null : Number(r.document_id)
        }))
      };
    } catch (error) {
      // 42501 = insufficient privilege (grant 011 not yet applied) — degrade.
      if ((error as { code?: string })?.code === "42501") return null;
      throw error;
    }
  }

  async overlap(workId: number): Promise<ConditionOverlap> {
    const result = await this.database.query(
      `SELECT cl.id, cl.condition_name, cl.direction, cl.flow_direction,
              cl.source_material_id, wm.material_name,
              cl.amount_ex_tax, cl.mg_amount, cl.currency,
              d.document_number
         FROM condition_lines cl
         LEFT JOIN work_materials wm ON wm.id = cl.source_material_id
         LEFT JOIN documents d ON d.id = cl.document_id
        WHERE cl.work_id = $1
          AND (d.id IS NULL OR d.lifecycle_status IS NULL OR d.lifecycle_status <> 'voided')
        ORDER BY cl.direction NULLS LAST, cl.source_material_id NULLS FIRST, cl.id DESC
        LIMIT 200`,
      [workId]
    );
    const lines: ConditionOverlapLine[] = result.rows.map((row) => ({
      id: Number(row.id),
      conditionName: String(row.condition_name ?? ""),
      direction: row.direction ?? null,
      flowDirection: row.flow_direction ?? null,
      sourceMaterialId: row.source_material_id === null ? null : Number(row.source_material_id),
      materialName: row.material_name ?? null,
      amountExTax: num(row.amount_ex_tax),
      mgAmount: num(row.mg_amount),
      currency: row.currency ?? null,
      documentNumber: row.document_number ?? null
    }));
    return {
      workId,
      total: lines.length,
      receivableCount: lines.filter((line) => line.direction === "receivable").length,
      payableCount: lines.filter((line) => line.direction === "payable").length,
      lines
    };
  }
}

function legacyScopeNames(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text.split(/[,、/]/).map((item) => item.trim()).filter(Boolean) : [];
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row: Record<string, any>): ConditionLineRow {
  return {
    id: Number(row.id),
    lineNo: row.line_no === null ? null : Number(row.line_no),
    documentId: row.document_id === null ? null : Number(row.document_id),
    documentNumber: row.document_number ?? null,
    matterId: row.matter_id === null ? null : Number(row.matter_id),
    templateType: row.template_type ?? null,
    direction: row.direction ?? null,
    flowDirection: row.flow_direction ?? null,
    transactionKind: row.transaction_kind ?? null,
    conditionName: String(row.condition_name ?? ""),
    vendorName: String(row.vendor_name ?? ""),
    workTitle: String(row.work_title ?? ""),
    territory: row.region_territory ?? null,
    language: row.region_language ?? null,
    currency: row.currency ?? null,
    amountExTax: num(row.amount_ex_tax),
    mgAmount: num(row.mg_amount),
    ratePct: num(row.rate_pct),
    termStart: row.term_start ? String(row.term_start).slice(0, 10) : null,
    supersededBy: String(row.superseded_by ?? "").trim() || null,
    ledgerStatus: row.ledger_status === "draft" ? "draft" : row.ledger_status === "final" ? "final" : null,
    effective: String(row.lifecycle_status ?? "") !== "voided" && !String(row.superseded_by ?? "").trim()
      && row.ledger_status !== "draft"
  };
}

function mapSummary(row: Record<string, any>): ConditionLineSummaryRow {
  return {
    direction: String(row.direction ?? "unknown"),
    currency: String(row.currency ?? "JPY"),
    lineCount: Number(row.line_count ?? 0),
    totalAmount: num(row.total_amount) ?? 0,
    totalMg: num(row.total_mg) ?? 0
  };
}

export class MemoryConditionLineRepository implements ConditionLineRepository {
  constructor(
    private readonly rows: ConditionLineRow[] = [],
    private readonly overlapLines: (ConditionOverlapLine & { workId: number })[] = [],
    private readonly vendors: Map<number, string> = new Map()
  ) {}
  async list(query: string, limit = 300) {
    const keyword = query.trim().toLowerCase();
    return this.rows
      .filter((row) => !keyword || [row.conditionName, row.documentNumber, row.vendorName, row.workTitle, row.territory, row.language]
        .some((value) => value?.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }
  async summary() {
    const groups = new Map<string, ConditionLineSummaryRow>();
    for (const row of this.rows) {
      const direction = row.direction || "unknown";
      const currency = row.currency || "JPY";
      const key = `${direction}|${currency}`;
      const entry = groups.get(key) ?? { direction, currency, lineCount: 0, totalAmount: 0, totalMg: 0 };
      entry.lineCount += 1;
      entry.totalAmount += row.amountExTax ?? 0;
      entry.totalMg += row.mgAmount ?? 0;
      groups.set(key, entry);
    }
    return [...groups.values()].sort((a, b) =>
      a.direction.localeCompare(b.direction) || a.currency.localeCompare(b.currency));
  }
  async settlement() { return null; }
  async overlap(workId: number): Promise<ConditionOverlap> {
    const lines = this.overlapLines.filter((line) => line.workId === workId)
      .map(({ workId: _workId, ...line }) => line);
    return {
      workId,
      total: lines.length,
      receivableCount: lines.filter((line) => line.direction === "receivable").length,
      payableCount: lines.filter((line) => line.direction === "payable").length,
      lines
    };
  }
  async find(id: number) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    return {
      ...row, matterCode: null, matterTitle: null, exclusivity: null, sublicenseAllowed: null,
      paymentScheme: null, paymentTerms: null, royaltyBase: null, deductibleCosts: null,
      agAmount: null, notes: null, regions: [], languages: [], consumption: null,
      lineKind: null, taxCategory: null, materialCode: null, sourceMaterialId: null, sourceMaterialName: null,
      workId: null, termEnd: null, counterpartyVendorId: null, parentLicenseConditionId: null, groupNo: null, basePriceLabel: null
    };
  }
  async update(id: number, patch: ConditionLineUpdate): Promise<{ id: number }> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new ConditionRepairError(`条件明細 ${id} が見つかりません`, "LINE_NOT_FOUND");
    if (patch.conditionName !== undefined) row.conditionName = patch.conditionName;
    if (patch.currency !== undefined) row.currency = patch.currency;
    if (patch.amountExTax !== undefined) row.amountExTax = patch.amountExTax;
    if (patch.mgAmount !== undefined) row.mgAmount = patch.mgAmount;
    if (patch.ratePct !== undefined) row.ratePct = patch.ratePct;
    if (patch.termStart !== undefined) row.termStart = patch.termStart;
    if (patch.transactionKind !== undefined) row.transactionKind = patch.transactionKind;
    if (patch.documentId !== undefined) row.documentId = patch.documentId;
    if (patch.regions !== undefined) row.territory = patch.regions.map((r) => r.name).join("・") || null;
    if (patch.languages !== undefined) row.language = patch.languages.map((l) => l.name).join("・") || null;
    return { id };
  }
  async updateCounterparty(id: number, vendorId: number): Promise<{ id: number; vendorName: string }> {
    const vendorName = this.vendors.get(vendorId);
    if (vendorName === undefined) {
      throw new ConditionRepairError(`取引先 ${vendorId} が見つかりません`, "VENDOR_NOT_FOUND");
    }
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new ConditionRepairError(`条件明細 ${id} が見つかりません`, "LINE_NOT_FOUND");
    row.vendorName = vendorName;
    return { id, vendorName };
  }
}
