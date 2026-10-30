import { dateStr, inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import type { ConditionEventService } from "../conditions/event-service.js";
import { WORK_LINEAGE_UP_SQL } from "./ledger-service.js";
import { ppmToPct } from "./economics.js";

/**
 * 入金と作者への支払（docs/royalty-ledger.md §10）。
 *
 * 当社は取引先から OUT 条件に基づいてお金を受け取り（入金）、作者へ IN 条件に基づいて払う。
 * 入金 1 件（OUT 条件に割り当てた入金）から、その許諾先に効く IN 条件（作者）ごとに報告を起こす。
 * 作者が複数いれば、各作者が入金の全額にそれぞれの料率を掛ける（報告は作者ごとに 1 件、同じ入金を指す）。
 *
 * 入金に効く IN 条件（台帳の「来るはずの行」と同じ決まり）：
 *   取得（IN）の許諾で生きている版・料率か単価の条件、利用形態が OUT と同じ（再許諾／自社製造・他社販売）、
 *   IN の作品が OUT の作品かその祖先（派生作品の許諾は元の作品の作者に払う）、
 *   許諾先専用の IN 条件（target_party_id）はその許諾先だけ。一律の IN 条件は、同じ作品・利用形態で
 *   専用の条件を持つ許諾先を除く。
 */

export type ReceiptInState = "unreported" | "mismatch" | "waiting" | "issued";
export const RECEIPT_IN_STATE_LABEL: Record<ReceiptInState, string> = {
  unreported: "未報告", mismatch: "金額が違う", waiting: "計算書待ち", issued: "計算書済"
};

export interface ReceiptReport {
  id: number; grossAmount: number | null; amount: number; occurredOn: string | null;
  languages: string[]; documentId: number | null; documentNo: string | null;
}
export interface ReceiptIn {
  conditionId: number; conditionNo: string | null; name: string;
  partyId: number; partyName: string; workId: number | null; workTitle: string | null;
  usageLabel: string; ratePct: number | null; targeted: boolean;
  reports: ReceiptReport[];
  state: ReceiptInState;
  /** 報告の受領額の合計（この入金を指すもの）。 */
  reported: number;
}
export interface Receipt {
  /** 入金 × OUT 条件（割り当て 1 本）。 */
  key: string;
  paymentId: number; paymentNo: string | null; paidOn: string | null; status: string;
  amount: number; currency: string;
  outConditionId: number; outConditionNo: string | null; outName: string;
  usageType: string | null; usageLabel: string;
  licenseePartyId: number; licenseeName: string;
  workId: number | null; workTitle: string | null;
  /** 許諾言語・地域（「全言語」「全世界」を除く）。報告の言語の候補。 */
  languages: string[]; regions: string[];
  ins: ReceiptIn[];
  /** 全体：作者のいない入金（IN 条件が見つからない）は none。 */
  state: ReceiptInState | "none";
}

/** 入金に対する作者 1 人（IN 条件 1 本）の状態（純粋関数）。 */
export function receiptInState(amount: number, reports: Array<{ grossAmount: number | null; documentId: number | null }>): ReceiptInState {
  if (!reports.length) return "unreported";
  const reported = reports.reduce((n, r) => n + Number(r.grossAmount ?? 0), 0);
  if (reported !== amount) return "mismatch";
  return reports.every((r) => r.documentId) ? "issued" : "waiting";
}

/** 入金全体の状態：いちばん手前の作者の状態。 */
export function receiptState(ins: Array<{ state: ReceiptInState }>): Receipt["state"] {
  if (!ins.length) return "none";
  for (const s of ["unreported", "mismatch", "waiting"] as const) if (ins.some((x) => x.state === s)) return s;
  return "issued";
}

/**
 * 許諾先専用・一律の振り分け（純粋関数）。同じ作品・利用形態で、この許諾先専用の IN 条件があれば
 * その作者の一律の条件は外す（専用の料率が勝つ）。
 */
export function coveringIns<T extends { conditionId: number; partyId: number; workId: number | null; targetPartyId: number | null }>(
  candidates: T[], licenseePartyId: number
): T[] {
  return candidates.filter((c) => {
    if (c.targetPartyId) return c.targetPartyId === licenseePartyId;
    return !candidates.some((x) => x !== c && x.targetPartyId === licenseePartyId
      && x.partyId === c.partyId && x.workId === c.workId);
  });
}

const OUT_USAGES = ["sublicense", "oem"];

/** 入金 × OUT 条件（割り当て 1 本）の行。WHERE は呼び手が続ける。 */
const RECEIPT_SELECT = `SELECT p.id AS payment_id, p.payment_no, p.paid_on, p.status, p.currency, al.amount,
                oc.id AS out_id, oc.condition_no AS out_no, oc.name AS out_name, oc.usage_type,
                oc.counterparty_id AS licensee_id, lp.name AS licensee_name, oc.work_id, w.title AS work_title,
                (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                  WHERE sc.condition_id = oc.id AND sc.scope_type = 'language') AS languages,
                (SELECT array_agg(sc.label ORDER BY sc.sort_order, sc.label) FROM condition_scopes sc
                  WHERE sc.condition_id = oc.id AND sc.scope_type = 'region') AS regions
           FROM payments p
           JOIN payment_allocations al ON al.payment_id = p.id
           JOIN conditions oc ON oc.id = al.condition_id
           LEFT JOIN parties lp ON lp.id = oc.counterparty_id
           LEFT JOIN works w ON w.id = oc.work_id`;

export class RoyaltyReceiptService {
  constructor(private readonly database: Transactable, private readonly events: Pick<ConditionEventService, "addWithin">) {}

  /** 入金の一覧。期間は入金日（未入金の予定は含めない）。 */
  async list(input: { from?: string | null; to?: string | null; outConditionId?: number | null; workId?: number | null;
                      state?: ReceiptInState | "none" | "open" | null } = {}): Promise<{ receipts: Receipt[] }> {
    try {
      const rows = (await this.database.query(
        `${RECEIPT_SELECT}
          WHERE p.direction = 'in' AND p.status = 'paid'
            AND oc.direction = 'out' AND oc.usage_type = ANY($1::text[])
            AND ($2::date IS NULL OR p.paid_on >= $2::date)
            AND ($3::date IS NULL OR p.paid_on <= $3::date)
            AND ($4::bigint IS NULL OR oc.id = $4)
            AND ($5::bigint IS NULL OR $5 = ANY(${WORK_LINEAGE_UP_SQL("oc.work_id")}))
          ORDER BY p.paid_on DESC NULLS LAST, p.id DESC
          LIMIT 500`,
        [OUT_USAGES, input.from ?? null, input.to ?? null, input.outConditionId ?? null, input.workId ?? null])).rows as any[];
      const receipts: Receipt[] = [];
      for (const r of rows) receipts.push(await this.assemble(this.database, r));
      const open = new Set(["unreported", "mismatch", "waiting", "none"]);
      return {
        receipts: receipts.filter((x) => !input.state || (input.state === "open" ? open.has(x.state) : x.state === input.state))
      };
    } catch (error) { throw translate(error); }
  }

  /** 入金 1 件（割り当て 1 本）を、作者ごとの状態つきで組み立てる。 */
  private async assemble(q: Queryable, r: any): Promise<Receipt> {
    const ins = await this.insFor(q, Number(r.out_id));
    const reports = ins.length ? (await q.query(
      `SELECT e.id, e.condition_id, COALESCE(c.series_id, c.id) AS series, e.gross_amount, e.amount, e.occurred_on,
              e.scope_languages, d.id AS document_id, d.document_no
         FROM condition_events e
         JOIN conditions c ON c.id = e.condition_id
         LEFT JOIN documents d ON d.id = e.document_id AND d.status = 'issued'
        WHERE e.source_payment_id = $1 AND e.out_condition_id IN
              (SELECT id FROM conditions WHERE COALESCE(series_id, id) = (SELECT COALESCE(series_id, id) FROM conditions WHERE id = $2))
          AND e.status = 'active'
        ORDER BY e.id`, [r.payment_id, r.out_id])).rows as any[] : [];
    const amount = Number(r.amount);
    const list: ReceiptIn[] = ins.map((c) => {
      const mine = reports.filter((e) => Number(e.series) === c.series).map((e): ReceiptReport => ({
        id: Number(e.id), grossAmount: int(e.gross_amount), amount: Number(e.amount ?? 0), occurredOn: dateStr(e.occurred_on),
        languages: Array.isArray(e.scope_languages) ? e.scope_languages.map(String) : [],
        documentId: int(e.document_id), documentNo: str(e.document_no)
      }));
      return {
        conditionId: c.conditionId, conditionNo: c.conditionNo, name: c.name, partyId: c.partyId, partyName: c.partyName,
        workId: c.workId, workTitle: c.workTitle, usageLabel: conditionUsageLabel(c.usageType), ratePct: c.ratePct,
        targeted: Boolean(c.targetPartyId), reports: mine, state: receiptInState(amount, mine),
        reported: mine.reduce((n, e) => n + Number(e.grossAmount ?? 0), 0)
      };
    });
    const strip = (xs: unknown, all: string) => (Array.isArray(xs) ? xs.map(String) : []).filter((x) => x !== all);
    return {
      key: `${r.payment_id}:${r.out_id}`,
      paymentId: Number(r.payment_id), paymentNo: str(r.payment_no), paidOn: dateStr(r.paid_on), status: String(r.status),
      amount, currency: String(r.currency ?? "JPY"),
      outConditionId: Number(r.out_id), outConditionNo: str(r.out_no), outName: String(r.out_name ?? ""),
      usageType: str(r.usage_type), usageLabel: conditionUsageLabel(r.usage_type),
      licenseePartyId: Number(r.licensee_id), licenseeName: String(r.licensee_name ?? ""),
      workId: int(r.work_id), workTitle: str(r.work_title),
      languages: strip(r.languages, "全言語"), regions: strip(r.regions, "全世界"),
      ins: list, state: receiptState(list)
    };
  }

  /** OUT 条件に効く IN 条件（作者）。 */
  private async insFor(q: Queryable, outConditionId: number) {
    const rows = (await q.query(
      `SELECT c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name, c.work_id, w.title AS work_title,
              c.usage_type, c.rate_ppm, c.target_party_id, COALESCE(c.series_id, c.id) AS series
         FROM conditions c
         JOIN conditions oc ON oc.id = $1
         LEFT JOIN parties p ON p.id = c.counterparty_id
         LEFT JOIN works w ON w.id = c.work_id
        WHERE c.direction = 'in' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
          AND c.pricing_model IN ('revenue_rate', 'unit_rate')
          AND c.usage_type = oc.usage_type
          AND oc.work_id IS NOT NULL
          AND c.work_id = ANY(${WORK_LINEAGE_UP_SQL("oc.work_id")})
        ORDER BY p.name, c.condition_no NULLS LAST, c.id`, [outConditionId])).rows as any[];
    const licensee = Number(((await q.query("SELECT counterparty_id FROM conditions WHERE id = $1", [outConditionId])).rows[0] as any)?.counterparty_id ?? 0);
    return coveringIns(rows.map((c) => ({
      conditionId: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
      partyId: Number(c.counterparty_id), partyName: String(c.party_name ?? ""),
      workId: int(c.work_id), workTitle: str(c.work_title), usageType: str(c.usage_type),
      ratePct: c.rate_ppm === null ? null : ppmToPct(Number(c.rate_ppm)), targetPartyId: int(c.target_party_id),
      series: Number(c.series)
    })), licensee);
  }

  /**
   * 入金から作者ごとの報告を起こす。受領額は既定で入金額（割り当て額）。各作者の料率は IN 条件のもの。
   * 同じ入金をすでに指している作者には足さない（直すなら報告の「直す」で）。
   */
  async createReports(input: {
    paymentId: number; outConditionId: number;
    entries: Array<{ conditionId: number; grossAmount?: number | null; taxIncluded?: boolean | null;
                     paymentStage?: "advance" | "balance" | null; languages?: string[] | null; regions?: string[] | null;
                     note?: string | null }>;
  }, actor: string): Promise<{ eventIds: number[]; receipt: Receipt }> {
    if (!input.entries.length) throw new DomainError("VALIDATION", "報告を起こす作者（IN 条件）を選んでください");
    try {
      return await inTransaction(this.database, async (client) => {
        const head = (await client.query(
          `${RECEIPT_SELECT}
            WHERE p.id = $1 AND oc.id = $2 FOR UPDATE OF p`, [input.paymentId, input.outConditionId])).rows[0] as any;
        if (!head) throw new DomainError("NOT_FOUND", "その入金はこの許諾先（OUT 条件）に割り当てられていません");
        if (head.status !== "paid") throw new DomainError("CONFLICT", "入金済みの入金だけから報告を起こせます");
        if (!OUT_USAGES.includes(String(head.usage_type))) {
          throw new DomainError("VALIDATION", "再許諾・自社製造・他社販売の許諾先の入金だけから報告を起こせます");
        }
        const before = await this.assemble(client, head);
        const ids: number[] = [];
        for (const entry of input.entries) {
          const target = before.ins.find((x) => x.conditionId === entry.conditionId);
          if (!target) throw new DomainError("VALIDATION", `条件 ${entry.conditionId} はこの許諾先に効く作者の条件ではありません`);
          if (target.reports.length) {
            throw new DomainError("CONFLICT", `${target.partyName}（${target.conditionNo ?? target.name}）にはこの入金の報告がもうあります`);
          }
          const gross = entry.grossAmount ?? before.amount;
          if (!(gross > 0)) throw new DomainError("VALIDATION", "受領額を入れてください");
          const made = await this.events.addWithin(client, entry.conditionId, {
            eventType: head.usage_type === "sublicense" ? "sublicense_receipt" : "sales",
            occurredOn: before.paidOn ?? new Date().toISOString().slice(0, 10),
            usageType: head.usage_type, outConditionId: before.outConditionId,
            grossAmount: Math.round(gross), amount: 0,
            taxIncluded: entry.taxIncluded ?? false,
            paymentStage: entry.paymentStage ?? null,
            languages: entry.languages ?? (before.languages.length === 1 ? before.languages : null),
            regions: entry.regions ?? null,
            note: str(entry.note) ?? `入金 ${before.paymentNo ?? `#${before.paymentId}`} から`,
            sourcePaymentId: before.paymentId
          }, actor);
          ids.push(made.id);
        }
        return { eventIds: ids, receipt: await this.assemble(client, head) };
      });
    } catch (error) { throw translate(error); }
  }
}
