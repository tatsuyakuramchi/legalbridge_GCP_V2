/**
 * 条件の利用形態（A-027）。「権利をどう使うか」の列。
 *
 * ゲームの取引形態（備考の文字列）、出版の紙・電子（許諾範囲の媒体）、
 * 実績の usage_type、と3か所に散っていたものを条件の1列にまとめる。
 * 条件書の一覧・計算書の製品名・許諾セットの登録は、推測ではなくこれを見る。
 * 画面とサーバの両方がここを見る。
 */

import type { PubMedia } from "./pub-media.js";

export type ConditionUsageType =
  | "in_house" | "sublicense" | "oem"
  | "pub_print" | "pub_digital"
  | "pub_sub_print" | "pub_sub_digital";

export interface ConditionUsageSpec {
  value: ConditionUsageType;
  label: string;
  /** ゲーム（個別利用許諾条件書）か出版（出版条件書）か。セット登録の並びに使う。 */
  family: "game" | "publishing";
  /** 個別利用許諾条件書の取引形態 id（1/2/3）。出版には無い。 */
  dealId: 1 | 2 | 3 | null;
  /** 出版の媒体。ゲームには無い。 */
  media: PubMedia | null;
  /**
   * 第三者への再許諾か（A-033）。出版の翻訳版がこれ。
   * 自社が出すのではなく、相手に出させて受領額から取り分を払う。
   */
  sublicensing?: boolean;
  hint: string;
}

export const CONDITION_USAGE_TYPES: ConditionUsageSpec[] = [
  { value: "in_house", label: "自社製造・自社販売", family: "game", dealId: 1, media: null,
    hint: "自社で作って自社で売る。基準価格 × 個数 × 料率" },
  { value: "sublicense", label: "再許諾", family: "game", dealId: 2, media: null,
    hint: "相手に許諾して、相手から受け取った額 × 料率" },
  { value: "oem", label: "自社製造・他社販売", family: "game", dealId: 3, media: null,
    hint: "自社で作って相手が売る。受領価格 × 製造個数 × 料率" },
  { value: "pub_print", label: "出版（紙）", family: "publishing", dealId: null, media: "print",
    hint: "税抜定価 × 印税対象部数 × 料率" },
  { value: "pub_digital", label: "出版（電子）", family: "publishing", dealId: null, media: "digital",
    hint: "配信価格 × ダウンロード数 × 料率" },
  // 翻訳版の再許諾（A-033）。乙が第三者に出させ、受け取った対価から甲へ払う。
  // 紙と電子で率が違うので別々に持つ。相手が決まる前でも条件を作れる。
  { value: "pub_sub_print", label: "翻訳版再許諾（紙）", family: "publishing", dealId: null,
    media: "print", sublicensing: true,
    hint: "再許諾先から受領する対価（税抜）× 料率。紙の翻訳版" },
  { value: "pub_sub_digital", label: "翻訳版再許諾（電子）", family: "publishing", dealId: null,
    media: "digital", sublicensing: true,
    hint: "再許諾先から受領する対価（税抜）× 料率。電子の翻訳版" }
];

/** 第三者への再許諾の形態か（翻訳版）。自社出版と区別する。 */
export const isSublicensingUsage = (value: unknown): boolean =>
  conditionUsageSpec(value)?.sublicensing === true;

export const conditionUsageSpec = (value: unknown): ConditionUsageSpec | null =>
  CONDITION_USAGE_TYPES.find((t) => t.value === value) ?? null;

export const conditionUsageLabel = (value: unknown): string =>
  conditionUsageSpec(value)?.label ?? String(value ?? "");

/** 利用形態 → 個別利用許諾条件書の取引形態 id。出版・未設定は null。 */
export const dealIdOfUsage = (value: unknown): 1 | 2 | 3 | null =>
  conditionUsageSpec(value)?.dealId ?? null;

/** 利用形態 → 出版の媒体。ゲーム・未設定は null。 */
export const pubMediaOfUsage = (value: unknown): PubMedia | null =>
  conditionUsageSpec(value)?.media ?? null;

/**
 * 出版の媒体 → 利用形態。自社出版か翻訳版再許諾かで分かれる。
 */
export const usageOfPubMedia = (media: PubMedia, sublicensing = false): ConditionUsageType =>
  sublicensing
    ? (media === "print" ? "pub_sub_print" : "pub_sub_digital")
    : (media === "print" ? "pub_print" : "pub_digital");
