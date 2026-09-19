/**
 * 実績を「決済する」文書かどうか。
 *
 * 実績（納品・検収・売上）の出どころは発注書だが、その実績に基づいて作るのは
 * 検収書・納品書（業務委託）や利用許諾料計算書（許諾）で、支払はそこから起こる。
 * 実績が結びつく（document_id を持つ）のはこの決済文書だけ。発注書や条件書を
 * 実績から作っても、その文書が実績を占有してはいけない。占有すると、本来の
 * 検収書・計算書が「別の文書に結びついている」と弾かれて作れなくなる。
 *
 * ひな形の鍵で見る。案件の支払タブ（MatterPayments）が使う判定と同じにしてある。
 */
export const SETTLEMENT_TEMPLATE_PATTERN = /inspection|acceptance|delivery|statement|royalty/;

export function settlesEvents(templateKey: string | null | undefined): boolean {
  return SETTLEMENT_TEMPLATE_PATTERN.test(String(templateKey ?? ""));
}

/** 条件の種類ごとに、実績を決済する文書の呼び名とひな形。 */
export function settlementDocFor(kind: string | null | undefined): { label: string; templateKey: string } {
  return kind === "license" || kind === "product"
    ? { label: "計算書", templateKey: "royalty_statement" }
    : { label: "検収書", templateKey: "inspection_certificate" };
}
