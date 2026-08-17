// 敬称（御中／様）の決定。サーバ（PDF生成）とフォーム（警告表示）で同じ規則を使う。
//
// 実データで起きた不具合: 取引先ボタンで法人を引いたあと宛名だけ個人名に書き換えると、
// 区分と敬称に前の法人の「法人／御中」が残る。この状態で敬称をそのまま採用すると、
// 区分を「個人」へ直しても PDF は「御中」で出続けた（ARC-PO-2026-0115）。
// そのため、区分と敬称が食い違うときは区分を優先する。

/** 相手先の種別を「個人」と判定するか。文字列（法人／個人）と boolean の両方を受ける。 */
export function isIndividualEntity(value: unknown): boolean {
  if (value === false) return true;
  const text = String(value ?? "").trim();
  return text === "個人" || text === "false";
}

/** 区分が入力されているか。空なら敬称の手入力に従う。 */
export function hasEntityType(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  return String(value ?? "").trim() !== "";
}

/**
 * 敬称を決める。
 * - 敬称が空なら区分から導出する（個人=様／それ以外=御中）。
 * - 区分が空なら手入力の敬称に従う。
 * - 区分と逆の敬称（個人×御中／法人×様）は区分を優先する。
 * - 「殿」は法人・個人どちらにも使うため矛盾とみなさず尊重する。
 */
export function resolveHonorific(entityType: unknown, suffix: unknown): string {
  const explicit = String(suffix ?? "").trim();
  const expected = expectedHonorific(entityType);
  if (!explicit) return expected;
  if (!hasEntityType(entityType)) return explicit;
  return contradictsEntityType(entityType, explicit) ? expected : explicit;
}

/** 区分から導かれる敬称。 */
export function expectedHonorific(entityType: unknown): string {
  return isIndividualEntity(entityType) ? "様" : "御中";
}

/** 区分と敬称が食い違っているか（「殿」など第三の敬称は食い違いに数えない）。 */
export function contradictsEntityType(entityType: unknown, suffix: unknown): boolean {
  const explicit = String(suffix ?? "").trim();
  if (!explicit || !hasEntityType(entityType)) return false;
  return isIndividualEntity(entityType) ? explicit === "御中" : explicit === "様";
}

// 宛名の突き合わせ用の正規化。全角空白・連続空白・前後の空白だけを均す。
// 「株式会社」の有無などは同一視しない（別法人を同じ扱いにしてしまう）。
function normalizeName(value: unknown): string {
  return String(value ?? "").replace(/[\s　]+/g, " ").trim();
}

/**
 * 取引先マスタの区分を、その文書の宛名に対して使えるかどうか判定して返す。
 * 使えない（宛名がマスタのどの名称とも一致しない）ときは空文字。
 *
 * documents.vendor_id は確定時に「宛名から」引くので、名称が一致する限りマスタは
 * 同じ相手を指す。逆に、後から宛名を別人へ書き換えた文書では一致しないため、
 * 前の取引先の区分で上書きしてしまう事故を防げる。
 */
export function masterEntityTypeFor(
  partyName: unknown,
  master: { entityType?: string | null; names?: readonly (string | null | undefined)[] } | null | undefined
): string {
  const entityType = String(master?.entityType ?? "").trim();
  if (!entityType) return "";
  const name = normalizeName(partyName);
  if (!name) return "";
  const matches = (master?.names ?? []).some((candidate) => normalizeName(candidate) === name);
  return matches ? entityType : "";
}

type HonorificParty = {
  label: string;
  entityKeys: readonly string[];
  suffixKeys: readonly string[];
};

// フォームの項目名は文書ごとに揺れる（英語キーと日本語キーが混在）。
const HONORIFIC_PARTIES: readonly HonorificParty[] = [
  {
    label: "取引先",
    entityKeys: ["VENDOR_IS_CORPORATION", "取引先種別", "vendorEntityType"],
    suffixKeys: ["VENDOR_SUFFIX", "取引先敬称"]
  },
  {
    label: "許諾者",
    entityKeys: ["LICENSOR_IS_CORPORATION", "許諾者種別", "licensorEntityType"],
    suffixKeys: ["LICENSOR_SUFFIX", "許諾者敬称"]
  }
];

function firstFilled(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

export type HonorificWarning = { label: string; entityType: string; suffix: string; message: string };

/**
 * 区分と敬称が食い違っている相手先を挙げる。フォームで気づけるようにするためのもので、
 * PDF 側は resolveHonorific が区分を優先して正しく出す（警告は入力を直す案内）。
 */
export function honorificWarnings(formData: Record<string, unknown> | undefined | null): HonorificWarning[] {
  if (!formData) return [];
  const warnings: HonorificWarning[] = [];
  for (const party of HONORIFIC_PARTIES) {
    const entityType = firstFilled(formData, party.entityKeys);
    const suffix = firstFilled(formData, party.suffixKeys);
    if (!contradictsEntityType(entityType, suffix)) continue;
    const entityLabel = isIndividualEntity(entityType) ? "個人" : "法人";
    const expected = expectedHonorific(entityType);
    warnings.push({
      label: party.label,
      entityType: entityLabel,
      suffix: String(suffix).trim(),
      message: `${party.label}の区分が「${entityLabel}」なのに敬称が「${String(suffix).trim()}」です。`
        + `PDF は区分を優先して「${expected}」で出力します。`
    });
  }
  return warnings;
}
