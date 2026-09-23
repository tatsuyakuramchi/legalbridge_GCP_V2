import type { ConditionSettlement } from "../conditions/settlement.js";
import type { ConditionUsageType } from "./condition-usage.js";
// V3 のドメインモデル。物理の軸は条件、運用の軸は案件。
// 画面もAPIもこの型だけを扱い、テーブルの列名は外へ出さない。

export type Direction = "in" | "out";
export type ConditionKind = "license" | "product" | "service" | "expense" | "fee";
export type PricingModel = "fixed" | "unit_rate" | "revenue_rate" | "subscription" | "none";
// scheduled は「まだ効いていない予約の版」。契約変更を締結した日に記録し、
// 適用開始日が来たら日次ジョブが active に切り替える。
export type ConditionStatus = "draft" | "active" | "scheduled" | "superseded" | "void";
export type MatterKind = "work" | "outsourcing" | "single";
export type MatterStatus = "open" | "waiting" | "blocked" | "done" | "canceled";
export type ScopeType = "region" | "language" | "media" | "channel";
/** 許諾料の扱い（A-048）。 */
export type LicenseFeeBasis = "separate" | "included" | "free";
export const LICENSE_FEE_BASIS_VALUES: readonly LicenseFeeBasis[] = ["separate", "included", "free"];
export const LICENSE_FEE_BASIS_LABEL: Record<LicenseFeeBasis, string> = {
  separate: "別途", included: "業務委託報酬に含む", free: "無償"
};

export interface PartyRef { id: number; name: string; kind: "corporate" | "individual" }
export interface WorkRef { id: number; workCode: string | null; title: string }

/** 金額は最小通貨単位の整数で持ち、表示のときだけ通貨に戻す。 */
export interface Money { amount: number; currency: string }

export interface ConditionSummary {
  id: number;
  conditionNo: string | null;
  direction: Direction;
  kind: ConditionKind;
  name: string;
  counterparty: PartyRef | null;
  work: WorkRef | null;
  /** 載っている契約。条件は契約の明細であって、それ自体が契約書ではない。 */
  agreement: { id: number; agreementNo: string | null; title: string } | null;
  currency: string;
  pricingModel: PricingModel;
  /** 百万分率。表示は ratePpm / 10000 で % になる。 */
  ratePpm: number | null;
  flatAmount: number | null;
  /** 単価×数量のときの単価。読めないと画面から直せない。 */
  unitAmount: number | null;
  /** 個数。単価と組。単価×個数が定額の既定値になる。 */
  quantity: number | null;
  mgAmount: number | null;
  agAmount: number | null;
  termStart: string | null;
  termEnd: string | null;
  /** 納期。いつまでに納めるか。契約期間の終了日とは別。 */
  deliveryDue: string | null;
  status: ConditionStatus;
  /** この版が適用され始める日。契約期間（termStart）とは別。 */
  effectiveFrom: string | null;
  /** 利用形態（A-027）。自社製造・自社販売／再許諾／自社製造・他社販売／出版（紙）／出版（電子）。 */
  usageType: ConditionUsageType | null;
  /** 決着。実績・割当・支払済み・完了扱いから導く。一覧で「支払済み」を畳む。 */
  settlement: ConditionSettlement;
}

export interface ConditionScope { scopeType: ScopeType; label: string; code: string | null }

export interface ConditionDetail extends ConditionSummary {
  agreementId: number | null;
  agreementTitle: string | null;
  parentId: number | null;
  parentConditionNo: string | null;
  workPartId: number | null;
  workPartName: string | null;
  exclusivity: "exclusive" | "non_exclusive" | null;
  sublicensable: boolean | null;
  /**
   * 再許諾ごとの別途合意（A-033）。翻訳版再許諾の条件だけが持つ。
   * covered=不要（この条件書で許諾済み）／required=要（相手ごとに別途合意）。
   */
  sublicenseConsent: "covered" | "required" | null;
  /**
   * 許諾料の扱い（A-048）。受注者帰属の成果物を使う許諾の対価。
   * separate=別途（率・額）／included=業務委託報酬に含む／free=無償。許諾条件だけが意味を持つ。
   */
  licenseFeeBasis: LicenseFeeBasis;
  /**
   * 自動更新（A-039）。許諾期間（termStart / termEnd）を条件ごとに更新する。
   * 更新した回数は持たない。終了日・単位・基準日から数える（renewal.ts）。
   */
  autoRenew: boolean | null;
  /** 更新の単位（月）。12 = 1年。空は 12 として扱う。 */
  renewMonths: number | null;
  /** 更新を止めた日。以後は更新しない（その期間は満了まで有効）。 */
  renewStoppedOn: string | null;
  taxCategory: "taxable" | "reduced" | "exempt";
  /** 支払条件。「月末締め翌月末払い」。読んで支払期日を出す。 */
  paymentTerms: string | null;
  /** 契約形式（請負・委任など）。紙に書く語。支払条件とは別。 */
  contractForm: string | null;
  cycle: string | null;
  notes: string | null;
  /** 仕様・成果物。書類の明細の「仕様・成果物」に出る。 */
  spec: string | null;
  /** 成果物の帰属先。orderer=発注者 / contractor=受注者。 */
  deliverableOwnership: "orderer" | "contractor" | null;
  /**
   * 外部で出した発注書の番号。V1・V2 や紙で出した発注書は V3 に文書として無く、
   * 検収書の発注番号を引ける元が無いので、ここに控える。
   * V3 で出した発注書が紐づいていればそちらを優先する。
   */
  orderNo: string | null;
  scopes: ConditionScope[];
  balance: ConditionBalance | null;
  /** この条件を出力した文書。参照方向を反転した結果、条件から辿れる。 */
  documents: Array<{ id: number; documentNo: string | null; status: string;
                     issuedAt: string | null; matterId: number | null }>;
  /**
   * この条件を扱っている案件。matter_links の参照方向を反転して読む。
   * 案件が全体の入口なので、条件の側からも付いているかどうかが見えないと困る。
   */
  matters: Array<{ id: number; matterNo: string | null; title: string;
                   kind: string; status: string }>;
  events: Array<{ id: number; eventType: string; occurredOn: string; period: string | null; amount: number }>;
}

/**
 * 改訂の1版。契約変更で金額を直すと版が増える。
 * live が「いま効いている版」。それ以外は役目を終えた記録。
 */
export interface ConditionRevision {
  id: number;
  conditionNo: string | null;
  name: string;
  status: ConditionStatus;
  live: boolean;
  supersededById: number | null;
  /** この版が適用され始める日。予約の版はここが未来になる。 */
  effectiveFrom: string | null;
  /** 古い順の通し番号。画面で「第N版」と呼ぶためのもの。 */
  revision: number;
  currency: string;
  pricingModel: string;
  ratePpm: number | null;
  flatAmount: number | null;
  unitAmount: number | null;
  quantity: number | null;
  mgAmount: number | null;
  agAmount: number | null;
  termStart: string | null;
  termEnd: string | null;
  /** 納期。いつまでに納めるか。契約期間の終了日とは別。 */
  deliveryDue: string | null;
  taxCategory: string;
  paymentTerms: string | null;
  /** 契約形式（請負・委任など）。支払条件とは別。 */
  contractForm: string | null;
  notes: string | null;
  counterparty: { id: number; name: string } | null;
  /** この版に付いている実績と文書の数。消してよいかの判断に使う。 */
  eventCount: number;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConditionBalance {
  mgAmount: number;
  agAmount: number;
  plannedTotal: number;
  /** 実績の合計（相殺後の実額）。AG の消化量とは別物。 */
  consumedTotal: number;
  /** AG の消化累計（相殺額）。 */
  agConsumed: number;
  agRemaining: number;
  agConsumptionRate: number | null;
}

export interface MatterSummary {
  id: number;
  matterNo: string | null;
  title: string;
  kind: MatterKind;
  status: MatterStatus;
  ownerName: string | null;
  counterparty: PartyRef | null;
  dueOn: string | null;
  blockedReason: string | null;
  /** 進め方。他社レビュー／自社ドラフト／自社テンプレート。未設定は null。 */
  documentStyle: "counterparty_review" | "own_draft" | "own_template" | null;
  /** 定額の条件の本数と、払い切れた（完了扱い含む）本数。全部済なら「支払済み」の札。 */
  settled: { fixed: number; done: number };
  /** 統合先（A-029）。入っていればこの案件は統合済みで、中身は統合先にある。 */
  mergedIntoId: number | null;
  mergedIntoNo: string | null;
  /** 作品案件の軸（A-044）。 */
  work: WorkRef | null;
  /** 業務案件の事業区分と業務名。 */
  businessLine: "publishing" | "boardgame" | "event" | "store" | "admin" | "other" | null;
  businessName: string | null;
  /** 作品案件に制作委託があるか。null は未決定。 */
  production: boolean | null;
  /** 親案件（プロジェクト）。孫まで許す。 */
  parentId: number | null;
  parentNo: string | null;
  parentTitle: string | null;
  childCount: number;
  /** 件名を人が上書きしたか。false なら軸から自動で組む。 */
  titleManual: boolean;
  /** 旧 3 種類から規則で移した印（元の kind）。 */
  remappedFrom: string | null;
}

/** 案件の見出しだけ（親・子・関連の一覧に使う）。 */
export interface MatterRef {
  id: number; matterNo: string | null; title: string; kind: MatterKind; status: MatterStatus;
  counterparty: string | null;
}

/** 案件に付帯する契約と、いまの終了日。完了の判定に使う。 */
export interface MatterAgreementRef {
  id: number; agreementNo: string | null; title: string; kind: string; status: string;
  currentEnd: string | null;
  /** 生きているか（締結済みで、終了日が来ていない・解除されていない）。 */
  live: boolean;
}

export interface MatterDetail extends MatterSummary {
  remarks: string | null;
  driveFolderUrl: string | null;
  parent: MatterRef | null;
  children: MatterRef[];
  related: MatterRef[];
  /** 付帯する契約（条件と文書から辿る）。 */
  agreements: MatterAgreementRef[];
  /** 案件は所有せず参照するだけ。ここに並ぶのは全部リンク。 */
  conditions: ConditionSummary[];
  documents: Array<{ id: number; documentNo: string | null; status: string;
                     templateLabel: string | null; templateKey: string | null;
                     counterparty: string | null;
                     /** 相手先ごとに絞って見るための id。 */
                     counterpartyId: number | null;
                     issuedAt: string | null;
                     /** 最後に送った日時と口（gmail / cloudsign）。 */
                     sentAt: string | null; sentVia: string | null;
                     /** 繋がっている合意の状態。executed なら締結済み。 */
                     agreementStatus: string | null }>;
  payments: Array<{ id: number; paymentNo: string | null; direction: Direction; amount: number;
                    currency: string; dueOn: string | null; status: string;
                    /** 管理者が直せる欄（A-041）。 */
                    basisReceivedOn: string | null; paidOn: string | null; note: string | null;
                    /** 払い先。支払は持たないので割当先の条件から引いている。 */
                    counterpartyId: number | null; counterparty: string | null }>;
  communications: Array<{ occurredAt: string; action: string; actor: string; detail: Record<string, unknown> }>;
  links: Array<{ targetType: string; targetRef: string; relation: string;
                 snapshot: Record<string, unknown> }>;
  tasks: Array<{ id: number; title: string; status: string; dueAt: string | null; assigneeName: string | null }>;
}

/** 作品の権利包絡。OUT条件はこれと照合する（個々のIN条件とではない）。 */
export interface RightsEnvelope {
  workId: number;
  workCode: string | null;
  title: string;
  acquiredCount: number;
  termLimit: string | null;
  termLimitedBy: string | null;
  exclusivityLimit: "exclusive" | "non_exclusive" | null;
  exclusivityLimitedBy: string | null;
  sublicensable: boolean;
  sublicenseLimitedBy: string | null;
  /**
   * 許諾できる上限。コードで照合する（名前で比べると「日本」「日本国内」が
   * 別物になる）。移行してきた行はコードを持たないので null が入る。
   */
  scopes: Array<{ scopeType: ScopeType; values: Array<{ code: string | null; label: string }> }>;
}

export type ScopeVerdict = "inside" | "outside" | "unknown";
export interface EnvelopeCheck {
  verdict: ScopeVerdict;
  violations: Array<{ dimension: string; expected: string; actual: string; limitedBy: string | null }>;
}
