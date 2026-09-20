import { SETTLEMENT_LABEL, type ConditionSettlement } from "../server/conditions/settlement.js";
import { DOCUMENT_STATE_NOTE, VERSION_KINDS, statusOf, type StatusKind, type Tone }
  from "../server/core/status-labels.js";
export { DOCUMENT_STATE_NOTE, statusOf };
export type { StatusKind, Tone };
/**
 * 画面に出す語の対応表。
 *
 * 状態はデータベースの値をそのまま出していた（open / planned / issued …）。
 * 使う人は英語の状態名を覚える必要がないので、日本語にして色で意味を分ける。
 * 表ごとに訳し方が変わらないよう、対応表はここ1箇所に置く。
 *
 * 色の意味は全画面で揃える。
 *   out  … 止まっている・期限を過ぎている（赤）
 *   warn … 判断待ち・保留（琥珀）
 *   ok   … 終わった・問題なし（緑）
 *   accent … 進行中（青）
 *   （無指定）… 予定・下書きなど、まだ何も起きていないもの
 */

/** 表の中で使う状態の札。 */
/**
 * 条件の決着（未着手／検収済み・未払／支払を立てた／一部払い済み／払い切り／完了扱い）。
 * 事実（実績・割当・支払）から導いた札。サーバの settlement.ts と対。
 * こちらは「進み具合」の軸なので、塗りつぶした札で出す（版の札とは形が違う）。
 */
const SETTLEMENT_TONE: Record<string, string> = {
  paid: "ok", closed: "ok", partly_paid: "warn", payment_planned: "warn", inspected: "accent", in_progress: "accent"
};
export function SettlementTag({ settlement, compact }: {
  settlement: ConditionSettlement | null | undefined; compact?: boolean;
}) {
  if (!settlement) return null;
  const tone = SETTLEMENT_TONE[settlement.state];
  const label = SETTLEMENT_LABEL[settlement.state] ?? settlement.state;
  const title = [
    settlement.closedReason ? `完了扱い：${settlement.closedReason}` : "",
    settlement.targetAmount !== null ? `定額 ${settlement.targetAmount.toLocaleString()} ／ 支払済み ${settlement.paidAmount.toLocaleString()}` : "",
    settlement.eventCount ? `実績 ${settlement.eventCount} 件` : "実績なし"
  ].filter(Boolean).join("\n");
  return (
    <span className={tone ? `tag ${tone}` : "tag"} title={title}>
      {label}
      {!compact && settlement.state === "partly_paid" && settlement.targetAmount
        ? ` ${Math.round((settlement.paidAmount / settlement.targetAmount) * 100)}%` : ""}
    </span>
  );
}

export function StatusTag({ kind, value }: { kind: StatusKind; value: string | null | undefined }) {
  const { label, tone } = statusOf(kind, value);
  const cls = ["tag", VERSION_KINDS.has(kind) ? "ghost" : "", tone].filter(Boolean).join(" ");
  return <span className={cls}>{label}</span>;
}

export const DIRECTION_LABEL: Record<string, string> = { in: "IN 取得", out: "OUT 許諾" };
/**
 * 取引モデル。案件の種別がそのまま取引の型で、使える条件の種類・必要な文書・
 * 検査をこれが決める。以前は「作品フロー」と呼んでいたが、実務の言葉
 * （ライセンス）と一致していなかったので改めた。
 */
export const MATTER_KIND_LABEL: Record<string, string> = {
  work: "ライセンス", outsourcing: "業務委託", single: "文書作成"
};

/** 取引モデルの補足。一覧の説明や登録フォームの注記に使う。 */
export const MATTER_KIND_HINT: Record<string, string> = {
  work: "作品の権利を許諾する・取得する。許諾料と計算書がぶら下がる",
  outsourcing: "外部へ仕事を頼む。委託料・実費と、発注書・検収書がぶら下がる",
  single: "1件の文書を作る。秘密保持契約・通知書・覚書など。金銭の条件がある文書なら条件明細も持てる"
};

/**
 * 進め方。取引モデルが「何を扱うか」を決めるのに対し、これは「どうやって文書を作るか」を
 * 決める。取引モデルだけでは、相手方の文書を待つのか自分で書くのかが分からない。
 */
export const DOCUMENT_STYLE_LABEL: Record<string, string> = {
  counterparty_review: "他社文書レビュー型",
  own_draft: "自社ドラフト型",
  own_template: "自社テンプレートドラフト型"
};

export const DOCUMENT_STYLE_HINT: Record<string, string> = {
  counterparty_review: "相手方から届いた文書を確認して直す。まず文書を受け取って取り込む",
  own_draft: "自社で一から書く。ひな形に無い条件のときはこちら",
  own_template: "登録済みのひな形から起こす。条件から自動で埋まる"
};

/** 条件の種類。取引モデルの下に来るものなので、名前も実務の言葉に寄せる。 */
export const CONDITION_KIND_LABEL: Record<string, string> = {
  license: "許諾料", product: "製品", service: "委託料", expense: "実費", fee: "手数料"
};
/**
 * 実績の種類。サーバの EVENT_TYPES と対。
 * 実績の画面はサーバから種類の一覧を取るが、実績を並べるだけの画面
 * （作品の動きなど）は一覧を取りに行かないので、ここに持つ。
 */
export const EVENT_TYPE_LABEL: Record<string, string> = {
  manufacturing: "製造", sales: "売上", sublicense_receipt: "再許諾の受領",
  inspection: "検収", delivery: "納品", service_period: "役務の期間", adjustment: "調整"
};

/** 計算方式。サーバの PricingModel と対。 */
export const PRICING_MODEL_LABEL: Record<string, string> = {
  fixed: "定額", unit_rate: "単価×数量", revenue_rate: "料率",
  subscription: "定期課金", none: "計算しない"
};

export const PARTY_KIND_LABEL: Record<string, string> = { corporate: "法人", individual: "個人" };
