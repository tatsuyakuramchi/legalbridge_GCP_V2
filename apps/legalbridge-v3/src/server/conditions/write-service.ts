import { dateStr, inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { ConditionScheduleService, type ScheduleLine } from "./schedule-service.js";
import { CONDITION_KINDS_BY_MATTER } from "../matters/link-service.js";
import { recordAudit } from "../core/audit.js";
import { ConditionRepository } from "./repository.js";
import { allocateNumber } from "../core/numbering.js";
import { roundAmount } from "../core/rounding.js";
import { readContractForm } from "./contract-form.js";
import type { ConditionScope, LicenseFeeBasis } from "../core/model.js";
import { PUB_MEDIA_LABEL, pubMediaOf, type PubMedia } from "../core/pub-media.js";
import { conditionNameFor } from "./naming.js";
import { conditionUsageLabel, pubMediaOfUsage, usageOfPubMedia,
         type ConditionUsageType } from "../core/condition-usage.js";
import { validateShareInput } from "../royalty/shares.js";

/** 出版の条件（作品1点＝紙・電子）。createPublishingSet の入力。 */
export interface PublishingTerms {
  /** 料率（%）。11 は 11%。 */
  ratePct: number;
  exclusivity?: "exclusive" | "non_exclusive" | null;
}
/**
 * 翻訳版の再許諾（A-033）。乙が第三者に出させ、受領額から甲へ払う。
 * 相手が決まる前に作るので、再許諾先は無くてよい（決まっていれば条件名に入る）。
 */
export interface PublishingTranslationTerms extends PublishingTerms {
  /** 再許諾ごとの別途合意。covered=不要（本条件書で許諾済み）/ required=要。 */
  consent?: "covered" | "required" | null;
  sublicensee?: string | null;
  purpose?: string | null;
}
export interface PublishingSetInput {
  matterId?: number | null;
  /**
   * 条件名の手入力。空なら規則（作品名｜紙出版 など）で付ける。作品が無い
   * ときだけ必須。
   */
  title?: string | null;
  counterpartyId: number;
  agreementId?: number | null;
  workId?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  currency?: string;
  taxCategory?: "taxable" | "reduced" | "exempt" | "included";
  paymentTerms?: string | null;
  notes?: string | null;
  /** 地域・言語。媒体はここではなく print / digital で決まる。 */
  scopes?: ConditionScope[];
  print?: PublishingTerms | null;
  digital?: PublishingTerms | null;
  /** 翻訳版の再許諾（A-033）。紙・電子で率が違うので別々に持つ。 */
  translationPrint?: PublishingTranslationTerms | null;
  translationDigital?: PublishingTranslationTerms | null;
  /** 出版の再許諾（翻訳出版など）。再許諾先と目的が条件名に入る。 */
  sublicense?: (PublishingTerms & { sublicensee?: string | null; purpose?: string | null; targetPartyId?: number | null }) | null;
}
export type PublishingSetResult = Record<PubMedia, { id: number; conditionNo: string | null } | null>
  & { sublicense?: { id: number; conditionNo: string | null } | null;
      translationPrint?: { id: number; conditionNo: string | null } | null;
      translationDigital?: { id: number; conditionNo: string | null } | null; };

/** 許諾セットの1行。利用形態ごとの料率と独占性。 */
export interface LicenseSetRow {
  usageType: ConditionUsageType;
  /** 計算方式。省略は売上料率。定額なら flatAmount が要る。 */
  pricingModel?: "revenue_rate" | "fixed" | null;
  /** 定額（最小通貨単位）。計算方式が定額のとき。 */
  flatAmount?: number | null;
  /** 料率（%）。 */
  ratePct: number;
  exclusivity?: "exclusive" | "non_exclusive" | null;
  mgAmount?: number | null;
  agAmount?: number | null;
  /** 再許諾先の名称（条件名に入る）。対象の許諾先を選べばその名前が入る。 */
  sublicensee?: string | null;
  /** 対象の許諾先（A-063）。この許諾先だけに効く料率のとき。空なら一律。 */
  targetPartyId?: number | null;
  /** 再許諾の目的。条件名に入る。 */
  purpose?: string | null;
  /** 再許諾の別途合意（A-033）。翻訳版の条文と一覧の印が出し分かれる。 */
  sublicenseConsent?: "covered" | "required" | null;
  /** 許諾料の扱い（A-048）。included / free のときは率が無くてもよい。 */
  licenseFeeBasis?: LicenseFeeBasis | null;
}
export interface LicenseSetInput {
  matterId?: number | null;
  /**
   * 条件名の手入力。空なら規則（作品名｜取引モデル）で行ごとに付ける。
   * 作品が無いときだけ必須（作品名が無いと規則で付けられない）。
   */
  title?: string | null;
  counterpartyId: number;
  agreementId?: number | null;
  workId?: number | null;
  workPartId?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  /** 自動更新（A-039）。期間は束で1つなので、更新も束で決める。 */
  autoRenew?: boolean | null;
  renewMonths?: number | null;
  renewStoppedOn?: string | null;
  currency?: string;
  taxCategory?: "taxable" | "reduced" | "exempt" | "included";
  paymentTerms?: string | null;
  /** 再許諾の可否（束で 1 つ）。条件書の再許諾条項がここから決まる。 */
  sublicensable?: boolean | null;
  /** 再許諾の承諾の要否の既定（行に無いときに使う）。 */
  sublicenseConsentDefault?: "covered" | "required" | null;
  /** 計算書の出し方（periodic=締めごと / event=製造ごと）。束で 1 つ。 */
  statementTiming?: "periodic" | "event" | null;
  notes?: string | null;
  scopes?: ConditionScope[];
  rows: LicenseSetRow[];
}
export interface LicenseSetResult {
  conditions: Array<{ usageType: ConditionUsageType; id: number; conditionNo: string | null }>;
}

/** 業務セット（業務委託）の1行。委託料・実費・手数料。1 行＝条件明細 1 本。 */
export interface ServiceSetRow {
  kind: "service" | "expense" | "fee";
  /** 空なら業務名から付ける（「◯◯ 実費」）。委託料の行が複数なら必須（品目名）。 */
  name?: string | null;
  pricingModel?: "fixed" | "unit_rate";
  flatAmount?: number | null;
  unitAmount?: number | null;
  quantity?: number | null;
  /** 数量の単位（式・P・個）。A-066 */
  unitLabel?: string | null;
  spec?: string | null;
  notes?: string | null;
  /** 行ごとの上書き。空なら束の既定。 */
  deliveryDue?: string | null;
  contractForm?: string | null;
  deliverableOwnership?: "orderer" | "contractor" | null;
  taxCategory?: "taxable" | "reduced" | "exempt" | "included" | null;
  /**
   * 行の作品。未指定（undefined）なら束の作品、null なら作品なし。
   * 1つの発注で複数作品の素材を頼むことがあるので、行ごとに持てる。
   */
  workId?: number | null;
}

/**
 * 帰属先が受注者の行があるときの利用許諾条件（当社が成果物を使うための IN 条件）。
 * mode=none なら立てない（例外用。発注書に許諾条項が出ず、台帳からも見えない）。
 */
export interface ServiceLicenseInput {
  mode: "separate" | "included" | "free" | "none";
  workId?: number | null;
  usageType?: ConditionUsageType | null;
  ratePct?: number | null;
  flatAmount?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  scopes?: ConditionScope[];
}

/** 支払方法。定期払いは委託料の各条件に期ごとの予定明細を立てる。 */
export interface ServicePaymentInput {
  mode: "per_delivery" | "periodic" | "lump";
  periodicFrom?: string | null;
  periodicTo?: string | null;
  everyMonths?: number | null;
}
export interface ServiceSetInput {
  matterId?: number | null;
  /** 業務名。委託料の条件名。 */
  title: string;
  counterpartyId: number;
  agreementId?: number | null;
  workId?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  currency?: string;
  taxCategory?: "taxable" | "reduced" | "exempt" | "included";
  paymentTerms?: string | null;
  contractForm?: string | null;
  deliverableOwnership?: "orderer" | "contractor" | null;
  rows: ServiceSetRow[];
  license?: ServiceLicenseInput | null;
  payment?: ServicePaymentInput | null;
}
export interface ServiceSetResult extends LicenseSetResult {
  /** 帰属先＝受注者の行のために立てた（または既にあった）利用許諾条件。 */
  licenseConditions: Array<{ id: number; conditionNo: string | null; existed: boolean }>;
  /** 定期払いで立てた予定明細の数。 */
  scheduled: number;
}

/**
 * 単価と個数を入れてあれば、定額は掛けて出す。入れた額があればそちらが勝つ
 * （端数の調整や「一式で値引き」を潰さない）。文書の明細の金額欄と同じ扱い。
 */
const flatAmountOf = (input: ConditionInput): number | null =>
  input.flatAmount ?? (
    input.unitAmount !== undefined && input.unitAmount !== null
      && input.quantity !== undefined && input.quantity !== null
      ? roundAmount(input.unitAmount * input.quantity) : null);

/** 登録の入力の検証。トランザクションに入る前に済ませる。 */
function validateConditionInput(input: ConditionInput): void {
  const name = String(input.name ?? "").trim();
  if (!name) throw new DomainError("VALIDATION", "条件名は必須です");
  const pricing = input.pricingModel ?? "none";
  const flatAmount = flatAmountOf(input);
  // 定期課金も金額が要る。flat_amount を「1回あたり」として読むので、
  // 空のまま作ると毎月の額を持たない条件になる（計算も 0 になる）。
  const required: Record<string, unknown> = {
    unit_rate: input.unitAmount, revenue_rate: input.ratePpm,
    fixed: flatAmount, subscription: flatAmount
  };
  if (pricing in required && (required[pricing] === undefined || required[pricing] === null)) {
    const label = { unit_rate: "単価", revenue_rate: "料率", fixed: "定額",
                    subscription: "1回あたりの金額" }[pricing as string];
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
}

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
  /** 再許諾の別途合意（A-033）。covered=不要 / required=要。空は「要」扱い。 */
  sublicenseConsent?: "covered" | "required" | null;
  /** 許諾料の扱い（A-048）。空は separate（別途）。 */
  licenseFeeBasis?: LicenseFeeBasis | null;
  /** 自動更新（A-039）。許諾期間の更新を条件ごとに持つ。更新した回数は導く。 */
  autoRenew?: boolean | null;
  /** 更新の単位（月）。12 = 1年。空は 12 として扱う。 */
  renewMonths?: number | null;
  /** 更新を止めた日。以後は更新しない（その期間は満了まで有効）。 */
  renewStoppedOn?: string | null;
  termStart?: string | null;
  termEnd?: string | null;
  /** 納期。いつまでに納めるか。契約期間の終了日とは別。 */
  deliveryDue?: string | null;
  currency?: string;
  pricingModel?: "fixed" | "unit_rate" | "revenue_rate" | "subscription" | "none";
  ratePpm?: number | null;
  unitAmount?: number | null;
  /** 個数。単価と組で持つ。単価×個数が定額の既定値になる。 */
  quantity?: number | null;
  /** 数量の単位（式・P・個）。発注書の明細に出す（A-066）。 */
  unitLabel?: string | null;
  flatAmount?: number | null;
  mgAmount?: number | null;
  agAmount?: number | null;
  taxCategory?: "taxable" | "reduced" | "exempt" | "included";
  paymentTerms?: string | null;
  /** 計算書の出し方（periodic=締めごと / event=製造ごと）。許諾料の条件だけが持つ。 */
  statementTiming?: "periodic" | "event" | null;
  /** 契約形式（請負・委任など）。支払条件とは別のもの。 */
  contractForm?: string | null;
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
  /** 利用形態（A-027）。出版なら媒体の範囲も同時に入る。 */
  usageType?: ConditionUsageType | null;
  /** 再許諾先の名称・目的。名前が空のとき、規則の条件名に入れる（保存先は名前）。 */
  sublicensee?: string | null;
  purpose?: string | null;
  /** 対象の許諾先（A-063）。この許諾先だけに効く料率のとき。空なら一律。 */
  targetPartyId?: number | null;
}

export interface EconomicsPatch {
  name?: string;
  /** 通貨（ISO 4217）。実績・支払が付く前だけ変えられる（金額の意味が変わるため）。 */
  currency?: string;
  ratePpm?: number | null;
  unitLabel?: string | null;
  flatAmount?: number | null;
  unitAmount?: number | null;
  quantity?: number | null;
  mgAmount?: number | null;
  agAmount?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  /** 納期。いつまでに納めるか。契約期間の終了日とは別。 */
  deliveryDue?: string | null;
  paymentTerms?: string | null;
  contractForm?: string | null;
  taxCategory?: "taxable" | "reduced" | "exempt" | "included";
  notes?: string | null;
  /** 作品と独占性。登録のときに入れられるのに、編集で直せなかった。 */
  workId?: number | null;
  exclusivity?: "exclusive" | "non_exclusive" | null;
  /** 再許諾の別途合意（A-033）。 */
  sublicenseConsent?: "covered" | "required" | null;
  /** 許諾料の扱い（A-048）。 */
  licenseFeeBasis?: LicenseFeeBasis | null;
  /** 自動更新（A-039）。期間そのものは termStart / termEnd。 */
  autoRenew?: boolean | null;
  renewMonths?: number | null;
  renewStoppedOn?: string | null;
  spec?: string | null;
  deliverableOwnership?: "orderer" | "contractor" | null;
  orderNo?: string | null;
  usageType?: ConditionUsageType | null;
  /** 直接編集のときだけ変えられる。種類は案件で使える範囲、計算方式は金額の欄と一緒に。 */
  kind?: "license" | "product" | "service" | "expense" | "fee";
  pricingModel?: "fixed" | "unit_rate" | "revenue_rate" | "subscription" | "none";
  /** 対象の許諾先（A-063）。 */
  targetPartyId?: number | null;
}

const ECONOMICS_COLUMNS: Record<keyof EconomicsPatch, string> = {
  kind: "kind", pricingModel: "pricing_model",
  name: "name", currency: "currency", ratePpm: "rate_ppm", flatAmount: "flat_amount", unitAmount: "unit_amount",
  mgAmount: "mg_amount", agAmount: "ag_amount", termStart: "term_start", termEnd: "term_end",
  deliveryDue: "delivery_due",
  paymentTerms: "payment_terms", taxCategory: "tax_category", notes: "notes",
  quantity: "quantity", unitLabel: "unit_label", contractForm: "contract_form",
  workId: "work_id", exclusivity: "exclusivity", sublicenseConsent: "sublicense_consent",
  licenseFeeBasis: "license_fee_basis",
  autoRenew: "auto_renew", renewMonths: "renew_months", renewStoppedOn: "renew_stopped_on",
  spec: "spec", deliverableOwnership: "deliverable_ownership", orderNo: "order_no",
  usageType: "usage_type",
  targetPartyId: "target_party_id"
};

// 改訂で引き継ぐ列（id・状態・監査列を除く条件の中身すべて）。
const COPY_COLUMNS = [
  "condition_no", "agreement_id", "parent_id", "direction", "kind", "name", "counterparty_id",
  "work_id", "work_part_id", "exclusivity", "sublicensable", "sublicense_consent", "license_fee_basis", "term_start", "term_end", "delivery_due",
  "currency", "pricing_model", "rate_ppm", "unit_amount", "flat_amount", "mg_amount", "ag_amount",
  "royalty_base", "deductible_costs", "tax_category", "withholding_note", "payment_terms",
  "cycle", "notes", "series_id", "effective_from", "spec", "deliverable_ownership", "order_no",
  "quantity", "unit_label", "contract_form", "auto_renew", "renew_months", "renew_stopped_on",
  // 利用形態も版をまたいで引き継ぐ（落とすと改訂した許諾条件が形態なしになる）。
  "usage_type",
  // 計算書の出し方（A-059）。改訂しても時限式・イベント式は変わらない。
  "statement_timing",
  // 対象の許諾先（A-063）。
  "target_party_id"
];

/**
 * 定期払いの予定明細。from から to まで every か月ごとに 1 回。回ごとの役務提供期間を持ち、
 * 発生日はその期の末日。支払期日は支払条件から（schedule-service が導く）。
 */
export function periodicLines(from: string, to: string, everyMonths: number, amount: number, label: string): ScheduleLine[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const lines: ScheduleLine[] = [];
  let seq = 1;
  let cursor = new Date(start);
  while (cursor <= end && lines.length < 120) {
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + everyMonths);
    const periodEnd = new Date(next); periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);
    const serviceTo = periodEnd > end ? end : periodEnd;
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    lines.push({
      seq, label: `${label} ${iso(cursor).slice(0, 7)}`, triggerKind: "periodic", plannedAmount: amount,
      dueOn: iso(serviceTo), payOn: null, serviceFrom: iso(cursor), serviceTo: iso(serviceTo)
    });
    seq += 1; cursor = next;
  }
  return lines;
}

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
    try {
      return await inTransaction(this.database, async (client) => {
        // 作品に紐づく許諾（IN）の条件名は規則で付ける（作品名｜取引モデル）。
        // 画面は名前を打たせず利用形態を選ばせる。名前が来ていればそれを尊重する。
        if (!String(input.name ?? "").trim() && input.kind === "license" && input.direction === "in"
            && input.workId && input.usageType) {
          const w = await client.query("SELECT title FROM works WHERE id = $1", [input.workId]);
          // 対象の許諾先を選んでいれば、その名前を条件名に入れる（許諾先専用と分かる）。
          let sublicensee = input.sublicensee ?? null;
          if (!String(sublicensee ?? "").trim() && input.targetPartyId) {
            const tp = await client.query("SELECT name FROM parties WHERE id = $1", [input.targetPartyId]);
            if (!tp.rows[0]) throw new DomainError("NOT_FOUND", `対象の許諾先 ${input.targetPartyId} が見つかりません`);
            sublicensee = String((tp.rows[0] as { name: string }).name);
          }
          const made = conditionNameFor({ workTitle: (w.rows[0] as { title?: string } | undefined)?.title ?? "",
                                          usageType: input.usageType,
                                          sublicensee, purpose: input.purpose });
          if (!made) throw new DomainError("VALIDATION", `作品 ${input.workId} が見つかりません`);
          input = { ...input, name: made };
        }
        validateConditionInput(input);
        return this.createWithin(client, input, actor);
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 許諾の条件を作品1点ぶんまとめて登録する。利用形態ごとに1本。
   *
   * 条件は利用形態ごとに1本（料率1つ）で持つ。実績・計算・支払・改訂が
   * 条件1本を軸に回るので、まとめて1本にはしない。代わりに登録を1回で
   * 済ませ、同じトランザクションで N 本作る（1本だけできて残りが落ちない）。
   * 条件書は一組（契約×作品）を1行に畳んで出す。
   *
   * 同じ作品・同じ相手先に同じ利用形態の生きた条件が既にあれば止める。
   * 2本あると条件書のどちらの料率を載せるか決められない（改定は既存の
   * 条件を直す・改訂する）。
   */
  async createLicenseSet(input: LicenseSetInput, actor: string): Promise<LicenseSetResult> {
    const title = String(input.title ?? "").trim();
    if (!title && !input.workId) {
      throw new DomainError("VALIDATION", "作品を選んでください（条件名は 作品名｜取引モデル で自動で付きます）。作品に紐づかない条件なら条件名を入れてください");
    }
    const rows = (input.rows ?? []).filter((r) => r && r.usageType);
    if (!rows.length) throw new DomainError("VALIDATION", "利用形態を1つ以上選び、料率を入れてください");
    for (const row of rows) {
      // 許諾料の扱い（A-048）が「含む」「無償」なら率は無くてよい（0 として持つ）。
      if (row.licenseFeeBasis && row.licenseFeeBasis !== "separate") {
        row.ratePct = Number(row.ratePct) || 0;
        row.mgAmount = null; row.agAmount = null;
      }
      if (row.pricingModel === "fixed") {
        if (row.flatAmount == null || !Number.isFinite(Number(row.flatAmount)) || Number(row.flatAmount) < 0) {
          throw new DomainError("VALIDATION", `${conditionUsageLabel(row.usageType)}は定額なので、定額の金額を入れてください`);
        }
        row.ratePct = 0;
        continue;
      }
      const rate = Number(row.ratePct);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        throw new DomainError("VALIDATION", `${conditionUsageLabel(row.usageType)}の料率は 0〜100（%）で入れてください`);
      }
    }
    // 対象の許諾先の名前を条件名に入れる（A-063）。
    const targetNames = new Map<number, string>();
    for (const row of rows) {
      if (row.targetPartyId && !String(row.sublicensee ?? "").trim() && !targetNames.has(row.targetPartyId)) {
        const tp = await this.database.query("SELECT name FROM parties WHERE id = $1", [row.targetPartyId]);
        if (!tp.rows[0]) throw new DomainError("NOT_FOUND", `対象の許諾先 ${row.targetPartyId} が見つかりません`);
        targetNames.set(row.targetPartyId, String((tp.rows[0] as { name: string }).name));
      }
    }
    for (const row of rows) {
      if (row.targetPartyId && !String(row.sublicensee ?? "").trim()) row.sublicensee = targetNames.get(row.targetPartyId) ?? null;
    }
    const scopes = (input.scopes ?? []).filter((s) => s.scopeType !== "media");
    // 作品名は取引の中で取る（規則で名前を付けるため）。手入力の名前があればそれが勝つ。
    const nameOf = (row: LicenseSetRow, workTitle: string | null): string => {
      if (title) return title;
      const made = conditionNameFor({ workTitle: workTitle ?? "", usageType: row.usageType,
                                      sublicensee: row.sublicensee, purpose: row.purpose });
      if (!made) throw new DomainError("VALIDATION", `条件名を付けられません（作品名が空）`);
      return made;
    };
    // 同じ利用形態が2回：再許諾は相手・目的が違えば別の条件なので、名前で比べる。
    const seen = new Set<string>();
    // 再許諾・他社販売は、対象の許諾先（無ければ一律）が違えば別の条件。
    const dupKey = (row: LicenseSetRow) => (row.usageType === "sublicense" || row.usageType === "oem")
      ? `${row.usageType}:${row.targetPartyId ?? String(row.sublicensee ?? "").trim()}:${String(row.purpose ?? "").trim()}` : row.usageType;
    for (const row of rows) {
      const key = dupKey(row);
      if (seen.has(key)) {
        throw new DomainError("VALIDATION", `${conditionUsageLabel(row.usageType)}${row.usageType === "sublicense" ? "（同じ再許諾先・目的）" : ""}が2回入っています`);
      }
      seen.add(key);
    }
    const inputs = rows.map((row): ConditionInput => ({
      matterId: input.matterId ?? null,
      name: title || "（作品名から付ける）",
      direction: "in",
      kind: "license",
      counterpartyId: input.counterpartyId,
      agreementId: input.agreementId ?? null,
      workId: input.workId ?? null,
      workPartId: input.workPartId ?? null,
      exclusivity: row.exclusivity ?? null,
      termStart: input.termStart ?? null,
      termEnd: input.termEnd ?? null,
      autoRenew: input.autoRenew ?? null,
      renewMonths: input.renewMonths ?? null,
      renewStoppedOn: input.renewStoppedOn ?? null,
      currency: input.currency ?? "JPY",
      pricingModel: row.pricingModel === "fixed" ? "fixed" : "revenue_rate",
      // 画面は % で受け、保存は ppm（百万分率）。11% → 110000
      ratePpm: row.pricingModel === "fixed" ? null : Math.round(Number(row.ratePct) * 10000),
      flatAmount: row.pricingModel === "fixed" ? Math.round(Number(row.flatAmount)) : null,
      mgAmount: row.mgAmount ?? null,
      agAmount: row.agAmount ?? null,
      taxCategory: input.taxCategory ?? "taxable",
      paymentTerms: input.paymentTerms ?? null,
      sublicensable: input.sublicensable ?? null,
      statementTiming: input.statementTiming ?? null,
      notes: input.notes ?? null,
      scopes,
      usageType: row.usageType,
      targetPartyId: row.targetPartyId ?? null,
      sublicenseConsent: row.sublicenseConsent ?? input.sublicenseConsentDefault ?? null,
      licenseFeeBasis: row.licenseFeeBasis ?? null
    }));
    for (const one of inputs) validateConditionInput(one);

    try {
      return await inTransaction(this.database, async (client) => {
        let workTitle: string | null = null;
        if (input.workId) {
          const w = await client.query("SELECT title FROM works WHERE id = $1", [input.workId]);
          workTitle = (w.rows[0] as { title?: string } | undefined)?.title ?? null;
          if (!title && !workTitle) throw new DomainError("NOT_FOUND", `作品 ${input.workId} が見つかりません`);
        }
        for (const [index, one] of inputs.entries()) one.name = nameOf(rows[index], workTitle);
        if (input.workId) {
          // 同じ作品・相手先の生きた条件の利用形態。列が空の古い条件は媒体の範囲から読む。
          // 再許諾は相手・目的ごとに別の条件なので、名前が同じときだけ重複とみなす。
          const existing = await client.query(
            `SELECT c.condition_no, c.usage_type, c.name,
                    (SELECT array_agg(coalesce(s.code, s.label)) FROM condition_scopes s
                      WHERE s.condition_id = c.id AND s.scope_type = 'media') AS media
               FROM conditions c
              WHERE c.work_id = $1 AND c.counterparty_id = $2 AND c.direction = 'in'
                AND c.status IN ('active', 'scheduled')`,
            [input.workId, input.counterpartyId]);
          for (const row of existing.rows as Array<{ condition_no: string | null; usage_type: string | null; name?: string | null; media: string[] | null }>) {
            const held: string | null = row.usage_type
              ?? (() => { const m = pubMediaOf((row.media ?? [])[0]); return m ? usageOfPubMedia(m) : null; })();
            const clash = held
              ? rows.find((r, i) => r.usageType === held
                  && (held !== "sublicense" || String(row.name ?? "").trim() === inputs[i].name))
              : undefined;
            if (clash) {
              throw new DomainError("CONFLICT",
                `この作品には同じ相手先の${conditionUsageLabel(clash.usageType)}の条件（${row.condition_no ?? "番号なし"}）が既にあります。`
                + "料率を変えるならその条件を直してください");
            }
          }
        }
        const out: LicenseSetResult = { conditions: [] };
        for (const [index, one] of inputs.entries()) {
          const created = await this.createWithin(client, one, actor);
          out.conditions.push({ usageType: rows[index].usageType, ...created });
        }
        return out;
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 出版の条件を作品1点ぶんまとめて登録する。紙と電子で条件2本（どちらか
   * 1本でもよい）。許諾セットの特例で、同じ実装を通る。
   */
  async createPublishingSet(input: PublishingSetInput, actor: string): Promise<PublishingSetResult> {
    if (!input.print && !input.digital && !input.sublicense
        && !input.translationPrint && !input.translationDigital) {
      throw new DomainError("VALIDATION", "紙・電子・翻訳版・再許諾のどれかの料率を入れてください");
    }
    const rows: LicenseSetRow[] = [];
    if (input.print) rows.push({ usageType: "pub_print", ratePct: input.print.ratePct, exclusivity: input.print.exclusivity ?? null });
    if (input.digital) rows.push({ usageType: "pub_digital", ratePct: input.digital.ratePct, exclusivity: input.digital.exclusivity ?? null });
    if (input.sublicense) {
      rows.push({ usageType: "sublicense", ratePct: input.sublicense.ratePct, exclusivity: input.sublicense.exclusivity ?? null,
                  sublicensee: input.sublicense.sublicensee ?? null, purpose: input.sublicense.purpose ?? null,
                  targetPartyId: input.sublicense.targetPartyId ?? null });
    }
    // 翻訳版の再許諾（A-033）。紙・電子で1本ずつ。
    for (const [usage, terms] of [["pub_sub_print", input.translationPrint],
                                  ["pub_sub_digital", input.translationDigital]] as const) {
      if (!terms) continue;
      rows.push({ usageType: usage, ratePct: terms.ratePct, exclusivity: terms.exclusivity ?? null,
                  sublicensee: terms.sublicensee ?? null, purpose: terms.purpose ?? null,
                  sublicenseConsent: terms.consent ?? null });
    }
    const { print: _p, digital: _d, sublicense: _s,
            translationPrint: _tp, translationDigital: _td, ...rest } = input;
    const made = await this.createLicenseSet({ ...rest, rows }, actor);
    const pick = (usage: ConditionUsageType) => {
      const found = made.conditions.find((c) => c.usageType === usage);
      return found ? { id: found.id, conditionNo: found.conditionNo } : null;
    };
    return { print: pick("pub_print"), digital: pick("pub_digital"), sublicense: pick("sublicense"),
             translationPrint: pick("pub_sub_print"), translationDigital: pick("pub_sub_digital") };
  }

  /**
   * 業務委託の条件を業務1つぶんまとめて登録する。委託料（定額／単価×数量）に
   * 実費・手数料を足して N 本。同じトランザクションで作り、案件にも繋ぐ。
   * 発注書はこの組を1枚に載せる。
   */
  async createServiceSet(input: ServiceSetInput, actor: string): Promise<ServiceSetResult> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "業務名（委託料の条件名）は必須です");
    const rows = (input.rows ?? []).filter((r) => r && r.kind);
    const serviceRows = rows.filter((r) => r.kind === "service");
    if (!serviceRows.length) {
      throw new DomainError("VALIDATION", "委託料の行を1つ入れてください（実費・手数料だけの業務は作れません）");
    }
    // 委託料の行が複数なら、行ごとに品目名が要る（全部が業務名だと見分けられない）。
    if (serviceRows.length > 1 && serviceRows.some((r) => !String(r.name ?? "").trim())) {
      throw new DomainError("VALIDATION", "委託料の行が複数あるときは、行ごとに品目名を入れてください");
    }
    const workOf = (row: ServiceSetRow): number | null =>
      row.workId !== undefined ? row.workId : (input.workId ?? null);
    const ownershipOf = (row: ServiceSetRow) =>
      row.kind === "service" ? (row.deliverableOwnership ?? input.deliverableOwnership ?? null) : null;
    const inputs = rows.map((row): ConditionInput => {
      const pricing = row.pricingModel ?? "fixed";
      return {
        matterId: input.matterId ?? null,
        name: String(row.name ?? "").trim() || (row.kind === "service" ? title
          : row.kind === "expense" ? `${title} 実費` : `${title} 手数料`),
        direction: "in",
        kind: row.kind,
        counterpartyId: input.counterpartyId,
        agreementId: input.agreementId ?? null,
        workId: workOf(row),
        termStart: input.termStart ?? null,
        termEnd: input.termEnd ?? null,
        // 納期は行ごと。無ければ束の終了日。
        deliveryDue: row.deliveryDue ?? input.termEnd ?? null,
        currency: input.currency ?? "JPY",
        pricingModel: pricing,
        flatAmount: row.flatAmount ?? null,
        unitAmount: row.unitAmount ?? null,
        quantity: row.quantity ?? null,
        unitLabel: row.unitLabel ?? null,
        // 経費は税込の実費で受けるので消費税を重ねない。
        taxCategory: row.kind === "expense" ? "exempt" : (row.taxCategory ?? input.taxCategory ?? "taxable"),
        paymentTerms: input.paymentTerms ?? null,
        contractForm: row.kind === "service" ? (row.contractForm ?? input.contractForm ?? null) : null,
        spec: row.spec ?? null,
        deliverableOwnership: ownershipOf(row),
        notes: row.notes ?? null
      };
    });
    for (const one of inputs) validateConditionInput(one);

    // 帰属先＝受注者の行があれば、当社が使うための利用許諾条件（IN）を作品×受注者に立てる。
    // 行ごとに作品が違えば作品ごとに1本（作品の無い行は許諾の作品で補う）。
    const contractorRows = rows.filter((r) => ownershipOf(r) === "contractor");
    const license = input.license ?? null;
    const licenseInputs: ConditionInput[] = [];
    if (contractorRows.length && license && license.mode !== "none") {
      const fallback = license.workId ?? input.workId ?? null;
      const workIds: number[] = [];
      for (const row of contractorRows) {
        const w = workOf(row) ?? fallback;
        if (!w) throw new DomainError("VALIDATION", "受注者帰属の成果物の利用許諾条件には作品が要ります（行に作品を入れるか、作品を登録するか、「条件を立てない」を選ぶ）");
        if (!workIds.includes(w)) workIds.push(w);
      }
      const usageType: ConditionUsageType = license.usageType ?? "in_house";
      const basis: LicenseFeeBasis = license.mode;
      const ratePct = basis === "separate" ? license.ratePct ?? null : null;
      const flat = basis === "separate" && ratePct == null ? license.flatAmount ?? null : null;
      if (basis === "separate" && ratePct == null && flat == null) {
        throw new DomainError("VALIDATION", "許諾料を別途にするなら、料率か定額を入れてください");
      }
      for (const workId of workIds) {
        const one: ConditionInput = {
          matterId: input.matterId ?? null, name: "（作品名から付ける）", direction: "in", kind: "license",
          counterpartyId: input.counterpartyId, agreementId: input.agreementId ?? null, workId,
          usageType, licenseFeeBasis: basis,
          pricingModel: ratePct != null ? "revenue_rate" : flat != null ? "fixed" : "none",
          ratePpm: ratePct != null ? Math.round(ratePct * 10000) : null,
          flatAmount: flat, currency: input.currency ?? "JPY",
          termStart: license.termStart ?? input.termStart ?? null, termEnd: license.termEnd ?? null,
          exclusivity: "non_exclusive",
          scopes: license.scopes?.length ? license.scopes : undefined,
          notes: `業務委託（${title}）の成果物の利用許諾。許諾料の扱い：${
            basis === "separate" ? "別途" : basis === "included" ? "委託報酬に含む" : "無償"}`
        };
        validateConditionInput(one);
        licenseInputs.push(one);
      }
    }

    let result: ServiceSetResult;
    try {
      result = await inTransaction(this.database, async (client) => {
        const out: ServiceSetResult = { conditions: [], licenseConditions: [], scheduled: 0 };
        for (const [index, one] of inputs.entries()) {
          const made = await this.createWithin(client, one, actor);
          out.conditions.push({ usageType: rows[index].kind as unknown as ConditionUsageType, ...made });
        }
        for (const licenseInput of licenseInputs) {
          const w = await client.query("SELECT title FROM works WHERE id = $1", [licenseInput.workId]);
          const workTitle = (w.rows[0] as { title?: string } | undefined)?.title ?? null;
          if (!workTitle) throw new DomainError("NOT_FOUND", `作品 ${licenseInput.workId} が見つかりません`);
          licenseInput.name = conditionNameFor({ workTitle, usageType: licenseInput.usageType! }) ?? `${workTitle}｜利用許諾`;
          // 同じ作品 × 受注者 × 利用形態の生きた条件があれば作らず、それを返す。
          const existing = await client.query(
            `SELECT id, condition_no FROM conditions
              WHERE work_id = $1 AND counterparty_id = $2 AND direction = 'in' AND kind = 'license'
                AND usage_type = $3 AND status IN ('active', 'scheduled') LIMIT 1`,
            [licenseInput.workId, input.counterpartyId, licenseInput.usageType]);
          const found = existing.rows[0] as { id: number; condition_no: string | null } | undefined;
          if (found) out.licenseConditions.push({ id: Number(found.id), conditionNo: found.condition_no, existed: true });
          else {
            const made = await this.createWithin(client, licenseInput, actor);
            out.licenseConditions.push({ ...made, existed: false });
          }
        }
        return out;
      });
    } catch (error) { throw translate(error); }

    // 定期払い：委託料の各条件に期ごとの予定明細。条件はもうあるので、別のトランザクションでよい。
    const payment = input.payment ?? null;
    if (payment?.mode === "periodic" && payment.periodicFrom && payment.periodicTo) {
      const every = Math.max(1, Math.trunc(Number(payment.everyMonths ?? 1) || 1));
      const schedules = new ConditionScheduleService(this.database);
      for (const [index, row] of rows.entries()) {
        if (row.kind !== "service") continue;
        const made = result.conditions[index];
        const amount = Number(row.flatAmount ?? (Number(row.unitAmount ?? 0) * Number(row.quantity ?? 1))) || 0;
        const lines = periodicLines(payment.periodicFrom, payment.periodicTo, every, amount, inputs[index].name);
        if (!lines.length) continue;
        await schedules.replace(made.id, lines, actor);
        result.scheduled += lines.length;
      }
    }
    return result;
  }

  /** 条件1本の INSERT。トランザクションは呼ぶ側が持つ（セット登録・文書の決定から使う）。 */
  async createWithin(client: Queryable, input: ConditionInput, actor: string)
    : Promise<{ id: number; conditionNo: string | null }> {
    const name = String(input.name ?? "").trim();
    const pricing = input.pricingModel ?? "none";
    const flatAmount = flatAmountOf(input);
    {
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
                                   work_id, work_part_id, exclusivity, sublicensable, sublicense_consent,
                                   term_start, term_end, delivery_due, currency, pricing_model,
                                   rate_ppm, unit_amount, flat_amount, mg_amount, ag_amount,
                                   tax_category, payment_terms, cycle, status, notes,
                                   spec, deliverable_ownership, order_no,
                                   quantity, contract_form, usage_type,
                                   auto_renew, renew_months, renew_stopped_on, license_fee_basis,
                                   target_party_id, statement_timing, unit_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21, $22, $23, $24, 'active', $25, $26, $27, $28,
                   $29, $30, $31, $32, $33, $34, $35, $36, $37, $38)
           RETURNING id, condition_no`,
          [no, input.agreementId ?? null, input.direction, input.kind, name, input.counterpartyId,
           input.workId ?? null, input.workPartId ?? null,
           input.exclusivity ?? null, input.sublicensable ?? null, input.sublicenseConsent ?? null,
           input.termStart ?? null, input.termEnd ?? null, input.deliveryDue ?? null,
           input.currency ?? "JPY", pricing,
           input.ratePpm ?? null, input.unitAmount ?? null, flatAmount,
           input.mgAmount ?? null, input.agAmount ?? null,
           input.taxCategory ?? "taxable", input.paymentTerms ?? null, input.cycle ?? null,
           input.notes ?? null, input.spec ?? null, input.deliverableOwnership ?? null,
           input.orderNo ?? null,
           input.quantity ?? null, readContractForm(input.contractForm), input.usageType ?? null,
           input.autoRenew ?? null, input.renewMonths ?? null, input.renewStoppedOn ?? null,
           input.licenseFeeBasis ?? "separate",
           input.targetPartyId ?? null, input.statementTiming ?? null,
           String(input.unitLabel ?? "").trim() || null]);
        const row = inserted.rows[0] as { id: number; condition_no: string | null };
        const id = Number(row.id);

        // 許諾範囲。1件も入れなければ、その次元は無制限として扱われる。
        // 出版の利用形態は媒体の範囲も一緒に入れる（古い読み手は範囲を見る）。
        const scopes: ConditionScope[] = [...(input.scopes ?? [])];
        const media = pubMediaOfUsage(input.usageType);
        if (media && !scopes.some((s) => s.scopeType === "media")) {
          scopes.push({ scopeType: "media", label: PUB_MEDIA_LABEL[media], code: media });
        }
        for (const [index, scope] of scopes.entries()) {
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
    }
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
  /**
   * 契約期間の更新。終了日を新しい日付に伸ばす。
   *
   * 実績・支払が無ければその場で書き換え、支払が立っていれば改訂（新版）にする。
   * 料率・締めは変えない。台帳の条件の一覧から、1本ずつでもまとめてでも押せる。
   */
  async renewTerm(id: number, newEnd: string, actor: string, reason?: string | null):
    Promise<{ id: number; conditionNo: string | null; mode: "in_place" | "revised"; from: string | null; to: string }> {
    try {
      const before = await this.database.query(
        "SELECT id, condition_no, status, term_end FROM conditions WHERE id = $1", [id]);
      const row = before.rows[0] as { condition_no: string | null; status: string; term_end: unknown } | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
      const from = dateStr(row.term_end);
      if (from && newEnd <= from) {
        throw new DomainError("VALIDATION", `新しい終了日 ${newEnd} は、いまの終了日 ${from} より後にしてください`);
      }
      const why = String(reason ?? "").trim() || `契約期間の更新（${from ?? "期限なし"} → ${newEnd}）`;
      let mode: "in_place" | "revised" = "in_place";
      try {
        await this.updateEconomics(id, { termEnd: newEnd }, actor, null, { inPlace: true });
      } catch (error) {
        // 支払が立っている条件は直接書き換えられない。改訂（新版）で伸ばす。
        if (!(error instanceof DomainError && error.code === "CONFLICT" && /支払が立っている/.test(error.message))) throw error;
        await this.updateEconomics(id, { termEnd: newEnd }, actor, null);
        mode = "revised";
      }
      await recordAudit(this.database, {
        actor, action: "condition.renew_term", targetType: "condition", targetId: id,
        detail: { from, to: newEnd, mode, reason: why }
      });
      return { id, conditionNo: row.condition_no, mode, from, to: newEnd };
    } catch (error) { throw translate(error); }
  }

  async updateEconomics(
    id: number, patch: EconomicsPatch, actor: string, effectiveFrom?: string | null,
    options: { inPlace?: boolean } = {}
  ): Promise<WriteResult> {
    const entries = (Object.keys(patch) as Array<keyof EconomicsPatch>)
      .filter((key) => patch[key] !== undefined)
      .map((key) => ({ column: ECONOMICS_COLUMNS[key], value: patch[key] as unknown }));
    if (!entries.length) throw new DomainError("VALIDATION", "変更する項目がありません");
    // 種類と計算方式は直接編集のときだけ。改訂で変えると、過去の計算根拠が別物になる。
    if ((patch.kind !== undefined || patch.pricingModel !== undefined) && !options.inPlace) {
      throw new DomainError("VALIDATION", "種類と計算方式は「直接編集」のときだけ変えられます");
    }

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
        // 通貨は、その条件（版をまたいで）に実績や支払が付いていない間だけ変えられる。
        // 付いたあとに変えると、記録済みの金額が別の通貨として読まれる。
        if (patch.currency !== undefined && patch.currency !== before.currency) {
          await this.assertCurrencyChangeable(client, id, before.series_id ?? null);
        }

        // 直接編集：実績や文書があっても改訂にせず、その場で書き換える。
        // 台帳の整理（移行データの直し）のための口。支払が立っている条件は断る
        // （払った額の根拠が書き換わる）。決定済みの文書は焼き付いた値のまま残る。
        if (options.inPlace) {
          const paid = await client.query(
            `SELECT string_agg(DISTINCT COALESCE(y.payment_no, '#' || y.id::text), '・') AS nos, count(DISTINCT y.id)::int AS n
               FROM payment_allocations al
               JOIN payments y ON y.id = al.payment_id
              WHERE y.status <> 'canceled'
                AND al.condition_id IN (SELECT x.id FROM conditions x
                                         WHERE COALESCE(x.series_id, x.id) = COALESCE($2::bigint, $1::bigint))`,
            [id, before.series_id ?? null]);
          const row = paid.rows[0] as { nos: string | null; n: number } | undefined;
          if (row && Number(row.n) > 0) {
            throw new DomainError("CONFLICT",
              `支払が立っているので直接編集できません（${row.nos ?? ""}）。支払を取り消すか、改訂で直してください`);
          }
          if (patch.kind !== undefined) await this.assertKindAllowed(client, id, patch.kind);
          const result = await this.updateInPlace(client, id, entries, actor,
            effectiveFrom ? { effective_from: effectiveFrom } : {});
          await recordAudit(client, {
            actor, action: "condition.update", targetType: "condition", targetId: id,
            detail: { patch, mode: "in_place_forced" }
          });
          return result;
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
   * 共著の取り分の置き換え（A-068。docs/royalty-shares.md）。
   *
   * 取り分は「条件の全体率を、当社から直接払う権利者ごとに何 % に分けるか」。
   * 代表 1 者が受け取って自分で分配する契約は、ここでは何も持たない（空にする）。
   *
   * 取得（IN）の料率の許諾条件にだけ付けられる。MG・AG のある条件には付けない。
   * 受取人ごとの計算書で前払保証の消化を分けて数える道がまだ無く、二重に相殺
   * されるおそれがあるため。付けたいときは MG・AG を外してから。
   */
  async replaceShares(
    id: number, shares: Array<{ partyId: number; sharePpm: number; note?: string | null }>, actor: string,
    /** 分配を誰がするか（A-070）。空は direct。取り分が空なら意味を持たない（null にする）。 */
    distribution: "direct" | "representative" | null = null
  ): Promise<WriteResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        const existing = await this.repository.requireExisting(client, id);
        const head = (await client.query(
          "SELECT direction, kind, pricing_model, mg_amount, ag_amount FROM conditions WHERE id = $1", [id]
        )).rows[0] as Record<string, any> | undefined;
        if (!head) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
        const rows = shares.map((s) => ({ partyId: Number(s.partyId), sharePpm: Number(s.sharePpm),
                                          note: String(s.note ?? "").trim() || null }));
        validateShareInput(rows);
        if (rows.length) {
          if (head.direction !== "in" || head.kind !== "license") {
            throw new DomainError("VALIDATION", "取り分を付けられるのは、取得（IN）の許諾条件だけです");
          }
          if (head.pricing_model !== "revenue_rate") {
            throw new DomainError("VALIDATION", "取り分を付けられるのは料率の条件だけです（買い切りは定額の条件 1 本で持ちます）");
          }
          // 代表が分配する契約は、計算書も支払も相手先 1 件のまま。前払保証の消化も分けないので MG・AG があってよい。
          if (distribution !== "representative" && (Number(head.mg_amount ?? 0) > 0 || Number(head.ag_amount ?? 0) > 0)) {
            throw new DomainError("VALIDATION", "MG・AG のある条件には取り分を付けられません。先に MG・AG を外してください");
          }
          if (distribution === "representative" && !rows.some((r) => r.partyId === Number(existing.counterparty_id))) {
            throw new DomainError("VALIDATION", "代表が分配する契約では、条件の相手先（代表）を取り分の中に入れてください");
          }
          const found = await client.query(
            "SELECT id FROM parties WHERE id = ANY($1::bigint[])", [rows.map((r) => r.partyId)]);
          if ((found.rows as Array<{ id: number }>).length !== rows.length) {
            throw new DomainError("NOT_FOUND", "取り分の権利者に、登録の無い取引先が混ざっています");
          }
        }
        const removed = await client.query("DELETE FROM condition_shares WHERE condition_id = $1", [id]);
        const mode = rows.length ? (distribution === "representative" ? "representative" : "direct") : null;
        await client.query("UPDATE conditions SET distribution = $2, updated_at = now() WHERE id = $1", [id, mode]);
        let written = 0;
        for (const [index, row] of rows.entries()) {
          const r = await client.query(
            `INSERT INTO condition_shares (condition_id, party_id, share_ppm, sort_order, note)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, row.partyId, row.sharePpm, index, row.note]);
          written += r.rowCount ?? 0;
        }
        await recordAudit(client, {
          actor, action: "condition.replace_shares", targetType: "condition", targetId: id,
          detail: { removed: removed.rowCount ?? 0, written, distribution: mode,
                    shares: rows.map((r) => ({ partyId: r.partyId, sharePpm: r.sharePpm })) }
        });
        return {
          changed: [{ target: "condition_shares", rows: written }],
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
  /**
   * 条件の無効化。削除の1段目。
   *
   * 行は消さない。状態を void にして理由を残す。無効化した条件は一覧・
   * アウト条件の候補・文書作成から消え、編集も実績の追加もできなくなる。
   * 発行済みの文書や支払は、この条件を今までどおり指し続ける（紙に出た
   * 事実は変わらない）。
   *
   * 消してよいかどうかは、この段階では問わない。参照があっても無効化は
   * できる。参照の無いものだけが、次の段（remove）で本当に消える。
   */
  /**
   * 完了扱いにする（A-028）。
   *
   * 支払済みは事実（割当）から導くのが本筋で、これは V1・V2 で払い終えて V3 に
   * 支払の記録が無い条件などを、理由つきで閉じる口。状態は変えない（active の
   * まま）。実績や文書は今までどおり作れるが、一覧と候補では「完了」に畳まれる。
   */
  async close(id: number, reason: string, actor: string): Promise<WriteResult> {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "完了扱いにする理由は必須です（V2 で支払済み など）");
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await this.repository.requireExisting(client, id);
        if (before.status === "void" || before.status === "superseded") {
          throw new DomainError("CONFLICT", "無効化または改訂済みの条件は完了扱いにできません");
        }
        const r = await client.query(
          `UPDATE conditions SET closed_at = now(), closed_reason = $2, closed_by = $3, updated_at = now()
            WHERE id = $1 AND closed_at IS NULL RETURNING id`, [id, why, actor]);
        if (!r.rows[0]) throw new DomainError("CONFLICT", "すでに完了扱いです");
        await recordAudit(client, {
          actor, action: "condition.close", targetType: "condition", targetId: id,
          detail: { reason: why, conditionNo: before.condition_no }
        });
        return { changed: [{ target: "conditions（完了扱い）", rows: 1 }], resolvesThrough: [] };
      });
    } catch (error) { throw translate(error); }
  }

  /** 完了扱いを取り消す。閉じた理由は監査に残る。 */
  async reopen(id: number, actor: string): Promise<WriteResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await this.repository.requireExisting(client, id);
        const r = await client.query(
          `UPDATE conditions SET closed_at = NULL, closed_reason = NULL, closed_by = NULL, updated_at = now()
            WHERE id = $1 AND closed_at IS NOT NULL RETURNING id`, [id]);
        if (!r.rows[0]) throw new DomainError("CONFLICT", "完了扱いになっていません");
        await recordAudit(client, {
          actor, action: "condition.reopen", targetType: "condition", targetId: id,
          detail: { conditionNo: before.condition_no }
        });
        return { changed: [{ target: "conditions（完了扱いの取り消し）", rows: 1 }], resolvesThrough: [] };
      });
    } catch (error) { throw translate(error); }
  }

  async void(id: number, reason: string, actor: string): Promise<WriteResult> {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "無効化の理由は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await this.repository.requireExisting(client, id);
        if (before.status === "void") throw new DomainError("CONFLICT", "すでに無効化されています");
        if (before.status === "superseded") {
          throw new DomainError("CONFLICT",
            "旧版の条件は無効化できません。最新版を無効化してください");
        }
        await client.query(
          `UPDATE conditions
              SET status = 'void',
                  notes = concat_ws(E'\n', NULLIF(notes, ''), $2::text),
                  updated_at = now()
            WHERE id = $1`,
          [id, `無効化：${why}`]);
        await recordAudit(client, {
          actor, action: "condition.void", targetType: "condition", targetId: id,
          detail: { reason: why, conditionNo: before.condition_no, was: before.status }
        });
        return {
          changed: [{ target: "conditions（無効化）", rows: 1 }],
          resolvesThrough: await this.countReferences(client, id)
        };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 条件の削除。削除の2段目。
   *
   * 無効化してあるものだけを消す（無効化 → 削除の2段階）。いきなり消せる
   * 作りにすると、押し間違いが取り返せない。
   *
   * 何かがこの条件を指していれば消さない。文書・支払・計算書・実績・案件・
   * 派生条件・他の実績のアウト条件・改訂の系譜。どれも、消すと指す先を
   * 失う。何が指しているかを返し、人が判断できるようにする。
   * 予定明細と許諾範囲は条件の一部なので一緒に消える（ON DELETE CASCADE）。
   */
  async remove(id: number, actor: string, reason?: string): Promise<{ deleted: true; conditionNo: string | null }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await this.repository.requireExisting(client, id);
        if (before.status !== "void") {
          throw new DomainError("VALIDATION",
            "先に無効化してください（無効化 → 削除の2段階）。無効化すると一覧から消え、" +
            "何も指していなければ削除できます");
        }
        const blockers = await this.countDeleteBlockers(client, id);
        if (blockers.length) {
          throw new DomainError("CONFLICT",
            "この条件を指しているものがあるので削除できません：" +
            blockers.map((b) => `${b.target} ${b.rows} 件`).join("、") +
            "。無効化のままにしておいてください");
        }
        await client.query("DELETE FROM conditions WHERE id = $1", [id]);
        // 理由は任意（条件画面の削除は無効化のときに理由を取っている）。
        // 片づけの画面からはまとめて消すので、そのときの理由を残す。
        const why = String(reason ?? "").trim();
        await recordAudit(client, {
          actor, action: "condition.delete", targetType: "condition", targetId: id,
          detail: { conditionNo: before.condition_no, ...(why ? { reason: why } : {}) }
        });
        return { deleted: true, conditionNo: before.condition_no };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 削除を止めるもの。countReferences より広い。
   * あちらは「表示が追随するもの」を数える。こちらは「消すと指す先を失うもの」。
   * 取り消した実績も数える。取り消しの記録がこの条件を指しているため。
   */
  private async countDeleteBlockers(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT
         (SELECT count(*)::int FROM condition_events WHERE condition_id = $1)                   AS events,
         (SELECT count(*)::int FROM condition_events WHERE out_condition_id = $1)               AS out_refs,
         (SELECT count(*)::int FROM document_conditions WHERE condition_id = $1)                AS documents,
         (SELECT count(*)::int FROM payment_allocations WHERE condition_id = $1)                AS payments,
         (SELECT count(*)::int FROM statements WHERE condition_id = $1)                         AS statements,
         (SELECT count(*)::int FROM statement_lines WHERE condition_id = $1)                    AS statement_lines,
         (SELECT count(*)::int FROM matter_links
           WHERE target_type = 'condition' AND target_ref = $1::text)                           AS matters,
         (SELECT count(*)::int FROM conditions WHERE parent_id = $1)                            AS children,
         (SELECT count(*)::int FROM conditions WHERE superseded_by_id = $1)                     AS older_versions`,
      [id]);
    const row = r.rows[0] as Record<string, number>;
    return [
      { target: "実績", rows: Number(row.events ?? 0) },
      { target: "この条件をアウト条件にした実績", rows: Number(row.out_refs ?? 0) },
      { target: "文書", rows: Number(row.documents ?? 0) },
      { target: "支払の割当", rows: Number(row.payments ?? 0) },
      { target: "計算書", rows: Number(row.statements ?? 0) + Number(row.statement_lines ?? 0) },
      { target: "案件", rows: Number(row.matters ?? 0) },
      { target: "派生した条件", rows: Number(row.children ?? 0) },
      { target: "この版に改訂された旧版", rows: Number(row.older_versions ?? 0) }
    ].filter((entry) => entry.rows > 0);
  }

  private async today(client: Queryable): Promise<string> {
    const r = await client.query("SELECT current_date AS d");
    return String(dateStr((r.rows[0] as { d: unknown }).d));
  }

  /** その場で書き換える。実績が無い版と、まだ効いていない予約の版に使う。 */
  /** 種類の変更は、その条件が載っている案件で使える種類の範囲だけ。 */
  private async assertKindAllowed(client: Queryable, id: number, kind: string) {
    const r = await client.query(
      `SELECT m.id, m.matter_no, m.kind FROM matter_links ml
         JOIN matters m ON m.id = ml.matter_id
        WHERE ml.target_type = 'condition' AND ml.target_ref = $1::text`, [String(id)]);
    for (const m of r.rows as Array<{ matter_no: string | null; kind: string }>) {
      const allowed = (CONDITION_KINDS_BY_MATTER as Record<string, Array<{ value: string; label: string }>>)[m.kind] ?? [];
      if (allowed.length && !allowed.some((k) => k.value === kind)) {
        throw new DomainError("VALIDATION",
          `案件 ${m.matter_no ?? ""} では ${kind} の条件は使えません（使えるのは ${allowed.map((k) => k.label).join("・")}）`);
      }
    }
  }

  /** 通貨を変えてよいか。版をまたいで実績（有効）か支払（取消以外）があれば断る。 */
  private async assertCurrencyChangeable(client: Queryable, id: number, seriesId: number | null): Promise<void> {
    const r = await client.query(
      `WITH versions AS (
         SELECT x.id FROM conditions x WHERE COALESCE(x.series_id, x.id) = COALESCE($2::bigint, $1::bigint)
       )
       SELECT (SELECT count(*)::int FROM condition_events e
                WHERE e.condition_id IN (SELECT id FROM versions) AND e.status = 'active') AS events,
              (SELECT count(DISTINCT y.id)::int FROM payment_allocations al
                 JOIN payments y ON y.id = al.payment_id
                WHERE y.status <> 'canceled' AND al.condition_id IN (SELECT id FROM versions)) AS payments`,
      [id, seriesId]);
    const row = (r.rows[0] ?? { events: 0, payments: 0 }) as { events: number; payments: number };
    if (Number(row.events) > 0 || Number(row.payments) > 0) {
      throw new DomainError("CONFLICT",
        `実績 ${row.events} 件・支払 ${row.payments} 件が付いているので通貨は変えられません。` +
        "通貨が違う取引は、この条件を無効化して新しい条件を登録してください");
    }
  }

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
    // 案件の紐づけは新しい版へ移す。旧版に付いたままだと、案件から見える条件が
    // 古い版のまま止まり、案件の工程（実績・支払の数）も旧版だけを数えていた。
    await client.query(
      `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
       SELECT matter_id, target_type, $2::text, relation, snapshot
         FROM matter_links WHERE target_type = 'condition' AND target_ref = $1::text
       ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
      [String(id), String(newId)]);
    await client.query(
      "DELETE FROM matter_links WHERE target_type = 'condition' AND target_ref = $1::text",
      [String(id)]);
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
    // 使われている版番号のいちばん大きいものの次。数（count+1）で決めると、
    // 途中の版を削除した系列（R2 を消して R3 が残る）で番号がぶつかり、
    // 一意制約で落ちて「サーバ内部でエラー」になっていた。
    const used = await client.query(
      `SELECT condition_no FROM conditions
        WHERE condition_no = $1 OR condition_no LIKE $1 || '-R%'`, [base]);
    let max = 1;
    for (const row of used.rows as Array<{ condition_no: string }>) {
      const m = /-R(\d+)$/.exec(String(row.condition_no ?? ""));
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${base}-R${max + 1}`;
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
