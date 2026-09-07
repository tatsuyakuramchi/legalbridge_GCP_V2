// V3 のドメインモデル。物理の軸は条件、運用の軸は案件。
// 画面もAPIもこの型だけを扱い、テーブルの列名は外へ出さない。

export type Direction = "in" | "out";
export type ConditionKind = "license" | "product" | "service" | "expense" | "fee";
export type PricingModel = "fixed" | "unit_rate" | "revenue_rate" | "subscription" | "none";
export type ConditionStatus = "draft" | "active" | "superseded" | "void";
export type MatterKind = "work" | "outsourcing" | "single";
export type MatterStatus = "open" | "waiting" | "blocked" | "done" | "canceled";
export type ScopeType = "region" | "language" | "media" | "channel";

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
  currency: string;
  pricingModel: PricingModel;
  /** 百万分率。表示は ratePpm / 10000 で % になる。 */
  ratePpm: number | null;
  flatAmount: number | null;
  mgAmount: number | null;
  agAmount: number | null;
  termStart: string | null;
  termEnd: string | null;
  status: ConditionStatus;
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
  taxCategory: "taxable" | "reduced" | "exempt";
  paymentTerms: string | null;
  cycle: string | null;
  notes: string | null;
  scopes: ConditionScope[];
  balance: ConditionBalance | null;
  /** この条件を出力した文書。参照方向を反転した結果、条件から辿れる。 */
  documents: Array<{ id: number; documentNo: string | null; status: string; issuedAt: string | null }>;
  events: Array<{ id: number; eventType: string; occurredOn: string; period: string | null; amount: number }>;
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
}

export interface MatterDetail extends MatterSummary {
  remarks: string | null;
  driveFolderUrl: string | null;
  /** 案件は所有せず参照するだけ。ここに並ぶのは全部リンク。 */
  conditions: ConditionSummary[];
  documents: Array<{ id: number; documentNo: string | null; status: string; templateLabel: string | null; issuedAt: string | null }>;
  payments: Array<{ id: number; paymentNo: string | null; direction: Direction; amount: number; currency: string; dueOn: string | null; status: string }>;
  communications: Array<{ occurredAt: string; action: string; actor: string; detail: Record<string, unknown> }>;
  links: Array<{ targetType: string; targetRef: string; relation: string }>;
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
  scopes: Array<{ scopeType: ScopeType; labels: string[] }>;
}

export type ScopeVerdict = "inside" | "outside" | "unknown";
export interface EnvelopeCheck {
  verdict: ScopeVerdict;
  violations: Array<{ dimension: string; expected: string; actual: string; limitedBy: string | null }>;
}
