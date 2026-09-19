import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 契約チェック。
 *
 * 「この相手と、いま有効な契約があるか」を依頼の前に自分で確かめるための
 * 読み取り。法務への問い合わせを減らすのが目的なので、判定は保守的にする。
 * 「たぶん大丈夫」を返さない。分からないときは分からないと言う。
 *
 * 相手先は統合を辿って探す。名寄せ前の名前で引いても見つかるようにする。
 */

export type Verdict = "covered" | "expiring" | "expired" | "none" | "ambiguous";

export interface ContractCheckMatch {
  partyId: number;
  partyName: string;
  partyCode: string | null;
  /** 入力名と一致した理由。別名で当たったのか正式名称かを見せる。 */
  matchedOn: string;
}

export interface ContractCheckResult {
  query: string;
  verdict: Verdict;
  /** 人が読む結論。画面にそのまま出す。 */
  message: string;
  /** 法務の確認が要るか。 */
  needsLegalReview: boolean;
  matches: ContractCheckMatch[];
  agreements: Array<{
    id: number; agreementNo: string | null; title: string; status: string;
    effectiveOn: string | null; expiresOn: string | null; autoRenewal: boolean;
    daysToExpiry: number | null;
  }>;
  conditions: Array<{
    id: number; conditionNo: string | null; name: string; direction: string;
    status: string; termStart: string | null; termEnd: string | null;
  }>;
}

/** 満了までこの日数を切ったら「まもなく切れる」として扱う。 */
const EXPIRING_SOON_DAYS = 60;

export class ContractCheckRepository {
  constructor(private readonly database: Transactable) {}

  async check(query: string): Promise<ContractCheckResult> {
    const q = String(query ?? "").trim();
    if (q.length < 2) {
      return {
        query: q, verdict: "none", needsLegalReview: false,
        message: "2文字以上で検索してください。",
        matches: [], agreements: [], conditions: []
      };
    }

    try {
      const keyword = `%${q}%`;
      const found = await this.database.query(
        `SELECT pr.resolved_id AS id, pr.resolved_name AS name, p.party_code,
                CASE
                  WHEN btrim(p.name) = btrim($2) THEN '正式名称と一致'
                  WHEN p.name ILIKE $1            THEN '名称の一部が一致'
                  WHEN EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE btrim(a) = btrim($2))
                                                  THEN '別名と一致'
                  WHEN EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE $1)
                                                  THEN '別名の一部が一致'
                  ELSE 'コードが一致'
                END AS matched_on,
                (p.id <> pr.resolved_id) AS via_merge
           FROM parties p
           JOIN v_party_resolved pr ON pr.party_id = p.id
          WHERE p.name ILIKE $1
             OR COALESCE(p.party_code,'') ILIKE $1
             OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE $1)
          ORDER BY (btrim(p.name) = btrim($2)) DESC, p.name
          LIMIT 10`, [keyword, q]);

      // 統合を辿った結果が同じ相手先なら1件にまとめる。
      const matches: ContractCheckMatch[] = [];
      for (const row of found.rows as any[]) {
        const id = Number(row.id);
        if (matches.some((m) => m.partyId === id)) continue;
        matches.push({
          partyId: id, partyName: String(row.name), partyCode: str(row.party_code),
          matchedOn: String(row.matched_on) + (row.via_merge ? "（統合前の名前）" : "")
        });
      }

      if (!matches.length) {
        return {
          query: q, verdict: "none", needsLegalReview: true,
          message: `「${q}」に一致する取引先がありません。` +
                   "取引先が未登録か、名称が違う可能性があります。法務に相談してください。",
          matches: [], agreements: [], conditions: []
        };
      }
      if (matches.length > 1) {
        return {
          query: q, verdict: "ambiguous", needsLegalReview: false,
          message: `${matches.length} 件の候補が見つかりました。どれか1つに絞って確認してください。`,
          matches, agreements: [], conditions: []
        };
      }

      const partyId = matches[0].partyId;
      const [ag, cond] = await Promise.all([
        this.database.query(
          `SELECT a.id, a.agreement_no, a.title, a.status, a.effective_on, a.expires_on,
                  a.auto_renewal,
                  CASE WHEN a.expires_on IS NULL THEN NULL
                       ELSE (a.expires_on - current_date) END AS days_to_expiry
             FROM agreements a
             JOIN v_party_resolved pr ON pr.party_id = a.counterparty_id
            WHERE pr.resolved_id = $1
            ORDER BY a.expires_on DESC NULLS FIRST, a.id DESC LIMIT 50`, [partyId]),
        this.database.query(
          `SELECT c.id, c.condition_no, c.name, c.direction, c.status, c.term_start, c.term_end
             FROM conditions c
             JOIN v_party_resolved pr ON pr.party_id = c.counterparty_id
            WHERE pr.resolved_id = $1 AND c.status = 'active'
            ORDER BY c.term_end DESC NULLS FIRST, c.id DESC LIMIT 50`, [partyId])
      ]);

      const agreements = (ag.rows as any[]).map((x) => ({
        id: Number(x.id), agreementNo: str(x.agreement_no), title: String(x.title),
        status: String(x.status), effectiveOn: dateStr(x.effective_on),
        expiresOn: dateStr(x.expires_on), autoRenewal: x.auto_renewal === true,
        daysToExpiry: x.days_to_expiry === null ? null : Number(x.days_to_expiry)
      }));
      const conditions = (cond.rows as any[]).map((x) => ({
        id: Number(x.id), conditionNo: str(x.condition_no), name: String(x.name),
        direction: String(x.direction), status: String(x.status),
        termStart: dateStr(x.term_start), termEnd: dateStr(x.term_end)
      }));

      return { query: q, matches, agreements, conditions, ...verdictFor(matches[0].partyName, agreements) };
    } catch (error) { throw translate(error); }
  }
}

/** 判定。期限切れと「期限なし」を取り違えない。 */
function verdictFor(
  partyName: string,
  agreements: ContractCheckResult["agreements"]
): { verdict: Verdict; message: string; needsLegalReview: boolean } {
  const executed = agreements.filter((a) => a.status === "executed");
  if (!executed.length) {
    const drafts = agreements.filter((a) => a.status === "draft" || a.status === "negotiating");
    return {
      verdict: "none", needsLegalReview: true,
      message: drafts.length
        ? `${partyName} との契約は交渉中・下書きの段階です（${drafts.length} 件）。締結前に発注しないでください。`
        : `${partyName} との締結済みの契約が見つかりません。法務に相談してください。`
    };
  }

  // 期限なしの締結済み契約が1つでもあれば、期間の心配は要らない。
  const openEnded = executed.filter((a) => a.expiresOn === null);
  if (openEnded.length) {
    return {
      verdict: "covered", needsLegalReview: false,
      message: `${partyName} とは締結済みの契約があります（期限の定めなし）。`
    };
  }

  const live = executed.filter((a) => (a.daysToExpiry ?? -1) >= 0);
  if (!live.length) {
    const latest = executed[0];
    return {
      verdict: "expired", needsLegalReview: true,
      message: `${partyName} との契約は ${latest.expiresOn} に満了しています。` +
               "更新するまで新しい発注はできません。法務に相談してください。"
    };
  }

  const soonest = live.reduce((a, b) => ((a.daysToExpiry ?? 0) <= (b.daysToExpiry ?? 0) ? a : b));
  const days = soonest.daysToExpiry ?? 0;
  const furthest = live.reduce((a, b) => ((a.daysToExpiry ?? 0) >= (b.daysToExpiry ?? 0) ? a : b));

  if ((furthest.daysToExpiry ?? 0) < EXPIRING_SOON_DAYS) {
    return {
      verdict: "expiring", needsLegalReview: true,
      message: `${partyName} との契約はあと ${days} 日で満了します（${soonest.expiresOn}）。` +
               (soonest.autoRenewal
                 ? "自動更新の定めがありますが、通知期限を確認してください。"
                 : "更新の要否を法務に相談してください。")
    };
  }

  return {
    verdict: "covered", needsLegalReview: false,
    message: `${partyName} とは有効な契約があります（${furthest.expiresOn} まで）。`
  };
}
