import { dateStr, int, inTransaction, str, type Queryable, type Transactable } from "../core/db.js";
import { CHILD_TITLES_SQL, statementProductName, eventScopeLabel } from "./product-name.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { calculateFee, type FeeResult } from "./calc.js";
import { computeRoyaltyPayment, resolveWithholdingEnabled, withholdingPartyOf, type PaymentBreakdown } from "./tax.js";
import {
  buildAdjustments, buildFeeTerms, ppmToPct, taxRateFor, toMajor, toMinor,
  type ConditionEconomics, type ReportedResult
} from "./economics.js";
import {
  basisNoteOf, basisOf, methodLabelOf, usageTypeSpec,
  type PaymentStage, type UsageType
} from "./usage-type.js";
import { floorRoyalty, roundRoyalty, taxOf } from "./rounding.js";

/** 出版（紙・電子）の条件か。印税は実績ごとに切り捨てる（rounding.ts）。 */
const isPublishingUsage = (usage: string | null | undefined) => usage === "pub_print" || usage === "pub_digital";
import { allocateShares, loadDistribution, loadShares, pickShare, type ConditionShareRow } from "./shares.js";

export interface CalculationInput {
  conditionId: number;
  /** 対象期間。実績の束から出すときは省ける（実績の期間から導く）。 */
  period?: string | null;
  occurredOn?: string | null;
  eventType?: "manufacturing" | "sales" | "sublicense_receipt" | "service_period" | "adjustment";
  reported?: ReportedResult;
  /**
   * 実績の束。利用形態のある実績は行ごとに算定する。無ければ、
   * 選んだ実績の根拠（報告売上・数量）を合算して1回だけ
   * 計算し、実績は新しく作らず選んだものを計算書に結ぶ。渡さなければ
   * これまでどおり reported から計算し、確定時に実績を1件作る。
   */
  eventIds?: number[];
  /**
   * 訂正版を出すとき、退かせる元の文書（と、発行の瞬間に移った先の新しい文書）。
   * その文書に結ばれた実績は「空いている」ものとして扱う。
   */
  freeDocumentId?: number | null;
  /** 複数の計算書を退かせて 1 枚にするとき。 */
  freeDocumentIds?: number[] | null;
  /**
   * 共著の取り分（A-068）。条件に取り分があるとき、この計算書が誰の分か。
   * 試算では省ける（全体の額と取り分ごとの内訳を返す）。確定では必須。
   */
  payeePartyId?: number | null;
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
  /** 権利の使い方。付いていれば、これで算定の形が決まる。 */
  usageType?: string | null;
  usageLabel?: string | null;
  /** 紙に出す方式名。 */
  methodLabel?: string | null;
  /** どう出した数字かの一行（「120個 × 基準価格」など）。 */
  basisNote?: string | null;
  /** 入金区分（前金・後金）。 */
  paymentStage?: string | null;
  /** 相手へ許諾したアウト条件。再許諾・他社販売のとき。 */
  outConditionId?: number | null;
  outConditionNo?: string | null;
  outConditionName?: string | null;
  /** 許諾先の取引先名。紙の「対象契約」と「入金企業」に出す。 */
  outPartyName?: string | null;
  /** アウト条件の通貨。相手から入ってきた通貨。紙の「入金通貨」に出す。 */
  outCurrency?: string | null;
  /** 許諾地域・言語など。紙に「従前に決めた内容」として出す。 */
  outScopes?: string | null;
  /** その報告の言語だけ（「英語・フランス語」）。経理提出用の支払内容に出す。 */
  outLanguages?: string | null;
  /** 製品名。作品名を出す。 */
  productName?: string | null;
  /** 基準価格／受領単価（最小通貨単位）。 */
  unitAmount?: number | null;
  /** その行に効いた料率（%）。 */
  ratePct?: number | null;
  /** その行の許諾料（税抜・最小通貨単位）。 */
  amount?: number | null;
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
  /**
   * 共著の取り分（A-068）。条件に取り分があるときだけ入る。受取人ごとの税抜実額
   * （全体を取り分で割ったもの）。受取人を選んで試算したときは、fee・payment・
   * amounts・events がその受取人の額になり、whole に割る前の全体が入る。
   */
  shares: Array<{ partyId: number; name: string; kind: string | null; sharePpm: number; netMinor: number }> | null;
  payee: { partyId: number; name: string; sharePpm: number } | null;
  whole: { grossMinor: number; netMinor: number } | null;
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

/**
 * 行ごとに出した額を、合計に合わせる。
 *
 * 行の額は行ごとの料率で出ているので按分しない。MG の上乗せ・AG の相殺が
 * 効くと合計だけがずれるので、その差を最終行に寄せる。差が無ければ何もしない。
 */
export function settleToTotal(amounts: number[], total: number): number[] {
  if (!amounts.length) return [];
  const out = amounts.slice();
  const sum = out.reduce((a, b) => a + b, 0);
  out[out.length - 1] += total - sum;
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
              e.usage_type, e.out_condition_id, e.unit_amount, e.payment_stage, e.tax_included,
              e.scope_languages, e.scope_regions,
              COALESCE(e.rate_ppm, c.rate_ppm) AS rate_ppm,
              oc.condition_no AS out_condition_no, oc.name AS out_condition_name,
              oa.agreement_no AS out_agreement_no,
              op.name AS out_party_name, oc.currency AS out_currency,
              -- 製品名は利用形態で決める（product-name.ts）。ここは材料だけ引く。
              w.title AS in_work_title, w.kind AS in_work_kind, ow.title AS out_work_title,
              ew.title AS event_work_title, c.usage_type AS in_usage_type,
              ${CHILD_TITLES_SQL("c.work_id")} AS child_titles,
              -- 許諾地域・言語など。従前に決めた内容をそのまま紙に出す。
              (SELECT string_agg(sc.label, '・' ORDER BY sc.scope_type, sc.sort_order, sc.label)
                 FROM condition_scopes sc WHERE sc.condition_id = oc.id) AS out_scopes,
              (c.series_id = (SELECT COALESCE(series_id, id) FROM conditions WHERE id = $2)
               OR c.id = $2) AS same_series
         FROM condition_events e JOIN conditions c ON c.id = e.condition_id
         LEFT JOIN conditions oc ON oc.id = e.out_condition_id
         LEFT JOIN agreements oa ON oa.id = oc.agreement_id
         LEFT JOIN parties op ON op.id = oc.counterparty_id
         LEFT JOIN works w ON w.id = c.work_id
         LEFT JOIN works ow ON ow.id = oc.work_id
         LEFT JOIN works ew ON ew.id = e.work_id
        WHERE e.id = ANY($1::bigint[])
        ORDER BY e.occurred_on, e.id`, [ids, input.conditionId]);
    const rows = r.rows as Array<Record<string, any>>;
    if (rows.length !== ids.length) {
      const known = new Set(rows.map((x) => Number(x.id)));
      throw new DomainError("NOT_FOUND", `実績が見つかりません：${ids.filter((i) => !known.has(i)).join(", ")}`);
    }
    const free = new Set<number>([...(input.freeDocumentIds ?? []), ...(input.freeDocumentId ? [input.freeDocumentId] : [])]);
    if (input.payeePartyId) {
      // 共著の取り分（A-068）。同じ実績から受取人ごとに計算書を出すので、ほかの
      // 受取人の計算書に結ばれた実績は「空いている」。同じ受取人にはもう出さない。
      const siblings = await client.query(
        `SELECT DISTINCT s.document_id, s.payee_party_id
           FROM statements s
           JOIN statement_lines l ON l.statement_id = s.id
           JOIN documents d ON d.id = s.document_id
          WHERE l.event_id = ANY($1::bigint[]) AND s.payee_party_id IS NOT NULL AND d.status = 'issued'`,
        [ids]);
      for (const row of siblings.rows as Array<{ document_id: number; payee_party_id: number }>) {
        const documentId = Number(row.document_id);
        if (Number(row.payee_party_id) === Number(input.payeePartyId)) {
          if (!free.has(documentId)) {
            throw new DomainError("CONFLICT", `この受取人の計算書はすでにあります（文書 #${documentId}）。訂正するならその文書から`);
          }
        } else {
          free.add(documentId);
        }
      }
    }
    for (const e of rows) {
      const tag = `実績 #${e.id}（${dateStr(e.occurred_on) ?? "日付なし"}）`;
      if (e.same_series !== true) throw new DomainError("VALIDATION", `${tag} はこの条件の実績ではありません`);
      if (e.status !== "active") throw new DomainError("CONFLICT", `${tag} は取り消されています`);
      if (e.document_id && !free.has(Number(e.document_id))) {
        throw new DomainError("CONFLICT", `${tag} はすでに別の文書に結ばれています`);
      }
    }

    // 利用形態が付いている実績は、その形で算定する。
    // 権利の使い方（自社製造・再許諾・他社販売）で要る数字が違い、
    // 料率も回ごとに違いうるので、条件1本の計算方式では決められない。
    if (rows.some((e) => e.usage_type)) {
      return this.resolveByUsage(rows, condition, input);
    }

    // 利用形態の無い実績（この仕組みより前に入れたもの）は、これまでどおり
    // 条件の計算方式で決める。
    const model = condition.pricingModel;
    // 出版（紙・電子）の料率条件は、実績（事業部の Excel の行＝報告月 × 書店 × タイトル）
    // ごとに 売上 × 料率 を切り捨てて足す。合計に料率を掛けて 1 回丸めると Excel と 1 円ずれる。
    const perEvent = model === "revenue_rate" && isPublishingUsage(condition.usageType);
    const conditionRatePct = ppmToPct(condition.ratePpm);
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
      note: e.note ? String(e.note) : null,
      unitAmount: int(e.unit_amount),
      // 製品名（出版なら「2026年3月 作品名」）。明細の行と紙の行に出す。
      productName: statementProductName({
        usageType: null, outConditionName: str(e.out_condition_name), outWorkTitle: str(e.out_work_title),
        inWorkTitle: str(e.in_work_title), inWorkKind: str(e.in_work_kind),
        childTitles: Array.isArray(e.child_titles) ? e.child_titles : null,
        eventWorkTitle: str(e.event_work_title),
        eventScope: eventScopeLabel(e.scope_languages, e.scope_regions),
        inUsageType: str(e.in_usage_type), period: str(e.period)
      }) || null,
      ...(perEvent ? { ratePct: conditionRatePct, amount: floorRoyalty((basis[i] * conditionRatePct) / 100) } : {})
    }));

    const reported: ReportedResult = model === "revenue_rate"
      ? { salesInput: total,
          ...(perEvent ? { grossOverrideMinor: events.reduce((a, e) => a + (e.amount ?? 0), 0) } : {}) }
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
   * 利用形態の付いた実績から、行ごとに算定する。
   *
   * 条件1本を1回だけ計算して比で按分する、という従来のやり方は使えない。
   * 料率が回ごとに違いうるからで、按分すると「この行の料率は何%か」が
   * 紙と合わなくなる。行ごとに 基礎 × 料率 を出し、足したものを合計にする。
   * MG・AG は条件のものなので、合計にだけ効かせる（行には割らない）。
   */
  private resolveByUsage(
    rows: Array<Record<string, any>>,
    condition: ConditionEconomics,
    input: CalculationInput
  ): { input: CalculationInput & { period: string; reported: ReportedResult }; events: StatementBasis[] } {
    const missing = rows.filter((e) => !e.usage_type);
    if (missing.length) {
      throw new DomainError("VALIDATION",
        `利用形態の入っていない実績が混ざっています（#${missing.map((e) => e.id).join("・")}）。` +
        "同じ計算書に、形の分かる実績と分からない実績は載せられません");
    }

    const events: StatementBasis[] = rows.map((e) => {
      const tag = `実績 #${e.id}`;
      const usageType = String(e.usage_type) as UsageType;
      const spec = usageTypeSpec(usageType);
      if (!spec) throw new DomainError("VALIDATION", `${tag}：利用形態が分かりません（${e.usage_type}）`);
      const quantity = e.quantity === null ? null : Number(e.quantity);
      const sampleQuantity = e.sample_quantity === null ? null : Number(e.sample_quantity);
      const shape = {
        usageType,
        unitAmount: int(e.unit_amount),
        quantity, sampleQuantity,
        grossAmount: int(e.gross_amount),
        paymentStage: (str(e.payment_stage) ?? null) as PaymentStage | null,
        taxIncluded: e.tax_included === null || e.tax_included === undefined
          ? null : Boolean(e.tax_included)
      };
      const basis = basisOf(shape, tag);
      const ratePct = ppmToPct(int(e.rate_ppm));
      if (!(ratePct > 0)) {
        throw new DomainError("VALIDATION",
          `${tag}：料率が入っていません。イン条件か実績に料率を入れてください`);
      }
      const amount = roundRoyalty((basis * ratePct) / 100);
      return {
        eventId: Number(e.id), eventType: String(e.event_type),
        occurredOn: dateStr(e.occurred_on), period: e.period ? String(e.period) : null,
        basis, quantity, sampleQuantity,
        salesInput: usageType === "sublicense" ? basis : null,
        share: 0,
        note: e.note ? String(e.note) : null,
        usageType, usageLabel: spec.label,
        // 前金・後金は方式名で分ける。同じ方式の行が2本並ぶと、
        // 受け取った側はどちらの入金か読めない（数量も二重に見える）。
        methodLabel: methodLabelOf(shape),
        paymentStage: shape.paymentStage,
        basisNote: basisNoteOf(shape),
        outConditionId: int(e.out_condition_id),
        outConditionNo: str(e.out_condition_no),
        outAgreementNo: str(e.out_agreement_no),
        outConditionName: str(e.out_condition_name),
        outPartyName: str(e.out_party_name),
        outCurrency: str(e.out_currency),
        // 実績が言語・地域を持っていれば、その報告の範囲を紙に出す（許諾先の範囲全体ではなく）。
        outScopes: eventScopeLabel(e.scope_languages, e.scope_regions) ?? str(e.out_scopes),
        outLanguages: eventScopeLabel(e.scope_languages, []),
        productName: statementProductName({
          usageType, outConditionName: str(e.out_condition_name), outWorkTitle: str(e.out_work_title),
          inWorkTitle: str(e.in_work_title), inWorkKind: str(e.in_work_kind),
          childTitles: Array.isArray(e.child_titles) ? e.child_titles : null,
          eventWorkTitle: str(e.event_work_title),
          eventScope: eventScopeLabel(e.scope_languages, e.scope_regions),
          inUsageType: str(e.in_usage_type), period: str(e.period)
        }) || null,
        unitAmount: int(e.unit_amount),
        ratePct,
        amount
      };
    });

    const total = events.reduce((sum, e) => sum + e.basis, 0);
    for (const e of events) e.share = total > 0 ? e.basis / total : 0;

    // 期間は揃っていればそれ、揃っていなければ最古〜最新。発生日は最新。
    const periods = [...new Set(events.map((e) => e.period).filter(Boolean))];
    const dates = events.map((e) => e.occurredOn).filter(Boolean).sort() as string[];
    const period = String(input.period ?? "").trim()
      || (periods.length === 1 ? String(periods[0])
          : dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : "");
    if (!period) {
      throw new DomainError("VALIDATION", "対象期間を入れてください（実績に期間も日付もありません）");
    }

    // 行ごとに出した許諾料の合計を、そのまま算定の基礎として渡す。
    // 料率は 100% にして、合計に MG・AG と税だけを効かせる（行で掛け済み）。
    const gross = events.reduce((sum, e) => sum + (e.amount ?? 0), 0);
    return {
      input: {
        ...input, period,
        occurredOn: input.occurredOn ?? dates[dates.length - 1] ?? null,
        reported: { salesInput: gross, ratePctOverride: 100,
                    intakeCurrency: condition.currency }
      },
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
    // 取り分のある条件は受取人が要る（試算は全体でも出せるが、確定は誰の分かを決める）。
    const result = await this.calculate(client, calcInput, resolved.events, { requirePayee: true });
    // 受取人の計算書なら、明細の額も取り分で割ったものになっている。
    const events = result.events;
    const payee = result.payee;
    // 実績と計算書は、実際に計算に使った版にぶら下げる。渡された版に
    // 付けると、料率と実績の版が食い違って後から検算できない。
    const conditionId = result.appliedVersion?.id ?? input.conditionId;

    // 同じ条件の計算書を1枚の文書に二重に作らない。条件が違えば作ってよい
    // （束ねた計算書は条件ごとに1行ずつ持つ）。
    const already = await client.query(
      `SELECT id FROM statements WHERE document_id = $1 AND condition_id = $2
         AND COALESCE(payee_party_id, 0) = COALESCE($3::bigint, 0)`,
      [input.documentId, conditionId, payee?.partyId ?? null]);
    if (already.rows[0]) {
      throw new DomainError("CONFLICT",
        `この文書には条件 ${result.condition.conditionNo ?? conditionId} の計算書がすでにあります`);
    }

    const statement = await client.query(
      `INSERT INTO statements
         (document_id, condition_id, period, currency, gross_amount, mg_topup, ag_offset,
          net_amount, tax_amount, payee_party_id, share_ppm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [input.documentId, conditionId, calcInput.period, result.condition.currency,
       result.amounts.grossMinor, result.amounts.mgTopupMinor, result.amounts.agOffsetMinor,
       result.amounts.netMinor, result.amounts.taxMinor,
       payee?.partyId ?? null, payee?.sharePpm ?? null]
    );
    const statementId = Number((statement.rows[0] as { id: number }).id);

    let eventId: number;
    if (events.length) {
      // 実績の束。新しい実績は作らず、選んだ実績を計算書と文書に結ぶ。
      // 明細は実績1件が1行。利用形態があれば行ごとの額、無ければ根拠の比で按分し、端数は最終行に寄せる
      // （MG の上乗せ・AG の相殺は明細に割らず、合計欄だけに出る）。
      const net = result.amounts.netMinor;
      // 利用形態の付いた実績は、行ごとに料率まで掛けて額が出ている。按分しない
      // （按分すると「この行の料率は何%か」が紙と合わなくなる）。MG・AG が
      // 効いたぶんだけ合計がずれるので、そのぶんを最終行に寄せる。
      // 出版の実績（行ごとに切り捨て）も同じく行の額をそのまま使う。
      const byUsage = events.some((e) => e.usageType)
        || (events.length > 0 && events.every((e) => e.amount !== null && e.amount !== undefined));
      const lineAmounts = byUsage
        ? settleToTotal(events.map((e) => e.amount ?? 0), net)
        : apportion(net, events.map((e) => e.share));
      for (const [i, e] of events.entries()) {
        await client.query(
          `INSERT INTO statement_lines
             (statement_id, line_no, condition_id, event_id, product_name,
              quantity, sample_quantity, unit_amount, rate_ppm, sales_input, fx_rate, amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [statementId, i + 1, conditionId, e.eventId, e.productName ?? null,
           e.quantity, e.sampleQuantity,
           e.unitAmount ?? null,
           e.ratePct === null || e.ratePct === undefined ? null : Math.round(e.ratePct * 10000),
           e.salesInput, null, lineAmounts[i]]);
      }
      // AG の消化は deductions 列で数える（agConsumedBefore が SUM する列）。
      // 実績を新しく立てる道では入れているのに、束ねる道では入れていなかった。
      // そのため前払保証がいつまでも消化されず、次の計算書でも同じ額が
      // もう一度相殺されて、実額が出ないままになる。ここでも積む。
      // 受取人ごとの計算書（取り分）は、最初に出した文書だけが実績を指す。
      // ほかの受取人の文書は明細（statement_lines.event_id）で実績に繋がる。
      const offsets = apportion(result.amounts.agOffsetMinor,
                                events.map((e) => e.share));
      for (const [i, e] of events.entries()) {
        await client.query(
          `UPDATE condition_events SET document_id = $2, deductions = $3
            WHERE id = $1 AND (document_id IS NULL OR document_id = $2)`,
          [e.eventId, input.documentId, offsets[i]]);
      }
      eventId = events[0].eventId;
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
        eventIds: events.map((e) => e.eventId),
        gross: result.amounts.grossMinor, net: result.amounts.netMinor,
        agOffset: result.amounts.agOffsetMinor, mgTopup: result.amounts.mgTopupMinor,
        formula: result.fee.formula_breakdown,
        ...(payee ? { payee: { partyId: payee.partyId, sharePpm: payee.sharePpm }, whole: result.whole } : {})
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
                -- 取り分のある条件（A-068）は受取人。空なら条件の相手先。
                COALESCE(pp.name, p.name) AS counterparty
           FROM statements s
           JOIN documents d  ON d.id = s.document_id
           JOIN conditions c ON c.id = s.condition_id
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN parties pp ON pp.id = s.payee_party_id
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
    events: StatementBasis[] = [],
    options: { requirePayee?: boolean } = {}
  ): Promise<CalculationPreview> {
    const resolved = await this.resolveVersion(client, input.conditionId, input.occurredOn ?? null);
    // 対象日に効いていた版で計算する。渡された版とずれたら、黙って差し替えずに
    // 結果へ載せる（なぜその料率になったのかが画面から読めないと検算できない）。
    const usedId = resolved?.id ?? input.conditionId;
    const condition = await this.loadCondition(client, usedId, { historical: Boolean(resolved) });
    const agConsumedBefore = await this.agConsumedBefore(client, usedId);

    const terms = buildFeeTerms(condition, input.reported);
    const adjustments = buildAdjustments(condition, input.reported, agConsumedBefore);
    const fee = calculateFee(terms, adjustments, taxRateFor(condition));

    const withholdingEnabled = resolveWithholdingEnabled({
      vendorWithholdingEnabled: condition.counterpartyWithholding,
      entityType: condition.counterpartyKind,
      residency: condition.withholdingParty?.residency ?? null
    });
    const payment = computeRoyaltyPayment({
      subtotalExTax: fee.actual_ex_tax,
      taxRatePct: taxRateFor(condition),
      withholdingEnabled,
      withholdingParty: condition.withholdingParty ?? null
    });

    const currency = condition.currency;
    const whole: CalculationPreview = {
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
      events,
      shares: null, payee: null, whole: null
    };

    // 共著の取り分（A-068）。条件 1 本で全体を出してから、受取人の額に割る。
    const shares = await loadShares(client, usedId);
    if (!shares.length) {
      if (input.payeePartyId) pickShare(shares, input.payeePartyId); // 取り分の無い条件に受取人は渡せない
      return whole;
    }
    // 代表が分配する契約（A-070）。取り分は契約の記録で、当社が払うのは相手先 1 件。
    if (await loadDistribution(client, usedId) === "representative") {
      if (input.payeePartyId) {
        throw new DomainError("VALIDATION", "代表（相手先）が分配する条件です。受取人は選べません（計算書は相手先 1 枚）");
      }
      return whole;
    }
    const ppm = shares.map((x) => x.sharePpm);
    const netByShare = allocateShares(whole.amounts.netMinor, ppm);
    whole.shares = shares.map((x, i) => ({
      partyId: x.partyId, name: x.partyName, kind: x.partyKind, sharePpm: x.sharePpm, netMinor: netByShare[i]
    }));
    const share = options.requirePayee || input.payeePartyId ? pickShare(shares, input.payeePartyId) : null;
    if (!share) return whole;
    return this.forPayee(client, whole, shares, share, condition);
  }

  /**
   * 受取人の試算。全体（条件 1 本の額）を取り分で割った額に、受取人の税区分の消費税と
   * 受取人の源泉（個人かどうか・非居住者か）を当てる。明細の行も同じ比で割る。
   */
  private async forPayee(
    client: Queryable, whole: CalculationPreview, shares: ConditionShareRow[], share: ConditionShareRow,
    condition: Awaited<ReturnType<RoyaltyStatementService["loadCondition"]>>
  ): Promise<CalculationPreview> {
    const currency = whole.condition.currency;
    const ppm = shares.map((x) => x.sharePpm);
    const idx = shares.findIndex((x) => x.partyId === share.partyId);
    const pick = (total: number) => allocateShares(total, ppm)[idx];
    const grossMinor = pick(whole.amounts.grossMinor);
    const netMinor = pick(whole.amounts.netMinor);
    const mgTopupMinor = pick(whole.amounts.mgTopupMinor);
    const agOffsetMinor = pick(whole.amounts.agOffsetMinor);
    const taxRate = taxRateFor(condition);
    const net = toMajor(netMinor, currency);
    const taxAmount = taxOf(net, taxRate);
    const pct = share.sharePpm / 10000;
    const fee: FeeResult = {
      ...whole.fee,
      gross_ex_tax: toMajor(grossMinor, currency),
      after_acceptance: toMajor(pick(toMinor(whole.fee.after_acceptance, currency)), currency),
      mg_topup_this_time: toMajor(mgTopupMinor, currency),
      ag_offset_this_time: toMajor(agOffsetMinor, currency),
      actual_ex_tax: net,
      tax_amount: taxAmount,
      total_inc_tax: net + taxAmount,
      formula_breakdown: `${whole.fee.formula_breakdown} ／ 取り分 ${pct}%（${share.partyName}）= ${net}`
    };
    // 源泉は受取人で決まる（条件の相手先ではなく）。
    const p = (await client.query(
      `SELECT kind, withholding, residency, treaty_rate_pct, treaty_docs_received_on
         FROM parties WHERE id = $1`, [share.partyId])).rows[0] as Record<string, any> | undefined;
    const withholdingEnabled = resolveWithholdingEnabled({
      vendorWithholdingEnabled: p?.withholding === true,
      entityType: p?.kind ? String(p.kind) : share.partyKind,
      residency: p?.residency ?? null
    });
    const payment = computeRoyaltyPayment({
      subtotalExTax: net, taxRatePct: taxRate, withholdingEnabled,
      withholdingParty: p ? withholdingPartyOf(p) : null
    });
    // 明細の行も受取人の額に割る。行ごとの端数は、確定のときに合計へ寄せる。
    const events = whole.events.map((e) => ({
      ...e, amount: e.amount === null || e.amount === undefined ? e.amount : pick(e.amount)
    }));
    return {
      ...whole,
      fee,
      payment: { ...payment, withholdingEnabled },
      amounts: { grossMinor, netMinor, taxMinor: toMinor(taxAmount, currency), agOffsetMinor, mgTopupMinor },
      events,
      payee: { partyId: share.partyId, name: share.partyName, sharePpm: share.sharePpm },
      whole: { grossMinor: whole.amounts.grossMinor, netMinor: whole.amounts.netMinor }
    };
  }

  private async loadCondition(client: Queryable, id: number, options: { historical?: boolean } = {}) {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.name, c.kind, c.direction, c.currency, c.pricing_model,
              c.counterparty_id, c.usage_type,
              c.rate_ppm, c.unit_amount, c.flat_amount, c.mg_amount, c.ag_amount,
              c.tax_category, c.status,
              a.title AS agreement_title, a.agreement_no,
              p.withholding, p.kind AS party_kind,
              p.residency, p.treaty_rate_pct, p.treaty_docs_received_on
         FROM conditions c
         LEFT JOIN parties p ON p.id = c.counterparty_id
         LEFT JOIN agreements a ON a.id = c.agreement_id
        WHERE c.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
    // 対象日に効いていた版（historical）は旧版でも計算してよい。改訂（期間の更新
    // など）のあとで、改訂前の日付の報告を計算できなくなるのを防ぐ。
    if (row.status === "void" || (row.status === "superseded" && !options.historical)) {
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
      // 非居住者と租税条約（A-057）。源泉の税率が変わる。
      withholdingParty: withholdingPartyOf(row),
      // 束ねた計算書の1行に印字する。条件名・契約名・契約番号が無いと、
      // 何本もの取引モデルが並んだときにどの行が何の分か読めない。
      name: String(row.name ?? ""),
      kind: String(row.kind ?? ""),
      counterpartyId: row.counterparty_id === null ? null : Number(row.counterparty_id),
      direction: String(row.direction ?? "out"),
      /** 利用形態（出版の紙・電子など）。端数の決まりが変わる。 */
      usageType: row.usage_type ? String(row.usage_type) : null,
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
