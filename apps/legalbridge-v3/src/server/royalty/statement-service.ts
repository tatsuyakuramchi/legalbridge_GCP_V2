import { dateStr, inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { calculateFee, type FeeResult } from "./calc.js";
import { computeRoyaltyPayment, resolveWithholdingEnabled, type PaymentBreakdown } from "./tax.js";
import {
  buildAdjustments, buildFeeTerms, ppmToPct, taxRateFor, toMajor, toMinor,
  type ConditionEconomics, type ReportedResult
} from "./economics.js";

export interface CalculationInput {
  conditionId: number;
  /** 対象期間。実績の束から出すときは省ける（実績の期間から導く）。 */
  period?: string | null;
  occurredOn?: string | null;
  eventType?: "manufacturing" | "sales" | "sublicense_receipt" | "service_period" | "adjustment";
  reported?: ReportedResult;
  /**
   * 実績の束。渡すと、選んだ実績の根拠（報告売上・数量）を合算して1回だけ
   * 計算し、実績は新しく作らず選んだものを計算書に結ぶ。渡さなければ
   * これまでどおり reported から計算し、確定時に実績を1件作る。
   */
  eventIds?: number[];
}

/** 計算書に載る実績1件。根拠（売上か数量）と、その比で按分した額。 */
export interface StatementBasis {
  eventId: number;
  eventType: string;
  occurredOn: string | null;
  period: string | null;
  /** 根拠。料率なら報告売上（最小通貨単位）、数量ベースなら数量。 */
  basis: number;
  quantity: number | null;
  sampleQuantity: number | null;
  salesInput: number | null;
  /** 根拠の比。合計で 1。 */
  share: number;
  note: string | null;
}

export interface CalculationPreview {
  condition: {
    id: number; conditionNo: string | null; currency: string; pricingModel: string;
    /** 束ねた計算書の行に出す見出し。 */
    name: string; kind: string; direction: string; counterpartyId: number | null;
    agreementTitle: string | null; agreementNo: string | null;
    /** 印字用の条件そのものの値（主単位・%）。 */
    ratePct: number; unitAmount: number; mgAmount: number; agAmount: number;
    taxRatePct: number;
  };
  /** エンジンの結果（主単位）。画面はこれをそのまま表示できる。 */
  fee: FeeResult;
  /** 支払側の内訳。源泉は相手先が個人なら自動で対象になる。 */
  payment: PaymentBreakdown & { withholdingEnabled: boolean };
  /** 保存するときの値（最小通貨単位）。 */
  amounts: { grossMinor: number; netMinor: number; taxMinor: number; agOffsetMinor: number; mgTopupMinor: number };
  agConsumedBefore: number;
  /**
   * 実際に計算に使った版。渡した条件と違うときは、契約変更の適用開始日を
   * またいでいる。画面はこれを出して、なぜその料率になったのかを見せる。
   */
  appliedVersion: {
    id: number; conditionNo: string | null; effectiveFrom: string | null; switched: boolean;
  } | null;
  /** 実際に計算に使った報告値と期間。実績の束から導いたときはここに入る。 */
  reported: ReportedResult;
  period: string;
  occurredOn: string | null;
  /** 実績の束から出したときの、実績ごとの根拠と按分。 */
  events: StatementBasis[];
}

/**
 * ロイヤリティの試算と確定。
 *
 * 計算そのものは移植したエンジン（calc / tax / fx）が持つ。ここは
 *   1. 条件と消化済みAGを読む
 *   2. 単位を合わせてエンジンを呼ぶ
 *   3. 確定時だけ、実績・計算書・明細・支払を1トランザクションで書く
 * だけを担う。フォームの値は信用せず、確定時に必ず計算し直す（V1・V2 と同じ防御）。
 */
/** 総額を比で割る。端数は最終行に寄せて、合計が総額と一致するようにする。 */
export function apportion(total: number, shares: number[]): number[] {
  if (!shares.length) return [];
  const out = shares.slice(0, -1).map((s) => Math.round(total * s));
  out.push(total - out.reduce((a, b) => a + b, 0));
  return out;
}

export class RoyaltyStatementService {
  constructor(private readonly database: Transactable) {}

  async preview(input: CalculationInput): Promise<CalculationPreview> {
    try {
      const resolved = await this.resolveInput(this.database, input);
      return await this.calculate(this.database, resolved.input, resolved.events);
    } catch (error) { throw translate(error); }
  }

  /**
   * 実績の束から報告値を導く。渡されていなければ reported をそのまま使う。
   *
   * 根拠は計算方式で決まる。料率（revenue_rate）なら報告売上（売上・再許諾の
   * 受領の gross_amount）、数量ベース（unit_rate）なら製造数・販売数。
   * 違う種類が混ざっていれば止める（合算できない）。
   */
  private async resolveInput(
    client: Queryable, input: CalculationInput
  ): Promise<{ input: CalculationInput & { period: string; reported: ReportedResult }; events: StatementBasis[] }> {
    const ids = [...new Set((input.eventIds ?? []).map((n) => Number(n)))].filter((n) => n > 0);
    if (!ids.length) {
      const period = String(input.period ?? "").trim();
      if (!period) throw new DomainError("VALIDATION", "対象期間を入れてください");
      return { input: { ...input, period, reported: input.reported ?? {} }, events: [] };
    }

    const condition = await this.loadCondition(client, input.conditionId);
    const r = await client.query(
      `SELECT e.id, e.condition_id, e.event_type, e.occurred_on, e.period, e.quantity,
              e.sample_quantity, e.gross_amount, e.amount, e.document_id, e.status, e.note,
              (c.series_id = (SELECT COALESCE(series_id, id) FROM conditions WHERE id = $2)
               OR c.id = $2) AS same_series
         FROM condition_events e JOIN conditions c ON c.id = e.condition_id
        WHERE e.id = ANY($1::bigint[])
        ORDER BY e.occurred_on, e.id`, [ids, input.conditionId]);
    const rows = r.rows as Array<Record<string, any>>;
    if (rows.length !== ids.length) {
      const known = new Set(rows.map((x) => Number(x.id)));
      throw new DomainError("NOT_FOUND", `実績が見つかりません：${ids.filter((i) => !known.has(i)).join(", ")}`);
    }
    for (const e of rows) {
      const tag = `実績 #${e.id}（${dateStr(e.occurred_on) ?? "日付なし"}）`;
      if (e.same_series !== true) throw new DomainError("VALIDATION", `${tag} はこの条件の実績ではありません`);
      if (e.status !== "active") throw new DomainError("CONFLICT", `${tag} は取り消されています`);
      if (e.document_id) throw new DomainError("CONFLICT", `${tag} はすでに別の文書に結ばれています`);
    }

    // 根拠の取り方。計算方式で決まる。
    const model = condition.pricingModel;
    const basisOf = (e: Record<string, any>): number => {
      const type = String(e.event_type);
      if (model === "revenue_rate") {
        if (type !== "sales" && type !== "sublicense_receipt") {
          throw new DomainError("VALIDATION",
            `料率の条件の計算書に載せられるのは 売上 と 再許諾の受領 の実績だけです（実績 #${e.id} は ${type}）`);
        }
        const gross = Number(e.gross_amount ?? e.amount ?? 0);
        if (!(gross > 0)) throw new DomainError("VALIDATION", `実績 #${e.id} に報告売上（額）が入っていません`);
        return gross;
      }
      if (model === "unit_rate") {
        if (type !== "manufacturing" && type !== "sales") {
          throw new DomainError("VALIDATION",
            `数量ベースの条件の計算書に載せられるのは 製造 と 売上 の実績だけです（実績 #${e.id} は ${type}）`);
        }
        const qty = Number(e.quantity ?? 0);
        if (!(qty > 0)) throw new DomainError("VALIDATION", `実績 #${e.id} に数量が入っていません`);
        return qty;
      }
      throw new DomainError("VALIDATION",
        `この計算方式（${model}）では実績から計算書を出せません。料率か単価×数量の条件だけです`);
    };
    const basis = rows.map(basisOf);
    const total = basis.reduce((a, b) => a + b, 0);
    const events: StatementBasis[] = rows.map((e, i) => ({
      eventId: Number(e.id), eventType: String(e.event_type),
      occurredOn: dateStr(e.occurred_on), period: e.period ? String(e.period) : null,
      basis: basis[i],
      quantity: e.quantity === null ? null : Number(e.quantity),
      sampleQuantity: e.sample_quantity === null ? null : Number(e.sample_quantity),
      salesInput: model === "revenue_rate" ? basis[i] : null,
      share: total > 0 ? basis[i] / total : 0,
      note: e.note ? String(e.note) : null
    }));

    const reported: ReportedResult = model === "revenue_rate"
      ? { salesInput: total }
      : { quantity: total,
          sampleQuantity: events.reduce((a, e) => a + (e.sampleQuantity ?? 0), 0) || null };
    // 期間は揃っていればそれ、揃っていなければ最古〜最新。発生日は最新。
    const periods = [...new Set(events.map((e) => e.period).filter(Boolean))];
    const dates = events.map((e) => e.occurredOn).filter(Boolean).sort();
    const period = String(input.period ?? "").trim()
      || (periods.length === 1 ? String(periods[0])
          : dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : "");
    if (!period) throw new DomainError("VALIDATION", "対象期間を入れてください（実績に期間も日付もありません）");
    return {
      input: { ...input, period, reported, occurredOn: input.occurredOn ?? dates[dates.length - 1] ?? null },
      events
    };
  }

  /**
   * 確定。実績イベントを1件立て、計算書と明細を作る。
   * documentId を渡すと発行済み文書に結びつける（計算書＝文書）。
   */
  async finalize(
    input: CalculationInput & { documentId: number },
    actor: string
  ): Promise<{ statementId: number; eventId: number; netMinor: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        await this.lockIssuedDocument(client, input.documentId);
        return await this.finalizeOne(client, input, actor);
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 複数の条件を1枚の計算書にまとめて確定する。
   *
   * 作品ひとつに取引モデルが何本もある（自社製造・自社販売、再許諾…）とき、
   * 相手先に出すのは1枚。条件ごとに1本ずつ紙を出すのは実務と合わない。
   * 計算は条件ごとに行い（料率も MG・AG も条件ごとに違う）、計算書の行も
   * 条件ごとに作る。1枚に束ねるのは印字と支払のまとめ方だけ。
   */
  async finalizeAll(
    inputs: Array<CalculationInput & { documentId: number }>,
    actor: string
  ): Promise<Array<{ conditionId: number; statementId: number; eventId: number; netMinor: number }>> {
    if (!inputs.length) throw new DomainError("VALIDATION", "条件を1件以上選んでください");
    const documentIds = [...new Set(inputs.map((i) => i.documentId))];
    if (documentIds.length !== 1) {
      throw new DomainError("VALIDATION", "1枚の文書にまとめてください");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        await this.lockIssuedDocument(client, documentIds[0]);
        const out = [];
        for (const input of inputs) {
          out.push({ conditionId: input.conditionId, ...await this.finalizeOne(client, input, actor) });
        }
        return out;
      });
    } catch (error) { throw translate(error); }
  }

  private async lockIssuedDocument(client: Queryable, documentId: number): Promise<void> {
    const document = await client.query(
      "SELECT id, status FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
    const documentRow = document.rows[0] as { status?: string } | undefined;
    if (!documentRow) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
    if (documentRow.status !== "issued") {
      throw new DomainError("CONFLICT", "発行済みの文書にだけ計算書を結び付けられます");
    }
  }

  /** 条件1本ぶんの確定。呼ぶ側がトランザクションと文書の錠を持つ。 */
  private async finalizeOne(
    client: Queryable,
    input: CalculationInput & { documentId: number },
    actor: string
  ): Promise<{ statementId: number; eventId: number; netMinor: number }> {
    // 画面から来た金額は使わず、ここで計算し直す。
    const resolved = await this.resolveInput(client, input);
    const calcInput = resolved.input;
    const result = await this.calculate(client, calcInput, resolved.events);
    // 実績と計算書は、実際に計算に使った版にぶら下げる。渡された版に
    // 付けると、料率と実績の版が食い違って後から検算できない。
    const conditionId = result.appliedVersion?.id ?? input.conditionId;

    // 同じ条件の計算書を1枚の文書に二重に作らない。条件が違えば作ってよい
    // （束ねた計算書は条件ごとに1行ずつ持つ）。
    const already = await client.query(
      "SELECT id FROM statements WHERE document_id = $1 AND condition_id = $2",
      [input.documentId, conditionId]);
    if (already.rows[0]) {
      throw new DomainError("CONFLICT",
        `この文書には条件 ${result.condition.conditionNo ?? conditionId} の計算書がすでにあります`);
    }

    const statement = await client.query(
      `INSERT INTO statements
         (document_id, condition_id, period, currency, gross_amount, mg_topup, ag_offset,
          net_amount, tax_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [input.documentId, conditionId, calcInput.period, result.condition.currency,
       result.amounts.grossMinor, result.amounts.mgTopupMinor, result.amounts.agOffsetMinor,
       result.amounts.netMinor, result.amounts.taxMinor]
    );
    const statementId = Number((statement.rows[0] as { id: number }).id);

    let eventId: number;
    if (resolved.events.length) {
      // 実績の束。新しい実績は作らず、選んだ実績を計算書と文書に結ぶ。
      // 明細は実績1件が1行。額は根拠の比で按分し、端数は最終行に寄せる
      // （MG の上乗せ・AG の相殺は明細に割らず、合計欄だけに出る）。
      const net = result.amounts.netMinor;
      const shares = apportion(net, resolved.events.map((e) => e.share));
      for (const [i, e] of resolved.events.entries()) {
        await client.query(
          `INSERT INTO statement_lines
             (statement_id, line_no, condition_id, event_id, quantity, sample_quantity,
              unit_amount, rate_ppm, sales_input, fx_rate, amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [statementId, i + 1, conditionId, e.eventId, e.quantity, e.sampleQuantity,
           null, null, e.salesInput, null, shares[i]]);
      }
      // AG の消化は deductions 列で数える（agConsumedBefore が SUM する列）。
      // 実績を新しく立てる道では入れているのに、束ねる道では入れていなかった。
      // そのため前払保証がいつまでも消化されず、次の計算書でも同じ額が
      // もう一度相殺されて、実額が出ないままになる。ここでも積む。
      const offsets = apportion(result.amounts.agOffsetMinor,
                                resolved.events.map((e) => e.share));
      for (const [i, e] of resolved.events.entries()) {
        await client.query(
          `UPDATE condition_events SET document_id = $2, deductions = $3
            WHERE id = $1 AND document_id IS NULL`,
          [e.eventId, input.documentId, offsets[i]]);
      }
      eventId = resolved.events[0].eventId;
    } else {
      // 実績を渡されていない（試算からの近道）。実績を1件立てて結ぶ。
      const event = await client.query(
        `INSERT INTO condition_events
           (condition_id, event_type, occurred_on, period, quantity, sample_quantity,
            gross_amount, deductions, amount, document_id, created_by)
         VALUES ($1, $2, COALESCE($3::date, current_date), $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [conditionId, input.eventType ?? "sales", calcInput.occurredOn ?? null, calcInput.period,
         calcInput.reported.quantity ?? null, calcInput.reported.sampleQuantity ?? null,
         result.amounts.grossMinor, result.amounts.agOffsetMinor, result.amounts.netMinor,
         input.documentId, actor]
      );
      eventId = Number((event.rows[0] as { id: number }).id);
      await client.query(
        `INSERT INTO statement_lines
           (statement_id, line_no, condition_id, event_id, quantity, sample_quantity,
            unit_amount, rate_ppm, sales_input, fx_rate, amount)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [statementId, conditionId, eventId,
         calcInput.reported.quantity ?? null, calcInput.reported.sampleQuantity ?? null,
         null, null, calcInput.reported.salesInput ?? null, calcInput.reported.fxRate ?? null,
         result.amounts.netMinor]
      );
    }

    await recordAudit(client, {
      actor, action: "royalty.finalize", targetType: "statement", targetId: statementId,
      detail: {
        conditionId, requestedConditionId: input.conditionId,
        appliedVersion: result.appliedVersion,
        documentId: input.documentId, period: calcInput.period,
        eventIds: resolved.events.map((e) => e.eventId),
        gross: result.amounts.grossMinor, net: result.amounts.netMinor,
        agOffset: result.amounts.agOffsetMinor, mgTopup: result.amounts.mgTopupMinor,
        formula: result.fee.formula_breakdown
      }
    });

    return { statementId, eventId, netMinor: result.amounts.netMinor };
  }

  /** 計算書の一覧。文書と条件を添えて返す。 */
  async list(query: { conditionId?: number; limit?: number } = {}) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.conditionId) { params.push(query.conditionId); where.push(`s.condition_id = $${params.length}`); }
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `SELECT s.id, s.period, s.currency, s.gross_amount, s.mg_topup, s.ag_offset,
                s.net_amount, s.tax_amount,
                d.id AS document_id, d.document_no, c.condition_no, c.name AS condition_name,
                p.name AS counterparty
           FROM statements s
           JOIN documents d  ON d.id = s.document_id
           JOIN conditions c ON c.id = s.condition_id
           LEFT JOIN parties p ON p.id = c.counterparty_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY s.id DESC
          LIMIT $${params.length}`, params);
      return r.rows.map((row: Record<string, any>) => ({
        id: Number(row.id),
        period: String(row.period),
        currency: String(row.currency),
        grossAmount: Number(row.gross_amount),
        mgTopup: Number(row.mg_topup),
        agOffset: Number(row.ag_offset),
        netAmount: Number(row.net_amount),
        taxAmount: Number(row.tax_amount),
        documentId: Number(row.document_id),
        documentNo: row.document_no ? String(row.document_no) : null,
        conditionNo: row.condition_no ? String(row.condition_no) : null,
        conditionName: String(row.condition_name),
        counterparty: row.counterparty ? String(row.counterparty) : null
      }));
    } catch (error) { throw translate(error); }
  }

  private async calculate(
    client: Queryable, input: CalculationInput & { period: string; reported: ReportedResult },
    events: StatementBasis[] = []
  ): Promise<CalculationPreview> {
    const resolved = await this.resolveVersion(client, input.conditionId, input.occurredOn ?? null);
    // 対象日に効いていた版で計算する。渡された版とずれたら、黙って差し替えずに
    // 結果へ載せる（なぜその料率になったのかが画面から読めないと検算できない）。
    const usedId = resolved?.id ?? input.conditionId;
    const condition = await this.loadCondition(client, usedId);
    const agConsumedBefore = await this.agConsumedBefore(client, usedId);

    const terms = buildFeeTerms(condition, input.reported);
    const adjustments = buildAdjustments(condition, input.reported, agConsumedBefore);
    const fee = calculateFee(terms, adjustments, taxRateFor(condition));

    const withholdingEnabled = resolveWithholdingEnabled({
      vendorWithholdingEnabled: condition.counterpartyWithholding,
      entityType: condition.counterpartyKind
    });
    const payment = computeRoyaltyPayment({
      subtotalExTax: fee.actual_ex_tax,
      taxRatePct: taxRateFor(condition),
      withholdingEnabled
    });

    const currency = condition.currency;
    return {
      condition: {
        id: condition.id, conditionNo: condition.conditionNo,
        currency, pricingModel: condition.pricingModel,
        name: condition.name, kind: condition.kind, direction: condition.direction,
        counterpartyId: condition.counterpartyId,
        agreementTitle: condition.agreementTitle, agreementNo: condition.agreementNo,
        ratePct: ppmToPct(condition.ratePpm),
        unitAmount: toMajor(condition.unitAmount, currency),
        mgAmount: toMajor(condition.mgAmount, currency),
        agAmount: toMajor(condition.agAmount, currency),
        taxRatePct: taxRateFor(condition)
      },
      fee,
      payment: { ...payment, withholdingEnabled },
      amounts: {
        grossMinor: toMinor(fee.gross_ex_tax, currency),
        netMinor: toMinor(fee.actual_ex_tax, currency),
        taxMinor: toMinor(fee.tax_amount, currency),
        agOffsetMinor: toMinor(fee.ag_offset_this_time, currency),
        mgTopupMinor: toMinor(fee.mg_topup_this_time, currency)
      },
      agConsumedBefore,
      appliedVersion: resolved
        ? { ...resolved, switched: resolved.id !== input.conditionId }
        : null,
      reported: input.reported,
      period: input.period,
      occurredOn: input.occurredOn ?? null,
      events
    };
  }

  private async loadCondition(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.name, c.kind, c.direction, c.currency, c.pricing_model,
              c.counterparty_id,
              c.rate_ppm, c.unit_amount, c.flat_amount, c.mg_amount, c.ag_amount,
              c.tax_category, c.status,
              a.title AS agreement_title, a.agreement_no,
              p.withholding, p.kind AS party_kind
         FROM conditions c
         LEFT JOIN parties p ON p.id = c.counterparty_id
         LEFT JOIN agreements a ON a.id = c.agreement_id
        WHERE c.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
    if (row.status === "void" || row.status === "superseded") {
      throw new DomainError("CONFLICT", "無効または旧版の条件では計算できません");
    }
    return {
      id: Number(row.id),
      conditionNo: row.condition_no ? String(row.condition_no) : null,
      currency: String(row.currency ?? "JPY"),
      pricingModel: String(row.pricing_model) as ConditionEconomics["pricingModel"],
      ratePpm: row.rate_ppm === null ? null : Number(row.rate_ppm),
      unitAmount: row.unit_amount === null ? null : Number(row.unit_amount),
      flatAmount: row.flat_amount === null ? null : Number(row.flat_amount),
      mgAmount: row.mg_amount === null ? null : Number(row.mg_amount),
      agAmount: row.ag_amount === null ? null : Number(row.ag_amount),
      taxCategory: String(row.tax_category ?? "taxable") as ConditionEconomics["taxCategory"],
      counterpartyWithholding: row.withholding === true,
      counterpartyKind: row.party_kind ? String(row.party_kind) : null,
      // 束ねた計算書の1行に印字する。条件名・契約名・契約番号が無いと、
      // 何本もの取引モデルが並んだときにどの行が何の分か読めない。
      name: String(row.name ?? ""),
      kind: String(row.kind ?? ""),
      counterpartyId: row.counterparty_id === null ? null : Number(row.counterparty_id),
      direction: String(row.direction ?? "out"),
      agreementTitle: row.agreement_title ? String(row.agreement_title) : null,
      agreementNo: row.agreement_no ? String(row.agreement_no) : null
    };
  }

  /**
   * これまでに消化した AG の累計（最小通貨単位）。
   *
   * 1版ではなく改訂の系列で数える。契約変更で条件を改訂すると新しい行に
   * なるが、前払保証はその契約に対して1本なので、版が変わっても消化は
   * 引き継ぐ。版ごとに数えると、改訂のたびに残高が満額に戻り、次の計算書が
   * 消化済みの分をもう一度相殺してしまう。
   *
   * void のイベントは数えない。deductions 列に AG 相殺分を積んでいる。
   */
  private async agConsumedBefore(client: Queryable, conditionId: number): Promise<number> {
    const r = await client.query(
      `SELECT COALESCE(SUM(e.deductions), 0)::bigint AS consumed
         FROM condition_events e
         JOIN conditions c ON c.id = e.condition_id
        WHERE c.series_id = (SELECT series_id FROM conditions WHERE id = $1)
          AND e.status = 'active'`, [conditionId]);
    return Number((r.rows[0] as { consumed: string | number }).consumed ?? 0);
  }

  /**
   * 対象日に効いていた版を選ぶ。
   *
   * 契約変更の適用開始日より前の期間を後から計算するとき、いまの版で計算すると
   * 料率が違う。逆に、適用開始日が未来の予約版でも、その日以降の期間なら
   * そちらで計算する必要がある。だから status ではなく日付で決める。
   *
   * 対象日は発生日。入っていなければ今日として扱う。
   */
  private async resolveVersion(
    client: Queryable, conditionId: number, asOf: string | null
  ): Promise<{ id: number; conditionNo: string | null; effectiveFrom: string | null } | null> {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.effective_from
         FROM conditions c
        WHERE c.series_id = (SELECT series_id FROM conditions WHERE id = $1)
          AND c.status IN ('active', 'scheduled', 'superseded')
          AND (c.effective_from IS NULL OR c.effective_from <= COALESCE($2::date, current_date))
        ORDER BY c.effective_from DESC NULLS LAST, c.id DESC
        LIMIT 1`, [conditionId, asOf]);
    const row = r.rows[0] as
      { id: number; condition_no: string | null; effective_from: unknown } | undefined;
    if (!row) return null;
    return {
      id: Number(row.id), conditionNo: row.condition_no ? String(row.condition_no) : null,
      effectiveFrom: dateStr(row.effective_from)
    };
  }
}
