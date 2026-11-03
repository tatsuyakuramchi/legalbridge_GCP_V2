import { dateStr, int, str, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import type { ConditionEventService } from "../conditions/event-service.js";
import type { PaymentService } from "../payments/service.js";
import type { StatementIssuer } from "./statement-issue.js";
import type { RoyaltyReceiptService, Receipt } from "./receipts.js";
import { loadDistribution, loadShares } from "./shares.js";
import { WORK_LINEAGE_UP_SQL } from "./ledger-service.js";
import { ppmToPct } from "./economics.js";
import { coveringIns } from "./receipts.js";
import { inContractRef } from "./in-contract.js";

/**
 * 入金から計算書（支払文書 › 入金から計算書）。
 *
 * 取引先からの入金 1 件を、入金の記録 → 作者ごとの報告（実績） → 作者ごとの利用許諾計算書 → 作者への支払
 * まで 1 回で通す。イベント式（再許諾・自社製造・他社販売：入金 1 件＝報告 1 件＝計算書 1 枚）だけが対象。
 * 時限式（四半期締めなど）は従来どおり台帳の回から出す。
 *
 * 自社製造・自社販売（in_house）は OUT 先が無い（当社の売上）。入金は記録せず、作品の売上（数量 × 基準価格）から
 * 作者の報告を起こして計算書を出す。
 *
 * 各段は既存の部品（PaymentService / RoyaltyReceiptService / StatementIssuer）をそのまま呼ぶ。
 * 段ごとに別のトランザクションなので、途中で失敗したら「どこまで済んだか」を結果に返す。
 * もう一度同じ入金で実行すれば、済んだ作者は飛ばして残りだけ進む（報告は入金を指すので二重にならない）。
 */

export const EVENT_USAGES = ["sublicense", "oem"] as const;
export type SettleUsage = "sublicense" | "oem" | "in_house";

export interface SettleAuthor {
  conditionId: number; conditionNo: string | null; name: string;
  partyId: number; partyName: string; workId: number | null; workTitle: string | null;
  ratePct: number | null; targeted: boolean;
  /** 既にある報告（この入金を指すもの）と計算書。 */
  state: "unreported" | "mismatch" | "waiting" | "issued";
  reportCount: number; documents: Array<{ id: number; documentNo: string | null }>;
  /** 入金額 × 料率の見込み（MG・AG・税は計算書で）。 */
  estimate: number | null;
  /** 共著の取り分（当社が各人に払う）の受取人。空なら相手先 1 枚。 */
  payees: Array<{ partyId: number; partyName: string }>;
  /**
   * 計算書の「対象契約」「契約番号」に自動で出る作者側の契約（基本契約 / 個別契約）。
   * 両方空なら紙は「契約未指定」。画面で 基本契約・個別契約番号 を選んで直せる（contracts）。
   */
  contract: { title: string; number: string };
}

export interface SettlePreview {
  mode: "receipt" | "in_house";
  paymentId: number | null; paymentNo: string | null; paidOn: string | null; status: string | null;
  amount: number | null; currency: string;
  outConditionId: number | null; outConditionNo: string | null; outName: string | null;
  usageType: string | null; usageLabel: string;
  licenseePartyId: number | null; licenseeName: string | null;
  workId: number | null; workTitle: string | null;
  languages: string[]; regions: string[];
  authors: SettleAuthor[];
  blockers: string[];
  notes: string[];
}

export interface SettleInput {
  /** 記録済みの入金から（取引管理で入金済みにしたもの）。無ければ新しく記録する。 */
  paymentId?: number | null;
  outConditionId?: number | null;
  /** 自社製造・自社販売：作品で指す（OUT 先が無い）。 */
  workId?: number | null;
  usageType?: SettleUsage | null;
  /** 受領額（税抜。税込なら taxIncluded）。自社販売は 数量 × 基準価格。 */
  amount?: number | null;
  /** 個数建て：数量 × 単価（自社販売は基準価格、他社販売は受領価格 1 個あたり）。入れれば受領額はその積。 */
  quantity?: number | null; unitAmount?: number | null; sampleQuantity?: number | null;
  paidOn?: string | null;
  taxIncluded?: boolean | null;
  paymentStage?: "advance" | "balance" | null;
  languages?: string[] | null; regions?: string[] | null;
  note?: string | null;
  /** 作者（IN 条件）。空なら効く作者ぜんぶ。 */
  authors?: number[] | null;
  contracts?: AuthorContractChoice[] | null;
  statementNotes?: string | null;
  /** 下書きで止める（決定しない。文書の画面で確かめて決定する）。 */
  draftOnly?: boolean | null;
  /** 計算書を決定したら作者への支払も立てる。 */
  withPayment?: boolean | null;
  dueOn?: string | null;
}

/** 複数の入金をまとめて 1 枚に（前金と後金、別の取引先）。作者ごとに、全部の入金の報告を 1 枚の計算書に並べる。 */
/** 作者（IN 条件）ごとの契約の選び直し。文書フォームの 基本契約・個別契約番号 と同じ。 */
export interface AuthorContractChoice {
  conditionId: number;
  agreementId?: number | null;
  termsNo?: string | null;
}

export interface SettleManyInput {
  receipts: SettleInput[];
  authors?: number[] | null;
  contracts?: AuthorContractChoice[] | null;
  /** 計算書の備考（全員の計算書に同じ文。紙の備考の固定文の下に出る。前金・後金の説明は報告の備考から自動で足す）。 */
  statementNotes?: string | null;
  draftOnly?: boolean | null;
  withPayment?: boolean | null;
  dueOn?: string | null;
}

export interface SettleManyPreview {
  receipts: SettlePreview[];
  /** 作者ごとに、効く入金の見込みを合計。state は手前のもの。 */
  authors: Array<SettleAuthor & { receiptCount: number }>;
  blockers: string[];
  notes: string[];
}

export interface SettleResultRow {
  conditionId: number; partyName: string; payeeName: string | null;
  eventIds: number[];
  documentId: number | null; documentNo: string | null; draft: boolean;
  paymentId: number | null; paymentNo: string | null;
  skipped: string | null; error: string | null;
}

export interface SettleResult {
  mode: "receipt" | "in_house";
  paymentId: number | null; paymentNo: string | null; paymentCreated: boolean;
  /** 入金ごと（複数まとめたとき）。 */
  payments: Array<{ paymentId: number | null; paymentNo: string | null; created: boolean; licenseeName: string | null; amount: number | null }>;
  rows: SettleResultRow[];
  errors: string[];
}

const stateRank: Record<SettleAuthor["state"], number> = { unreported: 0, mismatch: 1, waiting: 2, issued: 3 };

interface Deps {
  receipts: Pick<RoyaltyReceiptService, "list" | "createReports" | "authorsFor">;
  payments: Pick<PaymentService, "create" | "markPaid" | "createFromStatementDocument">;
  issuer: Pick<StatementIssuer, "issue" | "draft">;
  events: Pick<ConditionEventService, "addWithin">;
}

const today = () => new Date().toISOString().slice(0, 10);
const estimateOf = (amount: number | null | undefined, ratePct: number | null) =>
  amount === null || amount === undefined || ratePct === null ? null : Math.floor((amount * ratePct) / 100);

export class ReceiptSettleService {
  constructor(private readonly database: Transactable, private readonly deps: Deps) {}

  /** 許諾先（OUT 条件）の見出し。 */
  private async outHead(outConditionId: number) {
    const r = (await this.database.query(
      `SELECT oc.id, oc.condition_no, oc.name, oc.usage_type, oc.currency, oc.status, oc.direction,
              oc.counterparty_id, lp.name AS licensee_name, oc.work_id, w.title AS work_title,
              (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                WHERE sc.condition_id = oc.id AND sc.scope_type = 'language') AS languages,
              (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                WHERE sc.condition_id = oc.id AND sc.scope_type = 'region') AS regions
         FROM conditions oc
         LEFT JOIN parties lp ON lp.id = oc.counterparty_id
         LEFT JOIN works w ON w.id = oc.work_id
        WHERE oc.id = $1`, [outConditionId])).rows[0] as any;
    if (!r) throw new DomainError("NOT_FOUND", `許諾先の条件 ${outConditionId} が見つかりません`);
    const strip = (xs: unknown, all: string) => (Array.isArray(xs) ? xs.map(String) : []).filter((x) => x !== all);
    return {
      id: Number(r.id), conditionNo: str(r.condition_no), name: String(r.name ?? ""), usageType: str(r.usage_type),
      currency: String(r.currency ?? "JPY"), status: String(r.status), direction: String(r.direction),
      licenseePartyId: int(r.counterparty_id), licenseeName: str(r.licensee_name),
      workId: int(r.work_id), workTitle: str(r.work_title),
      languages: strip(r.languages, "全言語"), regions: strip(r.regions, "全世界")
    };
  }

  /** 自動で出る作者側の契約（受取人が 1 人ならその人宛て、複数なら相手先宛てで代表させる）。 */
  private async contractOf(conditionId: number, payees: SettleAuthor["payees"]): Promise<SettleAuthor["contract"]> {
    try {
      const ref = await inContractRef(this.database, conditionId, { payeePartyId: payees.length === 1 ? payees[0].partyId : null });
      return { title: ref.title, number: ref.number };
    } catch { return { title: "", number: "" }; }
  }

  private async payeeAndContract(conditionId: number): Promise<Pick<SettleAuthor, "payees" | "contract">> {
    const payees = await this.payeesOf(conditionId);
    return { payees, contract: await this.contractOf(conditionId, payees) };
  }

  private async payeesOf(conditionId: number): Promise<SettleAuthor["payees"]> {
    const shares = await loadShares(this.database, conditionId);
    if (!shares.length) return [];
    // 代表者が分配するなら計算書は相手先 1 枚。
    if ((await loadDistribution(this.database, conditionId)) === "representative") return [];
    return shares.map((s) => ({ partyId: s.partyId, partyName: s.partyName }));
  }

  /** 自社製造・自社販売に効く作者：作品（とその元）に付いた in_house の IN 条件（料率・単価）。 */
  private async inHouseAuthors(workId: number) {
    const rows = (await this.database.query(
      `SELECT c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name, c.work_id, w.title AS work_title,
              c.rate_ppm, c.target_party_id
         FROM conditions c
         LEFT JOIN parties p ON p.id = c.counterparty_id
         LEFT JOIN works w ON w.id = c.work_id
        WHERE c.direction = 'in' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
          AND c.pricing_model IN ('revenue_rate', 'unit_rate')
          AND c.usage_type = 'in_house'
          AND c.work_id = ANY(${WORK_LINEAGE_UP_SQL("$1::bigint")})
        ORDER BY p.name, c.condition_no NULLS LAST, c.id`, [workId])).rows as any[];
    return coveringIns(rows.map((c) => ({
      conditionId: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
      partyId: Number(c.counterparty_id), partyName: String(c.party_name ?? ""),
      workId: int(c.work_id), workTitle: str(c.work_title),
      ratePct: c.rate_ppm === null ? null : ppmToPct(Number(c.rate_ppm)), targetPartyId: int(c.target_party_id)
    })), 0);
  }

  /** 許諾先（OUT 先）の候補：再許諾・自社製造・他社販売の OUT 条件を持つ取引先。 */
  async licensees(keyword: string): Promise<Array<{ id: number; name: string; outs: number; open: number }>> {
    try {
      const rows = (await this.database.query(
        `SELECT p.id, p.name,
                count(DISTINCT oc.id)::int AS outs,
                (SELECT count(*)::int FROM payments pm JOIN payment_allocations al ON al.payment_id = pm.id
                  JOIN conditions c2 ON c2.id = al.condition_id
                  WHERE pm.direction = 'in' AND pm.status = 'paid' AND c2.counterparty_id = p.id
                    AND c2.direction = 'out' AND c2.usage_type = ANY($2::text[])
                    AND NOT EXISTS (SELECT 1 FROM condition_events e WHERE e.source_payment_id = pm.id AND e.status = 'active')) AS open
           FROM parties p
           JOIN conditions oc ON oc.counterparty_id = p.id AND oc.direction = 'out'
                AND oc.usage_type = ANY($2::text[]) AND oc.status IN ('active', 'scheduled')
          WHERE p.status <> 'merged'
            AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR COALESCE(p.name_kana, '') ILIKE '%' || $1 || '%'
                 OR COALESCE(p.party_code, '') ILIKE '%' || $1 || '%')
          GROUP BY p.id, p.name
          ORDER BY open DESC, p.name
          LIMIT 50`, [keyword.trim(), [...EVENT_USAGES]])).rows as any[];
      return rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), outs: Number(r.outs ?? 0), open: Number(r.open ?? 0) }));
    } catch (error) { throw translate(error); }
  }

  /**
   * 許諾先 1 社の取引モデルの候補：OUT 条件（作品 × 取引モデル）と、その条件に割り当てた入金済みで
   * まだ報告の無い入金（記録済みの入金から進めるとき）。
   */
  async outsOf(partyId: number): Promise<{
    outs: Array<{ id: number; conditionNo: string | null; name: string; usageType: string | null; usageLabel: string;
                  workId: number | null; workTitle: string | null; currency: string; languages: string[];
                  ratePct: number | null; termStart: string | null; termEnd: string | null }>;
    receipts: Array<{ paymentId: number; paymentNo: string | null; paidOn: string | null; amount: number; currency: string;
                      outConditionId: number; outName: string; usageLabel: string; workTitle: string | null; reported: boolean }>;
  }> {
    try {
      const outs = (await this.database.query(
        `SELECT oc.id, oc.condition_no, oc.name, oc.usage_type, oc.currency, oc.work_id, w.title AS work_title, oc.rate_ppm,
                oc.term_start, oc.term_end,
                (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                  WHERE sc.condition_id = oc.id AND sc.scope_type = 'language') AS languages
           FROM conditions oc LEFT JOIN works w ON w.id = oc.work_id
          WHERE oc.counterparty_id = $1 AND oc.direction = 'out' AND oc.usage_type = ANY($2::text[])
            AND oc.status IN ('active', 'scheduled')
          ORDER BY w.title NULLS LAST, oc.usage_type, oc.condition_no NULLS LAST, oc.id`, [partyId, [...EVENT_USAGES]])).rows as any[];
      const receipts = (await this.database.query(
        `SELECT pm.id AS payment_id, pm.payment_no, pm.paid_on, al.amount, pm.currency, oc.id AS out_id, oc.name AS out_name,
                oc.usage_type, w.title AS work_title,
                EXISTS (SELECT 1 FROM condition_events e WHERE e.source_payment_id = pm.id AND e.status = 'active') AS reported
           FROM payments pm
           JOIN payment_allocations al ON al.payment_id = pm.id
           JOIN conditions oc ON oc.id = al.condition_id
           LEFT JOIN works w ON w.id = oc.work_id
          WHERE pm.direction = 'in' AND pm.status = 'paid' AND oc.counterparty_id = $1
            AND oc.direction = 'out' AND oc.usage_type = ANY($2::text[])
          ORDER BY pm.paid_on DESC NULLS LAST, pm.id DESC
          LIMIT 30`, [partyId, [...EVENT_USAGES]])).rows as any[];
      const strip = (xs: unknown) => (Array.isArray(xs) ? xs.map(String) : []).filter((x) => x !== "全言語");
      return {
        outs: outs.map((r) => ({
          id: Number(r.id), conditionNo: str(r.condition_no), name: String(r.name ?? ""), usageType: str(r.usage_type),
          usageLabel: conditionUsageLabel(r.usage_type), workId: int(r.work_id), workTitle: str(r.work_title),
          currency: String(r.currency ?? "JPY"), languages: strip(r.languages),
          ratePct: r.rate_ppm === null || r.rate_ppm === undefined ? null : ppmToPct(Number(r.rate_ppm)),
          termStart: dateStr(r.term_start), termEnd: dateStr(r.term_end)
        })),
        receipts: receipts.map((r) => ({
          paymentId: Number(r.payment_id), paymentNo: str(r.payment_no), paidOn: dateStr(r.paid_on), amount: Number(r.amount),
          currency: String(r.currency ?? "JPY"), outConditionId: Number(r.out_id), outName: String(r.out_name ?? ""),
          usageLabel: conditionUsageLabel(r.usage_type), workTitle: str(r.work_title), reported: r.reported === true
        }))
      };
    } catch (error) { throw translate(error); }
  }

  /** 下見：入金（記録済み or これから）と、払うべき作者。 */
  async preview(input: SettleInput): Promise<SettlePreview> {
    try {
      if (input.usageType === "in_house" || (!input.outConditionId && !input.paymentId && input.workId)) {
        return await this.previewInHouse(input);
      }
      const blockers: string[] = [];
      const notes: string[] = [];
      let receipt: Receipt | null = null;
      if (input.paymentId) {
        const found = (await this.deps.receipts.list({ paymentId: input.paymentId })).receipts;
        receipt = found.find((x) => !input.outConditionId || x.outConditionId === input.outConditionId) ?? null;
        if (!receipt) blockers.push("その入金は再許諾・自社製造・他社販売の許諾先に割り当てられた入金済みのものではありません");
      }
      const outId = receipt?.outConditionId ?? input.outConditionId ?? null;
      if (!outId) throw new DomainError("VALIDATION", "許諾先の条件か入金を選んでください");
      const head = await this.outHead(outId);
      if (head.direction !== "out") blockers.push("許諾先（OUT）の条件を選んでください");
      if (!EVENT_USAGES.includes(head.usageType as any)) {
        blockers.push(`この条件の取引モデル（${conditionUsageLabel(head.usageType)}）は入金から計算書を出す形ではありません。再許諾・自社製造・他社販売だけです`);
      }
      if (head.status === "void" || head.status === "superseded") blockers.push("無効・改訂済みの条件です。今の版を選んでください");
      if (!head.workId) blockers.push("許諾先の条件に作品が付いていません。作者の条件を引けません");

      const perUnit = Number(input.quantity ?? 0) > 0 && Number(input.unitAmount ?? 0) > 0;
      if (perUnit && head.usageType !== "oem") notes.push("数量 × 受領価格 で入れられるのは自社製造・他社販売だけです。再許諾は受領額で入れてください");
      const typed = perUnit ? Math.round(Number(input.quantity) * Number(input.unitAmount)) : (input.amount ?? null);
      const amount = receipt ? receipt.amount : typed;
      if (receipt && perUnit && typed !== receipt.amount) {
        notes.push(`数量 × 受領価格（${typed}）が入金額（${receipt.amount}）と違います。報告はその積で立ち、入金の欄に「金額が違う」と出ます`);
      }
      let authors: SettleAuthor[];
      if (receipt) {
        if (receipt.media === "print") {
          blockers.push("出版の紙の再許諾の入金は、版元の刷部数の報告から計算書を出します（入金からは起こしません）");
        }
        authors = await Promise.all(receipt.ins.map(async (x): Promise<SettleAuthor> => ({
          conditionId: x.conditionId, conditionNo: x.conditionNo, name: x.name, partyId: x.partyId, partyName: x.partyName,
          workId: x.workId, workTitle: x.workTitle, ratePct: x.ratePct, targeted: x.targeted,
          state: x.state, reportCount: x.reports.length,
          documents: x.reports.flatMap((e) => e.documents ?? (e.documentId ? [{ id: e.documentId, documentNo: e.documentNo }] : []))
            .filter((d, i, a) => a.findIndex((y) => y.id === d.id) === i),
          estimate: estimateOf(amount, x.ratePct), ...(await this.payeeAndContract(x.conditionId))
        })));
      } else {
        const found = await this.deps.receipts.authorsFor(outId);
        if (found.media === "print") {
          blockers.push("出版の紙の再許諾は、版元の刷部数の報告から計算書を出します（入金からは起こしません）");
        }
        authors = await Promise.all(found.authors.map(async (x): Promise<SettleAuthor> => ({
          conditionId: x.conditionId, conditionNo: x.conditionNo, name: x.name, partyId: x.partyId, partyName: x.partyName,
          workId: x.workId, workTitle: x.workTitle, ratePct: x.ratePct, targeted: Boolean(x.targetPartyId),
          state: "unreported", reportCount: 0, documents: [],
          estimate: estimateOf(amount, x.ratePct), ...(await this.payeeAndContract(x.conditionId))
        })));
      }
      if (!authors.length) {
        blockers.push("この許諾先に効く作者の条件（IN）が見つかりません。許諾先の作品と利用形態、作者の条件の作品（元の作品か）を確かめてください");
      }
      if (!receipt && amount !== null && amount !== undefined && !(amount > 0)) notes.push("受領額を入れると見込み額が出ます");
      if (head.languages.length > 1 && !receipt) {
        notes.push(`許諾先が複数の言語を持っています（${head.languages.join("・")}）。まとめて来る入金は全部のまま、言語ごとに来るならその言語だけにしてください`);
      }
      return {
        mode: "receipt",
        paymentId: receipt?.paymentId ?? null, paymentNo: receipt?.paymentNo ?? null, paidOn: receipt?.paidOn ?? input.paidOn ?? null,
        status: receipt?.status ?? null, amount, currency: receipt?.currency ?? head.currency,
        outConditionId: head.id, outConditionNo: head.conditionNo, outName: head.name,
        usageType: head.usageType, usageLabel: conditionUsageLabel(head.usageType),
        licenseePartyId: head.licenseePartyId, licenseeName: head.licenseeName,
        workId: head.workId, workTitle: head.workTitle, languages: head.languages, regions: head.regions,
        authors, blockers, notes
      };
    } catch (error) { throw translate(error); }
  }

  private async previewInHouse(input: SettleInput): Promise<SettlePreview> {
    const blockers: string[] = [];
    const notes: string[] = [];
    if (!input.workId) throw new DomainError("VALIDATION", "自社製造・自社販売は作品を選んでください（OUT 先はありません）");
    const w = (await this.database.query("SELECT id, title FROM works WHERE id = $1", [input.workId])).rows[0] as any;
    if (!w) throw new DomainError("NOT_FOUND", `作品 ${input.workId} が見つかりません`);
    const amount = input.quantity && input.unitAmount ? Math.round(input.quantity * input.unitAmount) : (input.amount ?? null);
    const list = await this.inHouseAuthors(input.workId);
    const authors = await Promise.all(list.map(async (x): Promise<SettleAuthor> => ({
      conditionId: x.conditionId, conditionNo: x.conditionNo, name: x.name, partyId: x.partyId, partyName: x.partyName,
      workId: x.workId, workTitle: x.workTitle, ratePct: x.ratePct, targeted: false,
      state: "unreported", reportCount: 0, documents: [],
      estimate: estimateOf(amount, x.ratePct), ...(await this.payeeAndContract(x.conditionId))
    })));
    if (!authors.length) blockers.push("この作品（とその元の作品）に、自社製造・自社販売の作者の条件（IN）が見つかりません");
    notes.push("自社製造・自社販売は当社の売上なので入金は記録しません。数量 × 基準価格（税抜）から作者の報告を起こします");
    return {
      mode: "in_house", paymentId: null, paymentNo: null, paidOn: input.paidOn ?? null, status: null,
      amount, currency: "JPY", outConditionId: null, outConditionNo: null, outName: null,
      usageType: "in_house", usageLabel: conditionUsageLabel("in_house"),
      licenseePartyId: null, licenseeName: null, workId: Number(w.id), workTitle: String(w.title ?? ""),
      languages: [], regions: [], authors, blockers, notes
    };
  }

  /** 下見（複数の入金）。作者は条件（IN）でまとめ、見込みは合計する。 */
  async previewMany(input: SettleManyInput): Promise<SettleManyPreview> {
    try {
      if (!input.receipts.length) throw new DomainError("VALIDATION", "入金を 1 件は入れてください");
      const receipts: SettlePreview[] = [];
      for (const r of input.receipts) receipts.push(await this.preview(r));
      const byId = new Map<number, SettleAuthor & { receiptCount: number }>();
      for (const p of receipts) {
        for (const a of p.authors) {
          const cur = byId.get(a.conditionId);
          if (!cur) { byId.set(a.conditionId, { ...a, receiptCount: 1 }); continue; }
          cur.receiptCount += 1;
          cur.estimate = cur.estimate === null && a.estimate === null ? null : Number(cur.estimate ?? 0) + Number(a.estimate ?? 0);
          cur.reportCount += a.reportCount;
          cur.documents = [...cur.documents, ...a.documents].filter((d, i, arr) => arr.findIndex((y) => y.id === d.id) === i);
          // 1 件でもまだの入金があれば、その作者は「まだ」。
          if (stateRank[a.state] < stateRank[cur.state]) cur.state = a.state;
        }
      }
      const notes = [...new Set(receipts.flatMap((p) => p.notes))];
      if (receipts.length > 1) notes.push(`入金 ${receipts.length} 件を作者ごとに 1 枚の計算書にまとめます（入金 1 件が 1 行）`);
      return {
        receipts, authors: [...byId.values()],
        blockers: [...new Set(receipts.flatMap((p, i) => p.blockers.map((b) => receipts.length > 1 ? `入金 ${i + 1}：${b}` : b)))],
        notes
      };
    } catch (error) { throw translate(error); }
  }

  /** 実行：入金の記録 → 報告 → 計算書 → 支払（入金 1 件）。 */
  async settle(input: SettleInput, actor: string): Promise<SettleResult> {
    return this.settleMany({ receipts: [input], authors: input.authors, contracts: input.contracts, statementNotes: input.statementNotes, draftOnly: input.draftOnly,
                             withPayment: input.withPayment, dueOn: input.dueOn }, actor);
  }

  /**
   * 実行（複数の入金）。入金ごとに 記録 → 報告 を済ませてから、作者ごとに全部の入金の報告を 1 枚の計算書に。
   * 決定日はいちばん遅い入金日。
   */
  async settleMany(input: SettleManyInput, actor: string): Promise<SettleResult> {
    try {
      const pre = await this.previewMany(input);
      if (pre.blockers.length) throw new DomainError("VALIDATION", pre.blockers[0]);
      const chosen = new Set(input.authors?.length ? input.authors : pre.authors.map((a) => a.conditionId));
      const targets = pre.authors.filter((a) => chosen.has(a.conditionId));
      if (!targets.length) throw new DomainError("VALIDATION", "作者を選んでください");

      // 入力の不足は、何も書く前に全部の入金で確かめる（2 件目で止まって 1 件目だけ記録済み、を避ける）。
      input.receipts.forEach((r, i) => {
        try { this.requireInputs(r, pre.receipts[i]); }
        catch (error) {
          throw new DomainError("VALIDATION", input.receipts.length > 1 ? `入金 ${i + 1}：${(error as Error).message}` : (error as Error).message);
        }
      });
      const errors: string[] = [];
      const payments: SettleResult["payments"] = [];
      /** 作者（IN 条件）→ まだ文書に結ばれていない報告。 */
      const open = new Map<number, number[]>();
      const issued = new Map<number, Array<{ id: number; documentNo: string | null }>>();
      let issuedOn = today();
      for (let i = 0; i < input.receipts.length; i++) {
        const r = input.receipts[i];
        const p = pre.receipts[i];
        const mine = p.authors.filter((a) => chosen.has(a.conditionId));
        if (!mine.length) continue;
        try {
          const step = p.mode === "in_house"
            ? await this.inHouseReports(r, p, mine, actor)
            : await this.receiptReports(r, p, mine, actor);
          payments.push(...step.payments);
          errors.push(...step.errors);
          if (step.paidOn > issuedOn || i === 0) issuedOn = step.paidOn;
          for (const [cid, ids] of step.open) open.set(cid, [...new Set([...(open.get(cid) ?? []), ...ids])]);
          for (const [cid, docs] of step.issued) issued.set(cid, [...(issued.get(cid) ?? []), ...docs]);
        } catch (error) {
          errors.push(`入金 ${i + 1}：${(error as Error).message}`);
        }
      }

      const rows: SettleResultRow[] = [];
      for (const a of targets) {
        const ids = open.get(a.conditionId) ?? [];
        const docs = issued.get(a.conditionId) ?? [];
        const base: SettleResultRow = {
          conditionId: a.conditionId, partyName: a.partyName, payeeName: null, eventIds: ids,
          documentId: docs[0]?.id ?? null, documentNo: docs[0]?.documentNo ?? null, draft: false,
          paymentId: null, paymentNo: null, skipped: null, error: null
        };
        if (!ids.length) { rows.push(docs.length ? { ...base, skipped: "計算書済" } : { ...base, error: "報告がありません" }); continue; }
        rows.push(...await this.issueFor(a, ids, issuedOn, input, actor));
      }
      const first = payments[0] ?? null;
      return {
        mode: pre.receipts.every((p) => p.mode === "in_house") ? "in_house" : "receipt",
        paymentId: first?.paymentId ?? null, paymentNo: first?.paymentNo ?? null, paymentCreated: first?.created ?? false,
        payments, rows, errors
      };
    } catch (error) { throw translate(error); }
  }

  /** 入金 1 件の入力の確かめ（書く前に）。 */
  private requireInputs(input: SettleInput, pre: SettlePreview): void {
    if (pre.mode === "in_house") {
      if (!(Number(input.quantity ?? 0) > 0) || !(Number(input.unitAmount ?? 0) > 0)) {
        throw new DomainError("VALIDATION", "自社製造・自社販売は 数量 と 基準価格（税抜） を入れてください");
      }
      return;
    }
    const perUnit = Number(input.quantity ?? 0) > 0 && Number(input.unitAmount ?? 0) > 0;
    if (perUnit && pre.usageType !== "oem") {
      throw new DomainError("VALIDATION", "数量 × 受領価格 で入れられるのは自社製造・他社販売だけです（再許諾は受領額）");
    }
    if (!pre.paymentId) {
      const amount = perUnit ? Math.round(Number(input.quantity) * Number(input.unitAmount)) : (input.amount ?? null);
      if (!(amount && amount > 0)) throw new DomainError("VALIDATION", "入金額を入れてください");
      if (pre.languages.length > 1 && !(input.languages?.length)) {
        throw new DomainError("VALIDATION", "この入金の言語を選んでください（許諾先が複数の言語を持っています。まとめて来るなら全部）");
      }
    }
  }

  /** 入金 1 件：記録（未記録なら）と、まだの作者の報告。作者ごとの「空いている報告」を返す。 */
  private async receiptReports(input: SettleInput, pre: SettlePreview, targets: SettleAuthor[], actor: string): Promise<{
    paidOn: string; payments: SettleResult["payments"]; errors: string[];
    open: Map<number, number[]>; issued: Map<number, Array<{ id: number; documentNo: string | null }>>;
  }> {
    const outId = pre.outConditionId!;
    const errors: string[] = [];
    let paymentId = pre.paymentId;
    let paymentNo = pre.paymentNo;
    let created = false;
    const paidOn = pre.paidOn ?? input.paidOn ?? today();
    const perUnit = Number(input.quantity ?? 0) > 0 && Number(input.unitAmount ?? 0) > 0;
    if (perUnit && pre.usageType !== "oem") {
      throw new DomainError("VALIDATION", "数量 × 受領価格 で入れられるのは自社製造・他社販売だけです（再許諾は受領額）");
    }
    if (!paymentId) {
      const amount = perUnit ? Math.round(Number(input.quantity) * Number(input.unitAmount)) : (input.amount ?? null);
      if (!(amount && amount > 0)) throw new DomainError("VALIDATION", "入金額を入れてください");
      if (pre.languages.length > 1 && !(input.languages?.length)) {
        throw new DomainError("VALIDATION", "この入金の言語を選んでください（許諾先が複数の言語を持っています。まとめて来るなら全部）");
      }
      const made = await this.deps.payments.create({
        conditionId: outId, direction: "in", amount: Math.round(amount), basisReceivedOn: paidOn,
        note: str(input.note) ?? `入金から計算書（${pre.licenseeName ?? ""}）`
      }, actor);
      await this.deps.payments.markPaid(made.id, paidOn, actor);
      paymentId = made.id; paymentNo = made.paymentNo; created = true;
    }
    const fresh = targets.filter((a) => a.state === "unreported");
    let receipt: Receipt | null = null;
    if (fresh.length) {
      try {
        const made = await this.deps.receipts.createReports({
          paymentId, outConditionId: outId,
          entries: fresh.map((a) => ({
            conditionId: a.conditionId, grossAmount: null,
            ...(perUnit ? { quantity: input.quantity, unitAmount: input.unitAmount, sampleQuantity: input.sampleQuantity ?? null } : {}),
            taxIncluded: input.taxIncluded ?? false,
            paymentStage: input.paymentStage ?? null, languages: input.languages ?? null, regions: input.regions ?? null,
            note: str(input.note)
          }))
        }, actor);
        receipt = made.receipt;
      } catch (error) {
        errors.push(`報告を起こせませんでした：${(error as Error).message}`);
      }
    }
    if (!receipt) {
      receipt = (await this.deps.receipts.list({ paymentId })).receipts.find((x) => x.outConditionId === outId) ?? null;
    }
    const open = new Map<number, number[]>();
    const issued = new Map<number, Array<{ id: number; documentNo: string | null }>>();
    for (const a of targets) {
      const now = receipt?.ins.find((x) => x.conditionId === a.conditionId);
      const free = (now?.reports ?? []).filter((e) => !e.documentId).map((e) => e.id);
      if (free.length) open.set(a.conditionId, free);
      const docs = (now?.reports ?? []).flatMap((e) => e.documents ?? (e.documentId ? [{ id: e.documentId, documentNo: e.documentNo }] : []));
      if (docs.length) issued.set(a.conditionId, docs);
    }
    return {
      paidOn, errors, open, issued,
      payments: [{ paymentId, paymentNo, created, licenseeName: pre.licenseeName, amount: pre.amount }]
    };
  }

  /** 自社製造・自社販売：売上の報告（数量 × 基準価格）。入金は無い。 */
  private async inHouseReports(input: SettleInput, pre: SettlePreview, targets: SettleAuthor[], actor: string): Promise<{
    paidOn: string; payments: SettleResult["payments"]; errors: string[];
    open: Map<number, number[]>; issued: Map<number, Array<{ id: number; documentNo: string | null }>>;
  }> {
    const occurredOn = input.paidOn ?? today();
    const quantity = input.quantity ?? null;
    const unitAmount = input.unitAmount ?? null;
    if (!(quantity && quantity > 0) || !(unitAmount && unitAmount > 0)) {
      throw new DomainError("VALIDATION", "自社製造・自社販売は 数量 と 基準価格（税抜） を入れてください");
    }
    const errors: string[] = [];
    const open = new Map<number, number[]>();
    for (const a of targets) {
      try {
        const made = await this.deps.events.addWithin(this.database, a.conditionId, {
          eventType: "sales", occurredOn, usageType: "in_house", workId: pre.workId,
          quantity, unitAmount, amount: 0,
          taxIncluded: input.taxIncluded ?? false, paymentStage: input.paymentStage ?? null,
          note: str(input.note) ?? "入金から計算書（自社製造・自社販売）"
        } as any, actor);
        open.set(a.conditionId, [made.id]);
      } catch (error) {
        errors.push(`${a.partyName}：報告を起こせませんでした：${(error as Error).message}`);
      }
    }
    return { paidOn: occurredOn, errors, open, issued: new Map(), payments: [] };
  }

  /** 作者 1 人（受取人ごと）の計算書と支払。 */
  private async issueFor(a: SettleAuthor, eventIds: number[], issuedOn: string,
                         input: { draftOnly?: boolean | null; withPayment?: boolean | null; dueOn?: string | null;
                                  contracts?: AuthorContractChoice[] | null; statementNotes?: string | null }, actor: string): Promise<SettleResultRow[]> {
    const payees: Array<{ partyId: number | null; partyName: string | null }> = a.payees.length ? a.payees : [{ partyId: null, partyName: null }];
    const out: SettleResultRow[] = [];
    for (const payee of payees) {
      const row: SettleResultRow = {
        conditionId: a.conditionId, partyName: a.partyName, payeeName: payee.partyName, eventIds,
        documentId: null, documentNo: null, draft: false, paymentId: null, paymentNo: null, skipped: null, error: null
      };
      try {
        const entry = { conditionId: a.conditionId, eventIds, payeePartyId: payee.partyId };
        // 契約の選び直し（基本契約・個別契約番号）。文書フォームの agreementId・_termsNo と同じ渡し方。
        const choice = (input.contracts ?? []).find((c) => c.conditionId === a.conditionId);
        const termsNo = String(choice?.termsNo ?? "").trim();
        const notes = String(input.statementNotes ?? "").trim();
        const chosen = {
          agreementId: choice?.agreementId ?? null,
          manualInputs: { ...(termsNo ? { _termsNo: termsNo } : {}), ...(notes ? { notes } : {}) }
        };
        if (input.draftOnly) {
          const d = await this.deps.issuer.draft({ entries: [entry], ...chosen }, actor);
          row.documentId = d.id; row.draft = true;
        } else {
          const made = await this.deps.issuer.issue({ entries: [entry], issuedOn, ...chosen }, actor);
          row.documentId = made.document.id; row.documentNo = made.document.documentNo;
          if (input.withPayment !== false) {
            try {
              const pay = await this.deps.payments.createFromStatementDocument(made.document.id, actor, { dueOn: input.dueOn ?? undefined });
              row.paymentId = Number((pay as any).id ?? (pay as any).paymentId ?? 0) || null;
              row.paymentNo = str((pay as any).paymentNo);
            } catch (error) {
              row.error = `支払を立てられませんでした：${(error as Error).message}`;
            }
          }
        }
      } catch (error) {
        row.error = `計算書を作れませんでした：${(error as Error).message}`;
      }
      out.push(row);
    }
    return out;
  }
}

export const settleUsageLabel = (u: string | null) => conditionUsageLabel(u);
