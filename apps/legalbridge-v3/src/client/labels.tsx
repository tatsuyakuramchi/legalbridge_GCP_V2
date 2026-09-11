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

/**
 * 文書の段階。人が見るのは「下書き → 決定 → 送信」の3つ。
 * 保存上の状態（draft / issued / superseded / void）と、送ったかどうかの記録から
 * サーバが phase として畳んで返す。画面は phase を出す。
 * 「発行」という語は使わない。番号が振られて中身が固まることを「決定」と呼ぶ。
 */
const DOCUMENT: Record<string, Entry> = {
  draft: { label: "下書き", tone: "warn" },
  // 保存上の状態を直接渡されたときの保険。段階（phase）で出すのが本筋。
  issued: { label: "決定済み", tone: "accent" },
  decided: { label: "決定済み", tone: "accent" },
  sent: { label: "送信済み", tone: "ok" },
  // 「済み」だと何かを終えたように読める。実際は「この版はもう使わない」。
  superseded: { label: "訂正版あり", tone: "" },
  void: { label: "無効", tone: "out" }
};

/** その段階で何ができるか。画面の帯にそのまま出す。 */
export const DOCUMENT_STATE_NOTE: Record<string, { headline: string; detail: string }> = {
  draft: {
    headline: "下書きです。まだ決めていません。中身を直せます。",
    detail: "「決定する」を押すと番号が振られ、そこから先は中身を直せなくなります。いまなら何度でも直せます。"
  },
  decided: {
    headline: "決定済みです。まだ相手には送っていません。",
    detail: "番号も本文もこのまま残ります。次は「送る」で内容確認のメールか CloudSign へ。"
      + "直すときは訂正版を作ります。訂正版を決定した瞬間に、この版は退いて「訂正版あり」になります。"
  },
  issued: {
    headline: "決定済みです。",
    detail: "番号も本文もこのまま残ります。直すときは訂正版を作ります。"
  },
  sent: {
    headline: "相手に送りました。",
    detail: "送った記録が下に残っています。直すときは訂正版を作って、決定してからもう一度送ります。"
  },
  superseded: {
    headline: "訂正版に差し替えられました。",
    detail: "新しい版が現行です。この版は出した事実の記録として残ります。消えません。"
  },
  void: {
    headline: "無効にしました。",
    detail: "行は消えず、記録として残ります。すでに送付・保存したファイルは取り消せません。"
  }
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
