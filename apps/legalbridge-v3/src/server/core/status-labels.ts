/**
 * 状態の語彙（画面に出す言葉）。
 *
 * 状態はデータベースの値をそのまま出していた（open / planned / issued …）。
 * 使う人は英語の状態名を覚える必要がないので、日本語にして色で意味を分ける。
 * 表ごとに訳し方が変わらないよう、対応表はここ1箇所に置く。
 *
 * 画面（labels.tsx）ではなくここに置いてあるのは、語の重なりをテストで
 * 止めるため。同じ語を別の軸に使うと「支払済み」が何を指すのか読めなくなる。
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

/**
 * 条件の「版」。どこまで進んだかは別の軸（SettlementTag）で出す。
 * 2本あるので、札の形を変えて同列に読めないようにしてある（下の VERSION_KINDS）。
 */
const CONDITION: Record<string, Entry> = {
  // アプリからは書き込まない。移行データの保険として残してある。
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

/**
 * 支払1件の状態。
 *
 * 「予定」は予定明細の行（まだ実績が無い回）と紛らわしいので使わない。
 * 支払の planned は「立ててあるが払っていない」なので「未払」と呼ぶ。
 * approved はアプリのどこからも付かない（移行データにだけある）ので、
 * 未払と同じ扱いにする。承認の運用を入れるなら、そのとき導線ごと作る。
 */
const PAYMENT: Record<string, Entry> = {
  planned: { label: "未払", tone: "warn" },
  approved: { label: "未払", tone: "warn" },
  paid: { label: "支払済み", tone: "ok" },
  canceled: { label: "取消", tone: "" }
};

/**
 * 実績の生死。生きている実績に札が無いと、他の段と並べたときに
 * 「状態が抜けている」ように見える。void は文書・条件と同じ「無効」に揃える
 * （DB もどれも void。以前はここだけ「取消」と呼んでいた）。
 */
const EVENT: Record<string, Entry> = {
  active: { label: "記録済み", tone: "" },
  void: { label: "無効", tone: "out" }
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
  payment: PAYMENT, event: EVENT, agreement: AGREEMENT, party: PARTY, staff: STAFF, work: WORK
} as const;

export type StatusKind = keyof typeof MAPS;

/** 訳せない値はそのまま出す。黙って空欄にすると、状態を見失う。 */
export function statusOf(kind: StatusKind, value: string | null | undefined): Entry {
  const raw = String(value ?? "").trim();
  return MAPS[kind][raw] ?? { label: raw || "—", tone: "" };
}


/**
 * 「版・生死」の軸。進み具合（決着・支払・文書）とは別の話なので、画面では
 * 塗りつぶさない札にして形で見分ける。条件の詳細では「有効」と「払い切り」が
 * 並ぶが、前者は版、後者は進み具合で、同列に読むものではない。
 */
export const VERSION_KINDS = new Set<StatusKind>(["condition", "event"]);

/** その軸で使っている語ぜんぶ。重なりの検査に使う。 */
export function labelsOf(kind: StatusKind): string[] {
  return Object.values(MAPS[kind]).map((e) => e.label);
}
