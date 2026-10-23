import type { LicenseFeeBasis } from "../core/model.js";

/** 許諾料の扱い（A-048）の CSV 表記 → 値。空は「別途」。書き出し（export.ts）と対。 */
export const FEE_BASIS: Record<string, LicenseFeeBasis> = {
  別途: "separate", 別途定める: "separate", separate: "separate",
  業務委託報酬に含む: "included", 報酬に含む: "included", 含む: "included", included: "included",
  無償: "free", 無料: "free", free: "free",
  // 制作対価を利用許諾料で払う発注（A-075）。保証利用許諾料が委託料の行の確定額。
  保証利用許諾料に代える: "in_lieu", 保証利用許諾料: "in_lieu", 制作対価を兼ねる: "in_lieu", in_lieu: "in_lieu"
};
