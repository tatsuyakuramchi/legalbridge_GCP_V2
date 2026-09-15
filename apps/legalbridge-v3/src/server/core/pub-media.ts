/**
 * 出版の媒体（紙／電子）。
 *
 * 条件明細は媒体を許諾範囲（condition_scopes.scope_type='media'）で持つ。
 * 出版の条件書は作品1点につき「紙の条件」と「電子の条件」の2本を1行に
 * まとめて出すので、どの条件がどちらの媒体かを見分ける必要がある。
 *
 * 移行した範囲の表記は揃っていない（「紙」「紙媒体」「書籍」「電子書籍」
 * 「配信」…）ので、コードでも名前でも当たるようにしてある。画面と
 * サーバの両方がここを見る。片方だけに書くと、登録できる表記と紙に載る
 * 表記がずれる。
 */

export type PubMedia = "print" | "digital";

export interface PubMediaOption { code: PubMedia; label: string }

/** 登録のときに入れる正の表記。画面のプルダウンもこれ。 */
export const PUB_MEDIA: PubMediaOption[] = [
  { code: "print", label: "紙" },
  { code: "digital", label: "電子" }
];

export const PUB_MEDIA_LABEL: Record<PubMedia, string> = { print: "紙", digital: "電子" };

const PRINT_WORDS = /^(print|paper|book|紙|紙媒体|紙書籍|書籍|印刷|出版物)$/i;
const DIGITAL_WORDS = /^(digital|ebook|e-book|electronic|電子|電子書籍|電子版|配信|電子配信|デジタル)$/i;

/** 表記1つ → 媒体。当たらなければ null。 */
export function pubMediaOf(value: unknown): PubMedia | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (PRINT_WORDS.test(text)) return "print";
  if (DIGITAL_WORDS.test(text)) return "digital";
  return null;
}

/**
 * 条件1本の媒体。範囲の media に紙も電子も入っていれば決められない（null）。
 * 「紙と電子の両方を1本の条件で」は、出版の条件書では料率が2つ要るので
 * 成立しない。登録の側で2本に分けてもらう。
 */
export function pubMediaOfScopes(labels: Array<{ label?: unknown; code?: unknown } | string> | undefined): PubMedia | null {
  const found = new Set<PubMedia>();
  for (const entry of labels ?? []) {
    const media = typeof entry === "string"
      ? pubMediaOf(entry)
      : (pubMediaOf(entry?.code) ?? pubMediaOf(entry?.label));
    if (media) found.add(media);
  }
  return found.size === 1 ? [...found][0] : null;
}
