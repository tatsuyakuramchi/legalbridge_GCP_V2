/**
 * 定型文の区分。
 *
 * 表の CHECK（A-021）と画面の見出しを1か所から出す。この表は定型文の画面と
 * 文書作成の貼り付け欄（クライアント）からも読むので、サーバ側の道具
 * （db・監査）を持ち込まない。持ち込むとブラウザ側の束に入る。
 *
 * scope は V3 で足した区分。許諾範囲は V2 でも定型文から貼っていたが、
 * 区分が無かったので「特約・備考」か「その他」に混ざっていた。
 */
export const SNIPPET_CATEGORIES = ["scope", "special_terms", "work_item", "other"] as const;
export type SnippetCategory = (typeof SNIPPET_CATEGORIES)[number];

export const SNIPPET_CATEGORY_LABEL: Record<string, string> = {
  scope: "許諾範囲",
  special_terms: "特約・備考",
  work_item: "業務明細・仕様",
  other: "その他"
};
