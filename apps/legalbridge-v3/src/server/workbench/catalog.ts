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
  // IN は著作物利用許諾基本契約書V5 の下の V5 を先に。旧基本契約の相手先は V4・V3（plan-service が並べ替える）。
  game_in: [{ key: "individual_license_terms_v5", label: "個別利用許諾条件書V5（ボードゲーム）" },
            { key: "individual_license_terms_v4", label: "個別利用許諾条件書V4（旧基本契約の相手先）" },
            { key: "individual_license_terms_v3", label: "個別利用許諾条件書V3（旧基本契約の相手先）" }],
  // 出版 IN：出版基本契約の個別契約として「出版等利用許諾条件書（作品追加の合意）」を作るのが基本（A-080・A-097）。
  // 出版許諾契約書（個人・法人）は、基本契約を兼ねる 1 通で済ませるときの代わり。
  pub_in: [{ key: "pub_license_terms_v5", label: "個別利用許諾条件書V5（出版・一覧形式）" },
           { key: "pub_license_terms_v5_annex", label: "個別利用許諾条件書V5（出版・別紙形式。作品が多いとき）" },
           { key: "pub_license_terms_v3", label: "出版等利用許諾条件書（作品追加の合意・一覧形式）" },
           { key: "pub_license_terms_v3_annex", label: "出版等利用許諾条件書（別紙形式。作品が多いとき）" },
           { key: "pub_license_terms_multi", label: "出版等利用許諾条件書（作品ごとに番号・A4 横）" },
           { key: "pub_master_individual", label: "出版許諾契約書（個人。基本契約を兼ねる 1 通）" },
           { key: "pub_master_corporate", label: "出版許諾契約書（法人。基本契約を兼ねる 1 通）" }],
  game_out: [{ key: "pub_license_terms_v3", label: "利用許諾条件書（一覧形式）" },
             { key: "pub_license_terms_v3_annex", label: "利用許諾条件書（別紙形式。作品が多いとき）" }],
  pub_out: [{ key: "pub_license_terms_v3", label: "出版等利用許諾条件書（一覧形式）" },
            { key: "pub_license_terms_v3_annex", label: "出版等利用許諾条件書（別紙形式）" }],
  service: [{ key: "purchase_order", label: "発注書" }, { key: "intl_purchase_order", label: "発注書（海外）" }],
  other: []
};

/**
 * 基本契約書。IN（ボードゲーム・出版）は出版・ボードゲーム共通の著作物利用許諾基本契約書V5。
 * 以前の出版 IN は出版許諾契約書が基本契約を兼ねていた（いまも本体の文書の候補に残る）。
 * OUT は当社が許諾者になるので、甲＝許諾者＝相手先で書いた V5 は使わず従来の利用許諾基本契約書。
 */
export const MASTER_DOC: Record<WorkbenchPattern, { key: string; label: string } | null> = {
  game_in: { key: "license_master_v5", label: "著作物利用許諾基本契約書V5" },
  pub_in: { key: "license_master_v5", label: "著作物利用許諾基本契約書V5" },
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

/** 業務委託で、準委任の時間精算（A-073）の条件の決済文書。検収書の代わりに出す。 */
export const SERVICE_COMPLETION_DOC = { key: "service_completion_notice", label: "役務提供完了通知書" };

/** 基本契約＋本体を 1 つのフォームでまとめて作れる型（document-set.ts の domain に写る）。 */
export const SET_DOMAIN: Record<WorkbenchPattern, "license" | "service" | null> = {
  game_in: "license", game_out: "license", pub_out: "license", service: "service", pub_in: "license", other: null
};

/** V5 の個別条件書か（著作物利用許諾基本契約書V5 の条を指す）。 */
export const isV5TermsKey = (key: string): boolean => /_v5(_annex)?$/.test(key) && !key.startsWith("license_master");

/**
 * 本体の文書の並び（先頭が既定）。相手先に有効な基本契約があるのに V5 の基本契約書が無い（旧基本契約の相手先）なら、
 * V5 の条件書を後ろに回す。V5 の条件書は基本契約V5 の条（第3条第5項）を指すので、旧基本契約の下では使わない。
 */
export function orderMainDocs(mains: Array<{ key: string; label: string }>, legacyMaster: boolean) {
  if (!legacyMaster) return mains;
  return [...mains.filter((m) => !isV5TermsKey(m.key)), ...mains.filter((m) => isV5TermsKey(m.key))];
}

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
