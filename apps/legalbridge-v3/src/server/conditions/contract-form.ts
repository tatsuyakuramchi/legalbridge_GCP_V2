/**
 * 契約形式（請負・委任など）。
 *
 * これまで「契約種別・支払条件」という1つの欄に、実は2つの別のことが
 * 入っていた。
 *
 *   ・契約形式 … 請負／委任。何の契約かを紙に書くための語
 *   ・支払条件 … 月末締め翌月末払い。読んで支払期日を出すための語
 *
 * 同じ列（payment_terms）に入れていたので、「請負」と書くと支払条件として
 * 読めず、支払期日の自動計算が黙って効かなくなっていた。列を分ける。
 *
 * 選択肢は決めておくが、書き足せるようにする（自由記入）。よく使う形は
 * 表記を揃えたいが、当てはまらない契約が出たときに登録できないと運用が
 * 止まる。画面は datalist で「選べるが打てる」形にしてある。
 */

export const CONTRACT_FORMS: string[] = [
  "請負", "委任", "準委任", "売買", "派遣", "業務提携", "利用許諾"
];

/** 海外版の発注書に書く契約形式（英語）。国内の語との対応は CONTRACT_FORM_EN。 */
export const CONTRACT_FORMS_EN: string[] = [
  "Contract for Work", "Service Agreement", "Mandate", "Quasi-mandate", "Sale", "License", "Consulting"
];

/** 国内の契約形式 → 海外版の語。英語で書いてあればそのまま。 */
export const CONTRACT_FORM_EN: Record<string, string> = {
  請負: "Contract for Work", 委任: "Mandate", 準委任: "Quasi-mandate", 売買: "Sale",
  派遣: "Staffing", 業務提携: "Business alliance", 利用許諾: "License"
};

/** 「請負／委任」のように並んだ語も 1 つずつ英語にする。表に無い語はそのまま。 */
export function contractFormEn(value: unknown): string {
  return String(value ?? "").split(/[／/]/).map((v) => CONTRACT_FORM_EN[v.trim()] ?? v.trim())
    .filter(Boolean).join(" / ");
}

/** 入力された契約形式を整える。空白だけなら null。 */
export function readContractForm(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  return text || null;
}

/**
 * その回に効く契約形式。実績 → 予定 → 条件 の順に、書いてあるものを使う。
 *
 * 回ごとに違うことがある（着手は請負、運用は準委任）。書いていない回は
 * 条件のものを継ぐ。空欄のまま紙に出さないための順番。
 */
export function contractFormFor(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }
  return null;
}

/**
 * 業務委託の期日の形（A-121）。
 *   請負（・売買）… 成果物が前提。期日は「納期」だけ。
 *   準委任（・委任）… 役務を提供する。期日は「役務提供期間（開始・終了）」。成果物があれば納期も。
 *   未定 … 契約形式が決まっていない（全部の欄を出す）。
 */
export type WorkShape = "ukeoi" | "junin" | "unknown";
export function workShapeOf(contractForm: string | null | undefined): WorkShape {
  const s = String(contractForm ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("請負") || s.includes("売買") || s.includes("contract for work") || s === "sale") return "ukeoi";
  if (s.includes("委任") || s.includes("mandate") || s.includes("派遣") || s.includes("service agreement")
      || s.includes("consulting") || s.includes("staffing")) return "junin";
  return "unknown";
}
