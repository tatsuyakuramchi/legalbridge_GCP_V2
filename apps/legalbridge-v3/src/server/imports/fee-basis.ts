import type { LicenseFeeBasis } from "../core/model.js";

/** 許諾料の扱い（A-048）の CSV 表記 → 値。空は「別途」。書き出し（export.ts）と対。 */
export const FEE_BASIS: Record<string, LicenseFeeBasis> = {
  別途: "separate", 別途定める: "separate", separate: "separate",
  業務委託報酬に含む: "included", 報酬に含む: "included", 含む: "included", included: "included",
  無償: "free", 無料: "free", free: "free"
};
