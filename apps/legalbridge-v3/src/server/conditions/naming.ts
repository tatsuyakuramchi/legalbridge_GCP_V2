import { CONDITION_USAGE_TYPES, type ConditionUsageType } from "../core/condition-usage.js";

/**
 * 利用許諾条件の条件名の規則。
 *
 * 文書を作るときの条件検索で、人が付けた名前（「ito 原作ゲームデザイン」
 * 「◯◯ 英語版」）では、どの作品のどの使い方の料率か読めず迷っていた。
 * 作品に紐づく許諾の条件は、名前を打たせず
 *
 *   作品名｜取引モデル
 *
 * で組む。取引モデルはゲームなら「自社製造・自社販売」「再許諾」
 * 「自社製造・他社販売」、出版なら「紙出版」「電子出版」「再許諾」。
 * 再許諾だけは相手と目的で1本ずつ分かれるので
 *
 *   作品名｜再許諾（再許諾先／目的）
 *
 * とする。画面（セット登録・条件登録）も CSV 取込もサーバも同じ関数を通す。
 */

/** 条件名に使う取引モデルの呼び名。出版は「出版（紙）」ではなく「紙出版」で揃える。 */
export const USAGE_NAME_LABEL: Record<ConditionUsageType, string> = {
  in_house: "自社製造・自社販売",
  sublicense: "再許諾",
  oem: "自社製造・他社販売",
  pub_print: "紙出版",
  pub_digital: "電子出版"
};

export const NAME_SEPARATOR = "｜";

export interface NamingInput {
  workTitle: string;
  usageType: ConditionUsageType;
  /** 再許諾先の名称。再許諾のときだけ。 */
  sublicensee?: string | null;
  /** 再許諾の目的（例：英語版の製造販売、翻訳出版）。再許諾のときだけ。 */
  purpose?: string | null;
}

/** 規則どおりの条件名。再許諾で再許諾先が無ければ null（付けられない）。 */
export function conditionNameFor(input: NamingInput): string | null {
  const title = String(input.workTitle ?? "").trim();
  if (!title) return null;
  const label = USAGE_NAME_LABEL[input.usageType];
  if (!label) return null;
  if (input.usageType === "sublicense") {
    const to = String(input.sublicensee ?? "").trim();
    const why = String(input.purpose ?? "").trim();
    if (!to) return null;
    return `${title}${NAME_SEPARATOR}${label}（${why ? `${to}／${why}` : to}）`;
  }
  return `${title}${NAME_SEPARATOR}${label}`;
}

/**
 * 取引モデルの文字列を利用形態へ。CSV や旧い表記（「出版（紙）」「紙」「電子」、
 * 英字コード）も受ける。当たらなければ null。
 */
export function parseUsageType(text: unknown): ConditionUsageType | null {
  const s = String(text ?? "").trim().replace(/\s+/g, "").replace(/[()（）]/g, "");
  if (!s) return null;
  for (const u of CONDITION_USAGE_TYPES) {
    if (u.value === s.toLowerCase()) return u.value;
    if (USAGE_NAME_LABEL[u.value].replace(/[()（）]/g, "") === s) return u.value;
    if (u.label.replace(/[()（）]/g, "") === s) return u.value;
  }
  const alias: Record<string, ConditionUsageType> = {
    紙: "pub_print", 出版紙: "pub_print", 紙出版: "pub_print", print: "pub_print",
    電子: "pub_digital", 出版電子: "pub_digital", 電子出版: "pub_digital", digital: "pub_digital",
    自社製造自社販売: "in_house", 自社販売: "in_house",
    自社製造他社販売: "oem", 他社販売: "oem",
    再許諾: "sublicense", サブライセンス: "sublicense"
  };
  return alias[s] ?? alias[s.replace(/[・･]/g, "")] ?? null;
}
