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

/**
 * 進め方。取引モデルだけでは「実際に何をするか」が決まらない。
 * 相手方の文書をレビューするのか、一から書くのか、ひな形から起こすのか。
 */
export type DocumentStyle = "counterparty_review" | "own_draft" | "own_template";

export const DOCUMENT_STYLES: Array<{ value: DocumentStyle; label: string; hint: string }> = [
  { value: "counterparty_review", label: "他社文書レビュー型",
    hint: "相手方から届いた文書を確認して直す。まず文書を受け取って取り込む" },
  { value: "own_draft", label: "自社ドラフト型",
    hint: "自社で一から書く。ひな形に無い条件のときはこちら" },
  { value: "own_template", label: "自社テンプレートドラフト型",
    hint: "登録済みのひな形から起こす。条件から自動で埋まる" }
];

export interface FlowFacts {
  matterKind: MatterKind;
  documentStyle: DocumentStyle | null;
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
  /** 取り込んだ文書（テンプレートを持たない＝相手方から受け取ったもの）。 */
  importedDocuments: number;
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

/**
 * 文書の段階。進め方で「何をするか」が変わるので、名前も判定もそこで分ける。
 * 進め方が未設定なら、これまでどおり「発行済みの文書があるか」で見る。
 */
function documentStep(f: FlowFacts, no: number, fallbackName: string): FlowStep {
  if (f.documentStyle === "counterparty_review") {
    const got = f.importedDocuments > 0;
    return {
      no, name: "相手方の文書を確認",
      done: got,
      detail: got
        ? `取り込んだ文書 ${f.importedDocuments} 件`
        : "相手方の文書がまだ取り込まれていない。受け取った文書を登録する"
    };
  }
  if (f.documentStyle === "own_template") {
    return {
      no, name: "ひな形から発行",
      done: f.issuedDocuments.length > 0,
      detail: f.issuedDocuments.length
        ? doc(f)
        : f.draftDocuments > 0
          ? `下書き ${f.draftDocuments} 件。発行するとここが済になる`
          : "ひな形を選んで発行する"
    };
  }
  if (f.documentStyle === "own_draft") {
    return {
      no, name: "自社ドラフトの発行",
      done: f.issuedDocuments.length > 0,
      detail: f.issuedDocuments.length
        ? doc(f)
        : f.draftDocuments > 0
          ? `下書き ${f.draftDocuments} 件。発行するとここが済になる`
          : "自社で書いた文書を登録して発行する"
    };
  }
  return {
    no, name: fallbackName,
    done: f.issuedDocuments.length > 0 || f.importedDocuments > 0,
    detail: f.documentStyle === null && !f.issuedDocuments.length && !f.importedDocuments
      ? "進め方が未設定。他社レビューか自社ドラフトかを決めると、次にやることが決まる"
      : doc(f)
  };
}

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
    f.agreementExecuted
      ? { no: 3, name: "契約書の締結", done: true,
          detail: `合意 ${f.agreementNo ?? ""} 締結済み`.trim() }
      : documentStep(f, 3, "契約書の締結"),
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
    documentStep(f, 2, "発注"),
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

/**
 * 文書作成。金銭条件も権利の移動も伴わない、文書だけの案件。
 * この型は文書を作ることそのものが流れなので、進め方が段階を決める。
 */
function documentSteps(f: FlowFacts): FlowStep[] {
  return [
    { no: 1, name: "相談の受付", done: true, detail: "案件が立っている" },
    documentStep(f, 2, "文書の用意"),
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
  return documentSteps(facts);
}

/**
 * いま取り組むべき段階。済んでいない最初のもの。
 * すべて済んでいれば null（＝案件を閉じてよい状態）。
 */
export function currentStep(steps: FlowStep[]): FlowStep | null {
  return steps.find((s) => !s.done) ?? null;
}
