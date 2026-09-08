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

export type Tone = "" | "in" | "out" | "ok" | "warn" | "accent";

interface Entry { label: string; tone: Tone }

const MATTER: Record<string, Entry> = {
  open: { label: "対応中", tone: "accent" },
  waiting: { label: "待ち", tone: "warn" },
  blocked: { label: "停滞", tone: "out" },
  done: { label: "完了", tone: "ok" },
  canceled: { label: "中止", tone: "" }
};

const TASK: Record<string, Entry> = {
  todo: { label: "未着手", tone: "" },
  doing: { label: "着手中", tone: "accent" },
  blocked: { label: "停滞", tone: "out" },
  done: { label: "完了", tone: "ok" }
};

const CONDITION: Record<string, Entry> = {
  draft: { label: "下書き", tone: "" },
  active: { label: "有効", tone: "accent" },
  // 契約変更を締結して記録済みだが、適用開始日がまだ来ていない版。
  scheduled: { label: "適用待ち", tone: "warn" },
  superseded: { label: "差し替え済み", tone: "" },
  void: { label: "無効", tone: "out" }
};

const DOCUMENT: Record<string, Entry> = {
  draft: { label: "下書き", tone: "" },
  issued: { label: "発行済み", tone: "ok" },
  superseded: { label: "差し替え済み", tone: "" },
  void: { label: "無効", tone: "out" }
};

const PAYMENT: Record<string, Entry> = {
  planned: { label: "予定", tone: "" },
  approved: { label: "承認済み", tone: "accent" },
  paid: { label: "支払済み", tone: "ok" },
  canceled: { label: "取消", tone: "" }
};

const AGREEMENT: Record<string, Entry> = {
  draft: { label: "下書き", tone: "" },
  negotiating: { label: "交渉中", tone: "accent" },
  executed: { label: "締結済み", tone: "ok" },
  expired: { label: "満了", tone: "warn" },
  terminated: { label: "解約", tone: "out" }
};

const PARTY: Record<string, Entry> = {
  active: { label: "取引中", tone: "" },
  archived: { label: "休止", tone: "" },
  merged: { label: "統合済み", tone: "out" }
};

const STAFF: Record<string, Entry> = {
  active: { label: "在籍", tone: "" },
  retired: { label: "退職", tone: "" }
};

const WORK: Record<string, Entry> = {
  planning: { label: "企画中", tone: "" },
  in_production: { label: "制作中", tone: "accent" },
  released: { label: "公開済み", tone: "ok" },
  archived: { label: "終了", tone: "" }
};

const MAPS = {
  matter: MATTER, task: TASK, condition: CONDITION, document: DOCUMENT,
  payment: PAYMENT, agreement: AGREEMENT, party: PARTY, staff: STAFF, work: WORK
} as const;

export type StatusKind = keyof typeof MAPS;

/** 訳せない値はそのまま出す。黙って空欄にすると、状態を見失う。 */
export function statusOf(kind: StatusKind, value: string | null | undefined): Entry {
  const raw = String(value ?? "").trim();
  return MAPS[kind][raw] ?? { label: raw || "—", tone: "" };
}

/** 表の中で使う状態の札。 */
export function StatusTag({ kind, value }: { kind: StatusKind; value: string | null | undefined }) {
  const { label, tone } = statusOf(kind, value);
  return <span className={tone ? `tag ${tone}` : "tag"}>{label}</span>;
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
  single: "お金の条件を持たない文書を作る。秘密保持契約・通知書・レビューなど"
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
export const PARTY_KIND_LABEL: Record<string, string> = { corporate: "法人", individual: "個人" };
