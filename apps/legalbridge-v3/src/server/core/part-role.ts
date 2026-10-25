/**
 * 作品の構成要素（work_parts）の役割：コアロジック／サブコンポーネント（A-078）。
 *
 * ゲームでは原作のゲームデザインがコア、追加のイラスト等がサブ。出版では原稿がコア、
 * イラスト・装丁等がサブ。これまで役割は素材の種別（part_type）から読んでいて、
 * 出版の素材には読める種別が無かった。work_parts.part_role に明示で持ち、無ければ
 * 種別から導く（game_design・text はコア、それ以外はサブ）。
 */
export type PartRole = "core" | "sub";
export const PART_ROLES: readonly PartRole[] = ["core", "sub"];
export const PART_ROLE_LABEL: Record<PartRole, string> = { core: "コアロジック", sub: "サブコンポーネント" };
/** 出版の言い方。画面の補足に使う。 */
export const PART_ROLE_HINT: Record<PartRole, string> = {
  core: "作品の中心（原作のゲームデザイン・原稿）。利用許諾条件の中心になる",
  sub: "作品を構成する追加の要素（イラスト・装丁・音楽など）。コアとは別に許諾条件が立つ"
};

/** 役割。明示があればそれ、無ければ種別から導く。 */
export function partRoleOf(partType: unknown, partRole: unknown): PartRole {
  if (partRole === "core" || partRole === "sub") return partRole;
  const t = String(partType ?? "");
  return t === "game_design" || t === "text" ? "core" : "sub";
}

export const partRoleLabel = (partType: unknown, partRole: unknown): string => PART_ROLE_LABEL[partRoleOf(partType, partRole)];
