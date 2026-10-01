/**
 * 前金・後金（入金区分）と、その説明（計算書の備考に出る文）。
 * 説明は前に書いたものをこのブラウザに覚えておき、次の報告の初期値にする
 * （毎回同じ文を打たないため。覚えられなくても空から書けば動く）。
 */
export type Stage = "" | "advance" | "balance";
export const STAGE_LABEL: Record<"advance" | "balance", string> = { advance: "前金", balance: "後金" };

const key = (stage: "advance" | "balance") => `lb.royalty.stageNote.${stage}`;

export function loadStageNote(stage: Stage): string {
  if (!stage) return "";
  try { return window.localStorage.getItem(key(stage)) ?? ""; } catch { return ""; }
}
export function saveStageNote(stage: Stage, text: string): void {
  if (!stage) return;
  try { window.localStorage.setItem(key(stage), text.trim()); } catch { /* 覚えられなくてもよい */ }
}
export const STAGE_NOTE_PLACEHOLDER: Record<"advance" | "balance", string> = {
  advance: "例）前金：製造時に許諾先から受領した前払金に対する利用許諾料です",
  balance: "例）後金：出荷後に許諾先から受領した残金に対する利用許諾料です"
};
