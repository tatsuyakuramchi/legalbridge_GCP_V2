import type { MatterKind } from "./write-service.js";

/**
 * お金の流れ（案件の中身のタブを、やる順に並べたもの）。
 *
 * 条件明細・実績・文書・支払は別々のタブに分かれている。1つずつは分かっても
 * 「実績を入れたあと何をすれば支払になるのか」が画面から読めず、タブを
 * 行き来して探すことになっていた。間に文書（検収書・計算書）が挟まるのが
 * 見えないのが原因で、実績から直接支払を立てようとして手が止まる。
 *
 * 流れは取引モデルで変わる（業務委託は検収書、ライセンスは計算書）。
 * 進み具合（flow.ts）とは別物で、こちらは「いつも同じ順番」を思い出すための
 * 道しるべ。だから案件に何があるかでは変わらない。
 */

export type ChainTab = "conditions" | "events" | "documents" | "payments";

export interface ChainStep {
  tab: ChainTab;
  /** タブの名前と揃える。画面で探すときの手がかりになる。 */
  label: string;
  /** そのタブで何をするか。1行で言い切る。 */
  hint: string;
}

const OUTSOURCING: ChainStep[] = [
  { tab: "conditions", label: "条件明細",
    hint: "いくら・いつまでを決める。発注書はここから出る" },
  { tab: "events", label: "実績",
    hint: "条件を選んで、納品と検収を記録する" },
  { tab: "documents", label: "文書",
    hint: "検収の実績から検収書を作る（実績タブの「検収書を作る」から）" },
  { tab: "payments", label: "支払",
    hint: "決定した検収書から支払を起こし、払ったら支払済みにする" }
];

const LICENSE: ChainStep[] = [
  { tab: "conditions", label: "条件明細",
    hint: "料率と分配の取り決めを入れる" },
  { tab: "events", label: "実績",
    hint: "条件を選んで、売上・製造・再許諾の受領を記録する" },
  { tab: "documents", label: "文書",
    hint: "実績をまとめて計算書を作る（実績タブで実績を選んでから）" },
  { tab: "payments", label: "支払",
    hint: "決定した計算書から支払を起こし、払ったら支払済みにする" }
];

/**
 * この取引モデルのお金の流れ。
 *
 * 文書作成の案件は金銭の条件を持たないことが多く、流れは工程バーで足りる。
 * 空を返して道しるべを出さない（要らない帯を出すと、次から読まれなくなる）。
 */
export function moneyChain(kind: MatterKind): ChainStep[] {
  if (kind === "outsourcing") return OUTSOURCING;
  if (kind === "work") return LICENSE;
  return [];
}

/** いまいるタブが流れの何番目か。流れの外のタブ（操作の記録・整理）は -1。 */
export function chainIndexOf(steps: ChainStep[], tab: string): number {
  return steps.findIndex((s) => s.tab === tab);
}
