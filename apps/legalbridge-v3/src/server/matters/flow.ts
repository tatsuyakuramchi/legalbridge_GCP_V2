import type { MatterKind } from "./write-service.js";

/**
 * 案件の進み具合。
 *
 * 段階は保存しない。その案件に何が揃っているかから導く。保存すると、
 * 手で進めた段階と実際の書類・実績がずれても誰も気づけない。V3 は状態を
 * 二重に持たない方針なので、ここも導出にする。
 *
 * 「済」の根拠を必ず一緒に返す。印だけ付いていて理由が分からないと、
 * 合っているのか確かめようがない。
 */

export interface FlowFacts {
  matterKind: MatterKind;
  matterStatus: string;
  conditionCount: number;
  activeConditionCount: number;
  /** 作品に紐づいている条件の数。権利の上限を確かめられるかの目安。 */
  conditionsWithWork: number;
  /** 締結済みの合意に紐づく条件があるか。 */
  agreementExecuted: boolean;
  agreementNo: string | null;
  issuedDocuments: Array<{ documentNo: string | null; label: string | null }>;
  draftDocuments: number;
  /** 実績の件数を種類ごとに。 */
  events: Record<string, number>;
  /** 直近の実績の日付。根拠として見せる。 */
  latestEventOn: string | null;
  statements: number;
  payments: { total: number; paid: number };
}

export interface FlowStep {
  no: number;
  name: string;
  /** 済んでいるか。判定できないものは false のまま、理由を detail に書く。 */
  done: boolean;
  /** 済／未の根拠。 */
  detail: string;
}

const doc = (facts: FlowFacts) =>
  facts.issuedDocuments.length
    ? `${facts.issuedDocuments[0].documentNo ?? "番号なし"} ほか ${facts.issuedDocuments.length} 件 発行済み`
    : "発行済みの文書なし";

const eventsOf = (facts: FlowFacts, types: string[]) =>
  types.reduce((sum, t) => sum + (facts.events[t] ?? 0), 0);

/** ライセンス（作品の権利）。許諾を出す・取るの流れ。 */
function licenseSteps(f: FlowFacts): FlowStep[] {
  const received = eventsOf(f, ["sales", "manufacturing", "sublicense_receipt"]);
  return [
    { no: 1, name: "権利の上限確認", done: f.conditionsWithWork > 0,
      detail: f.conditionsWithWork > 0
        ? `作品に紐づく条件 ${f.conditionsWithWork} 件`
        : "作品に紐づく条件がない。許諾できる上限が決まらない" },
    { no: 2, name: "条件の合意", done: f.activeConditionCount > 0,
      detail: f.activeConditionCount > 0
        ? `有効な条件 ${f.activeConditionCount} 件`
        : "条件が登録されていない" },
    { no: 3, name: "契約書の締結", done: f.agreementExecuted || f.issuedDocuments.length > 0,
      detail: f.agreementExecuted
        ? `合意 ${f.agreementNo ?? ""} 締結済み`.trim() : doc(f) },
    { no: 4, name: "実績の受領", done: received > 0,
      detail: received > 0
        ? `実績 ${received} 件（直近 ${f.latestEventOn ?? "—"}）` : "実績の記録がない" },
    { no: 5, name: "計算書と分配", done: f.statements > 0 || f.payments.paid > 0,
      detail: f.statements > 0
        ? `計算書 ${f.statements} 件` : f.payments.paid > 0
          ? `支払済み ${f.payments.paid} 件` : "計算書も支払もない" }
  ];
}

/** 業務委託。外へ仕事を頼む流れ。取適法の検査が付く。 */
function outsourcingSteps(f: FlowFacts): FlowStep[] {
  const delivered = eventsOf(f, ["delivery", "manufacturing", "service_period"]);
  const inspected = eventsOf(f, ["inspection"]);
  return [
    { no: 1, name: "基本契約の確認", done: f.agreementExecuted,
      detail: f.agreementExecuted
        ? `合意 ${f.agreementNo ?? ""} 締結済み`.trim()
        : "締結済みの合意に紐づいていない" },
    { no: 2, name: "発注", done: f.issuedDocuments.length > 0, detail: doc(f) },
    { no: 3, name: "納品・報告", done: delivered > 0,
      detail: delivered > 0
        ? `納品・製造の実績 ${delivered} 件（直近 ${f.latestEventOn ?? "—"}）`
        : "納品の記録がない" },
    { no: 4, name: "検収", done: inspected > 0,
      detail: inspected > 0 ? `検収の実績 ${inspected} 件` : "検収の記録がない" },
    { no: 5, name: "支払", done: f.payments.paid > 0,
      detail: f.payments.total > 0
        ? `支払 ${f.payments.total} 件のうち ${f.payments.paid} 件が支払済み`
        : "支払がない" }
  ];
}

/** 単発。条件を持たない相談・通知の流れ。 */
function singleSteps(f: FlowFacts): FlowStep[] {
  return [
    { no: 1, name: "相談の受付", done: true, detail: "案件が立っている" },
    { no: 2, name: "ひな形の選定", done: f.draftDocuments > 0 || f.issuedDocuments.length > 0,
      detail: f.draftDocuments > 0
        ? `下書き ${f.draftDocuments} 件` : doc(f) },
    { no: 3, name: "締結", done: f.agreementExecuted || f.issuedDocuments.length > 0,
      detail: f.agreementExecuted
        ? `合意 ${f.agreementNo ?? ""} 締結済み`.trim() : doc(f) },
    { no: 4, name: "完了", done: f.matterStatus === "done",
      detail: f.matterStatus === "done" ? "案件が完了" : "案件がまだ開いている" }
  ];
}

export function buildFlow(facts: FlowFacts): FlowStep[] {
  if (facts.matterKind === "work") return licenseSteps(facts);
  if (facts.matterKind === "outsourcing") return outsourcingSteps(facts);
  return singleSteps(facts);
}

/**
 * いま取り組むべき段階。済んでいない最初のもの。
 * すべて済んでいれば null（＝案件を閉じてよい状態）。
 */
export function currentStep(steps: FlowStep[]): FlowStep | null {
  return steps.find((s) => !s.done) ?? null;
}
