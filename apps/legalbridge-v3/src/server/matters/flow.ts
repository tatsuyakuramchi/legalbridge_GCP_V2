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
    hint: "相手方から届いた文書を確認して直す。外で作った文書を登録する。"
        + "金銭の条件がある文書なら条件明細も登録する" },
  { value: "own_draft", label: "自社ドラフト型",
    hint: "自社で一から書く。書いた文書を登録する。"
        + "金銭の条件がある文書なら条件明細も登録する" },
  { value: "own_template", label: "自社テンプレートドラフト型",
    hint: "登録済みのひな形から起こす。条件明細の登録が要る（中身はそこから埋まる）" }
];

export interface FlowFacts {
  matterKind: MatterKind;
  documentStyle: DocumentStyle | null;
  matterStatus: string;
  conditionCount: number;
  activeConditionCount: number;
  /** 作品に紐づいている条件の数。権利の上限を確かめられるかの目安。 */
  conditionsWithWork: number;
  /** 締結済みの合意に紐づく条件があるか。基本契約でも単体契約でもよい。 */
  agreementExecuted: boolean;
  agreementNo: string | null;
  /** その合意の種類（master 基本契約／standalone 単体契約）。根拠の文に出す。 */
  agreementKind?: string | null;
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
  /** 定額の条件のうち払い切れた（または完了扱いの）本数。業務委託の「支払」の済はこれで見る。 */
  fixedConditions?: { total: number; done: number };

  // ---- A-044 案件の再定義 ----
  /** 作品案件の軸。 */
  workId?: number | null;
  workTitle?: string | null;
  /** 作品案件に制作委託があるか。null は未決定（条件から推す）。 */
  production?: boolean | null;
  /** 委託料・実費・手数料の条件（有効）の本数。作品案件の制作委託ブロックを出す根拠。 */
  serviceConditions?: number;
  /** 許諾料・製品の条件（有効）の本数。 */
  licenseConditions?: number;
  /** 成果物の帰属先が受注者の条件の本数。権利が相手に残るので許諾が要る。 */
  contractorOwned?: number;
  /** 付帯する契約のうち生きているもの。空になって初めて完了にできる。 */
  liveAgreements?: Array<{ agreementNo: string | null; kind: string; currentEnd: string | null }>;
  /** 子の案件（プロジェクトの下）。開いているものが残っていれば完了にできない。 */
  children?: { total: number; open: number };
  /** タスク。その他案件はこれで進む。 */
  tasks?: { total: number; done: number };
  /** 「基本契約なし（発注書の約款）」で決定した発注書の枚数。契約が無くても正常な取引。 */
  spotOrders?: number;
}

/** 工程のブロック。作品案件は 作品 → 制作委託 → 許諾 → 継続、業務案件は 業務委託 → 継続。 */
export type FlowBlock = "work" | "production" | "license" | "service" | "other" | "continue";
export const FLOW_BLOCK_LABEL: Record<FlowBlock, string> = {
  work: "作品", production: "制作委託", license: "許諾", service: "業務委託", other: "進め方", continue: "継続"
};

export interface FlowStep {
  no: number;
  name: string;
  /** 済んでいるか。判定できないものは false のまま、理由を detail に書く。 */
  done: boolean;
  /** 済／未の根拠。 */
  detail: string;
  /**
   * この段階の作業をする場所。案件の中身のタブ名。
   * 工程を見て「次はこれ」と分かっても、どこで手を動かすかが分からなければ止まる。
   * 納品・検収・受領の実績は「実績」タブに入れる（条件明細タブではない）。
   */
  tab?: "conditions" | "events" | "documents" | "payments" | "communications";
  /** その段階で押す操作の呼び名。移った先で何をするかを一言で出す。 */
  action?: string;
  /** どのブロックの段階か。画面はブロックごとに見出しを付けて並べる。 */
  block?: FlowBlock;
  /** 「次にやること」に数えない段階（継続は状態であって作業ではない）。 */
  optional?: boolean;
}

const doc = (facts: FlowFacts) =>
  facts.issuedDocuments.length
    ? `${facts.issuedDocuments[0].documentNo ?? "番号なし"} ほか ${facts.issuedDocuments.length} 件 決定済み`
    : "決定済みの文書なし";

/**
 * 文書の段階。進め方で「何をするか」が変わるので、名前も判定もそこで分ける。
 * 進め方が未設定なら、これまでどおり「発行済みの文書があるか」で見る。
 */
function documentStep(f: FlowFacts, no: number, fallbackName: string): FlowStep {
  if (f.documentStyle === "counterparty_review") {
    const got = f.importedDocuments > 0;
    return {
      no, name: "相手方の文書を確認",
      tab: "documents",
      done: got,
      detail: got
        ? `取り込んだ文書 ${f.importedDocuments} 件`
        : "相手方の文書がまだ取り込まれていない。「外で作った文書を登録」から入れる"
          + (f.activeConditionCount ? "" : "。金銭の条件がある文書なら条件明細も登録する")
    };
  }
  if (f.documentStyle === "own_template") {
    return {
      no, name: "ひな形から文書を決定",
      tab: "documents",
      done: f.issuedDocuments.length > 0,
      detail: f.issuedDocuments.length
        ? doc(f)
        : f.draftDocuments > 0
          ? `下書き ${f.draftDocuments} 件。決定するとここが済になる`
          : f.activeConditionCount > 0
            ? "ひな形を選んで決定する"
            : "先に条件明細を登録する。ひな形の中身はそこから埋まる"
    };
  }
  if (f.documentStyle === "own_draft") {
    return {
      no, name: "自社ドラフトを決定",
      tab: "documents",
      done: f.issuedDocuments.length > 0,
      detail: f.issuedDocuments.length
        ? doc(f)
        : f.draftDocuments > 0
          ? `下書き ${f.draftDocuments} 件。決定するとここが済になる`
          : "自社で書いた文書を「外で作った文書を登録」から入れる"
            + (f.activeConditionCount ? "" : "。金銭の条件がある文書なら条件明細も登録する")
    };
  }
  return {
    no, name: fallbackName,
    tab: "documents",
    done: f.issuedDocuments.length > 0 || f.importedDocuments > 0,
    detail: f.documentStyle === null && !f.issuedDocuments.length && !f.importedDocuments
      ? "進め方が未設定。他社レビューか自社ドラフトかを決めると、次にやることが決まる"
      : doc(f)
  };
}

/** 「基本契約 ARC-SVC-2026-0001 締結済み」。種類を書かないと、単体契約を基本契約と読む。 */
const agreementDetail = (f: FlowFacts): string => {
  const kind = f.agreementKind === "standalone" ? "単体契約" : f.agreementKind === "master" ? "基本契約" : "合意";
  return `${kind} ${f.agreementNo ?? ""} 締結済み`.replace(/\s+/g, " ").trim();
};

const eventsOf = (facts: FlowFacts, types: string[]) =>
  types.reduce((sum, t) => sum + (facts.events[t] ?? 0), 0);

/** 作品ブロック。作品 1 つが軸。ここが無いと権利の上限も許諾の範囲も決まらない。 */
function workSteps(f: FlowFacts): FlowStep[] {
  const has = Boolean(f.workId) || f.conditionsWithWork > 0;
  return [
    { no: 0, name: "作品の登録", tab: "conditions", block: "work", done: has,
      detail: has
        ? (f.workTitle ? `作品「${f.workTitle}」` : `作品に紐づく条件 ${f.conditionsWithWork} 件`)
        : "案件の軸になる作品が無い。作品を紐づける（許諾できる上限が決まらない）" }
  ];
}

/** 許諾ブロック（旧ライセンス）。許諾を出す・取るの流れ。 */
function licenseSteps(f: FlowFacts): FlowStep[] {
  const received = eventsOf(f, ["sales", "manufacturing", "sublicense_receipt"]);
  const licensed = f.licenseConditions ?? f.activeConditionCount;
  return [
    { no: 0, name: "条件の合意", tab: "conditions", block: "license", done: licensed > 0,
      detail: licensed > 0 ? `許諾の条件 ${licensed} 件` : "許諾の条件（許諾料・製品）が登録されていない" },
    f.agreementExecuted
      ? { no: 0, name: "契約書の締結", tab: "documents", block: "license", done: true,
          detail: agreementDetail(f) }
      : { ...documentStep(f, 0, "契約書の締結"), block: "license" },
    { no: 0, name: "実績の受領", tab: "events", action: "実績を足す", block: "license", done: received > 0,
      detail: received > 0
        ? `実績 ${received} 件（直近 ${f.latestEventOn ?? "—"}）`
        : "実績の記録がない。売上・製造・再許諾の受領を実績タブに入れる" },
    // 制作委託つきの作品案件では、支払の件数は委託料の支払と混ざる。計算書だけを根拠にする。
    { no: 0, name: "計算書と分配", tab: "payments", action: "支払を起こす", block: "license",
      done: f.statements > 0 || (!hasProduction(f) && f.payments.paid > 0),
      detail: f.statements > 0
        ? `計算書 ${f.statements} 件` : !hasProduction(f) && f.payments.paid > 0
          ? `支払済み ${f.payments.paid} 件` : "計算書も分配の支払もない" }
  ];
}

/** 業務委託ブロック。外へ仕事を頼む流れ。取適法の検査が付く。 */
function outsourcingSteps(f: FlowFacts, block: FlowBlock): FlowStep[] {
  const delivered = eventsOf(f, ["delivery", "manufacturing", "service_period"]);
  const inspected = eventsOf(f, ["inspection"]);
  const service = f.serviceConditions ?? f.activeConditionCount;
  return [
    // 基本契約でも単体契約でも済。契約なしのままなら未済で「契約を登録する」。
    // 基本契約を結ばず、発注書の約款だけで取引する相手もいる（1回きりの原稿制作など）。
    // その発注書が決定していれば、契約が無くても済にする。
    { no: 0, name: "基本契約の確認", tab: "documents", action: "契約を登録する", block,
      done: f.agreementExecuted || (f.spotOrders ?? 0) > 0,
      detail: f.agreementExecuted
        ? agreementDetail(f)
        : (f.spotOrders ?? 0) > 0
          ? `基本契約なし（発注書の約款）で発注 ${f.spotOrders} 枚。契約を結ぶなら登録する`
          : "この相手と締結済みの契約（基本契約か単体契約）がない。契約を登録するか、基本契約なしで発注書を出すと済になる" },
    // 発注書も検収書も条件明細から出る。ここが無いと「文書を作る」で
    // 選ぶものが無く、どこで登録するのかが画面から読めない。
    { no: 0, name: "条件明細の登録", tab: "conditions", action: "条件を登録する", block,
      done: service > 0,
      detail: service > 0
        ? `有効な条件 ${service} 件`
        : "委託の中身（金額・納期・支払条件）を条件明細に入れる。発注書はここから出る" },
    { ...documentStep(f, 0, "発注"), block },
    // 検収の実績は納品を含む（納まっていないものは検収できない）。検収済みを
    // まとめて入れたときは検収の実績しか無いので、ここが未済のまま残っていた。
    { no: 0, name: "納品・報告", tab: "events", action: "実績を足す", block,
      done: delivered > 0 || inspected > 0,
      detail: delivered > 0
        ? `納品・製造の実績 ${delivered} 件（直近 ${f.latestEventOn ?? "—"}）`
        : inspected > 0
          ? `検収の実績 ${inspected} 件（納品は検収に含む）`
          : "納品の記録がない。実績タブで条件を選んで入れる" },
    { no: 0, name: "検収", tab: "events", action: "検収の実績を足す", block, done: inspected > 0,
      detail: inspected > 0
        ? `検収の実績 ${inspected} 件`
        : "検収の記録がない。実績タブで検収を入れ、そこから検収書を作る" },
    { no: 0, name: "支払", tab: "payments", action: "支払を起こす", block,
      // 定額の条件が全部払い切れて初めて済。1件払っただけでは済にしない。
      done: f.fixedConditions && f.fixedConditions.total > 0
        ? f.fixedConditions.done >= f.fixedConditions.total
        : f.payments.paid > 0,
      detail: f.fixedConditions && f.fixedConditions.total > 0
        // 条件の軸なので「払い切り」。支払1件の「支払済み」と語を分ける。
        ? `定額の条件 ${f.fixedConditions.total} 本のうち ${f.fixedConditions.done} 本が払い切り`
          + (f.payments.total > 0 ? `（支払 ${f.payments.total} 件、うち ${f.payments.paid} 件支払済み）` : "")
        : f.payments.total > 0
          ? `支払 ${f.payments.total} 件のうち ${f.payments.paid} 件が支払済み`
          : "支払がない。検収書から支払を立てる" }
  ];
}

/**
 * その他案件。決まった軸を持たない（新しい契約スキームの立案、プロジェクト単位の運用）。
 * 受付 → 検討 → 決定 → 完了 の簡単な制御。中身はタスクで進める。
 */
function otherSteps(f: FlowFacts): FlowStep[] {
  const tasks = f.tasks ?? { total: 0, done: 0 };
  const considered = tasks.total > 0 || f.draftDocuments > 0 || f.issuedDocuments.length > 0
    || f.importedDocuments > 0 || f.activeConditionCount > 0;
  const decided = (tasks.total > 0 && tasks.done >= tasks.total)
    || f.issuedDocuments.length > 0 || f.agreementExecuted;
  return [
    { no: 0, name: "受付", tab: "communications", block: "other", done: true, detail: "案件が立っている" },
    { no: 0, name: "検討", tab: "communications", action: "タスクを足す", block: "other", done: considered,
      detail: considered
        ? [tasks.total ? `タスク ${tasks.done}／${tasks.total}` : "",
           f.issuedDocuments.length || f.draftDocuments ? doc(f) : "",
           f.activeConditionCount ? `条件 ${f.activeConditionCount} 件` : ""].filter(Boolean).join("　")
        : "何をするかをタスクに分けて入れる（文書や条件が要るなら、それも）" },
    { no: 0, name: "決定", tab: "documents", block: "other", done: decided,
      detail: decided
        ? (f.agreementExecuted ? agreementDetail(f)
           : f.issuedDocuments.length ? doc(f) : `タスク ${tasks.done}／${tasks.total} 済`)
        : "タスクを全部済ませるか、文書を決定する（契約なら締結を記録する）" },
    { no: 0, name: "完了", tab: "communications", block: "other", done: f.matterStatus === "done",
      detail: f.matterStatus === "done" ? "案件が完了" : "案件がまだ開いている" }
  ];
}

/**
 * 継続。工程が済んでも、付帯する契約が終わるまで案件は開いたまま
 * （時限払い・製造時払い・料率は契約が終わるまで回る）。回は支払文書処理が回す。
 * 作業ではなく状態なので「次にやること」には数えない。
 */
function continueStep(f: FlowFacts): FlowStep[] {
  const live = f.liveAgreements ?? [];
  const kids = f.children ?? { total: 0, open: 0 };
  const done = live.length === 0 && kids.open === 0;
  const parts: string[] = [];
  if (live.length) {
    parts.push(`生きている契約 ${live.length} 本（${live.map((a) =>
      `${a.agreementNo ?? "番号なし"}${a.currentEnd ? ` 〜${a.currentEnd}` : " 期限なし"}`).join("・")}）`);
  }
  if (kids.open) parts.push(`開いている子の案件 ${kids.open}／${kids.total}`);
  return [{
    no: 0, name: "継続", tab: "documents", block: "continue", optional: true, done,
    detail: done
      ? (kids.total ? "付帯する契約は終わり、子の案件も全部完了。完了にできる" : "付帯する契約は全部終わった。完了にできる")
      : parts.join("。") + "。終わるまで案件は開いたまま（回は支払文書処理で回す）"
  }];
}

/** 作品案件に制作委託のブロックを出すか。人が決めていれば従い、未決定なら条件から推す。 */
export function hasProduction(f: FlowFacts): boolean {
  if (f.production === true || f.production === false) return f.production;
  return (f.serviceConditions ?? 0) > 0 || (f.contractorOwned ?? 0) > 0;
}

export function buildFlow(facts: FlowFacts): FlowStep[] {
  let steps: FlowStep[];
  if (facts.matterKind === "work") {
    steps = [
      ...workSteps(facts),
      ...(hasProduction(facts) ? outsourcingSteps(facts, "production") : []),
      ...licenseSteps(facts),
      ...continueStep(facts)
    ];
  } else if (facts.matterKind === "outsourcing") {
    steps = [...outsourcingSteps(facts, "service"), ...continueStep(facts)];
  } else {
    // その他案件（プロジェクト）は、付帯する契約か子の案件があるときだけ継続を出す。
    steps = [...otherSteps(facts),
             ...(facts.liveAgreements?.length || facts.children?.total ? continueStep(facts) : [])];
  }
  return steps.map((s, i) => ({ ...s, no: i + 1 }));
}

/**
 * いま取り組むべき段階。済んでいない最初のもの。
 * すべて済んでいれば null（＝案件を閉じてよい状態）。
 */
export function currentStep(steps: FlowStep[]): FlowStep | null {
  return steps.find((s) => !s.done && !s.optional) ?? null;
}
