/** CSV の日付。2026/10/31 も 2026-10-31 も読む。読めなければ null（呼ぶ側が不備にする）。 */
export const normalizeDate = (v: string | undefined): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
};
