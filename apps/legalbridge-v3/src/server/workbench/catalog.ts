/**
 * 作業テーブル（文書を作る・登録する・繋ぐ 1 枚の画面）が「要る文書」を出すための表。
 *
 * 取引の型（ボードゲーム・出版の IN／OUT、業務委託）ごとに、基本契約・本体の文書・
 * 決済文書のひな形を 1 か所で持つ。以前は「取引を進める」「条件明細」「作品」
 * 「デイリータスク」の 4 画面が、それぞれの表でひな形を決めていた。
 */

export type WorkbenchPattern = "game_in" | "game_out" | "pub_in" | "pub_out" | "service" | "other";

export const PATTERN_LABEL: Record<WorkbenchPattern, string> = {
  game_in: "ボードゲーム IN（権利を取得）", game_out: "ボードゲーム OUT（許諾）",
  pub_in: "出版 IN（権利を取得）", pub_out: "出版 OUT（許諾）",
  service: "業務委託（発注）", other: "その他"
};

export const isOutPattern = (p: WorkbenchPattern) => p === "game_out" || p === "pub_out";

/** 本体の文書（条件書・発注書）。先頭が既定。V4 を先に、V3 を後に並べて選ばせる。 */
export const MAIN_DOCS: Record<WorkbenchPattern, Array<{ key: string; label: string }>> = {
  game_in: [{ key: "individual_license_terms_v4", label: "個別利用許諾条件書V4" },
            { key: "individual_license_terms_v3", label: "個別利用許諾条件書V3" }],
  pub_in: [{ key: "pub_master_individual", label: "出版許諾契約書（個人）" },
           { key: "pub_master_corporate", label: "出版許諾契約書（法人）" }],
  game_out: [{ key: "pub_license_terms_v3", label: "利用許諾条件書（一覧形式）" },
             { key: "pub_license_terms_v3_annex", label: "利用許諾条件書（別紙形式。作品が多いとき）" }],
  pub_out: [{ key: "pub_license_terms_v3", label: "出版等利用許諾条件書（一覧形式）" },
            { key: "pub_license_terms_v3_annex", label: "出版等利用許諾条件書（別紙形式）" }],
  service: [{ key: "purchase_order", label: "発注書" }, { key: "intl_purchase_order", label: "発注書（海外）" }],
  other: []
};

/** 基本契約書。出版 IN は出版許諾契約書そのものが基本契約を兼ねるので無い。 */
export const MASTER_DOC: Record<WorkbenchPattern, { key: string; label: string } | null> = {
  game_in: { key: "license_master", label: "利用許諾基本契約書" },
  pub_in: null,
  game_out: { key: "license_master", label: "利用許諾基本契約書" },
  pub_out: { key: "license_master", label: "利用許諾基本契約書" },
  service: { key: "service_master", label: "業務委託基本契約書" },
  other: null
};

/** 決済文書（あとで要る）。実績が出てから作る。 */
export const SETTLEMENT_DOC: Record<WorkbenchPattern, { key: string; label: string } | null> = {
  game_in: { key: "royalty_statement", label: "利用許諾料計算書" },
  pub_in: { key: "royalty_statement_pub", label: "利用許諾料計算書（出版）" },
  game_out: { key: "royalty_statement", label: "利用許諾料計算書" },
  pub_out: { key: "royalty_statement", label: "利用許諾料計算書" },
  service: { key: "inspection_certificate", label: "検収書" },
  other: null
};

/** 基本契約＋本体を 1 つのフォームでまとめて作れる型（document-set.ts の domain に写る）。 */
export const SET_DOMAIN: Record<WorkbenchPattern, "license" | "service" | null> = {
  game_in: "license", game_out: "license", pub_out: "license", service: "service", pub_in: null, other: null
};

/** 本体の文書に載せる条件。型ごとに向きと種類が決まる。 */
export function conditionMatches(p: WorkbenchPattern, c: { direction: string; kind: string }): boolean {
  if (p === "service") return c.direction === "in" && (c.kind === "service" || c.kind === "expense" || c.kind === "fee");
  if (isOutPattern(p)) return c.direction === "out" && c.kind === "license";
  if (p === "other") return true;
  return c.direction === "in" && c.kind === "license";
}

/**
 * 条件の並びから取引の型を推す。案件・依頼の種類で決まらないとき（相手先だけから入ったとき）に使う。
 * 推せなければ other。
 */
export function inferPattern(
  conditions: Array<{ direction: string; kind: string; usageType?: string | null }>,
  hint: { kind?: string | null; businessLine?: string | null } = {}
): WorkbenchPattern {
  if (hint.kind === "outsourcing") return "service";
  const lic = conditions.filter((c) => c.kind === "license" || c.kind === "product");
  const pub = lic.some((c) => String(c.usageType ?? "").startsWith("pub_")) || hint.businessLine === "publishing";
  if (lic.length) {
    const out = lic.filter((c) => c.direction === "out").length;
    const inn = lic.length - out;
    if (out > inn) return pub ? "pub_out" : "game_out";
    return pub ? "pub_in" : "game_in";
  }
  if (conditions.some((c) => c.direction === "in" && (c.kind === "service" || c.kind === "expense" || c.kind === "fee"))) return "service";
  if (hint.kind === "work") return pub ? "pub_in" : "game_in";
  return "other";
}
