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
export const MATTER_KIND_LABEL: Record<string, string> = {
  work: "作品フロー", outsourcing: "業務委託フロー", single: "単発フロー"
};
export const PARTY_KIND_LABEL: Record<string, string> = { corporate: "法人", individual: "個人" };
