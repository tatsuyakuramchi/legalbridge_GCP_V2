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
import { isQuasiMandate } from "../conditions/time-settlement.js";

export const SETTLEMENT_TEMPLATE_PATTERN = /inspection|acceptance|delivery|statement|royalty|completion/;

/**
 * 役務提供完了通知書（A-073）。準委任で時間精算（月間包括枠＋実績時間）の委託料の決済文書。
 * 検収書の役務提供版：成果物の検収ではなく、その月の役務の提供が完了したことを確認する。
 */
export const SERVICE_COMPLETION_KEY = "service_completion_notice";

/**
 * 利用許諾料計算書のひな形。従来の計算書と、出版（紙・電子）専用の計算書
 * （本文に作品ごとの要約、別紙に報告月・書店ごとの明細。royalty/statement-issue.ts）。
 * 計算書かどうかはここで見る（鍵を 1 つに決め打ちすると、出版の計算書が
 * 送付・経理提出・工程表から漏れる）。
 */
export const ROYALTY_STATEMENT_KEYS = ["royalty_statement", "royalty_statement_pub"];
export const isRoyaltyStatementKey = (templateKey: string | null | undefined): boolean =>
  ROYALTY_STATEMENT_KEYS.includes(String(templateKey ?? ""));

export function settlesEvents(templateKey: string | null | undefined): boolean {
  return SETTLEMENT_TEMPLATE_PATTERN.test(String(templateKey ?? ""));
}

/**
 * 条件ごとに、実績を決済する文書の呼び名とひな形。
 *   許諾・製品 … 計算書
 *   委託料で 準委任（契約形式）か時間精算（A-073） … 役務提供完了通知書
 *     （準委任は仕事の完成を約束しないので「検収」は無い。役務の提供が完了したことを通知する）
 *   それ以外の業務委託（請負など） … 検収書
 * 種類の文字だけを渡す古い呼び方も通す（契約形式・時間精算は見ない）。
 */
export function settlementDocFor(
  c: string | null | undefined
    | { kind: string | null | undefined; timeSettlement?: boolean | null; contractForm?: string | null }
): { label: string; templateKey: string } {
  const kind = typeof c === "string" || c === null || c === undefined ? c : c.kind;
  const time = typeof c === "object" && c !== null ? c.timeSettlement === true : false;
  const quasi = typeof c === "object" && c !== null ? isQuasiMandate(c.contractForm) : false;
  if (kind === "license" || kind === "product") return { label: "計算書", templateKey: "royalty_statement" };
  if (kind === "service" && (time || quasi)) return { label: "役務提供完了通知書", templateKey: SERVICE_COMPLETION_KEY };
  return { label: "検収書", templateKey: "inspection_certificate" };
}
