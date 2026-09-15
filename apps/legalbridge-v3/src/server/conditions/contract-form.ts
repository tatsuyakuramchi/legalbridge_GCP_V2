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
