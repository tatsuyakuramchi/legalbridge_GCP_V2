import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { SearchRepository, type SearchHit } from "./repository.js";
import { ContractCheckRepository, type ContractCheckResult, type Verdict } from "../monitoring/contract-check.js";

/**
 * Slack の /法務検索。V1（release/api の /api/contract-check/search）の置き換え。
 *
 * 依頼者が知りたいのは「この相手と契約はあるか」「あの番号の件はいまどうなっているか」
 * の2つ。取引先に当たれば契約の状況（基本契約・個別の合意・直近の文書・進行中の案件）を、
 * 番号に当たればその案件・文書・依頼を返す。
 *
 * V1 の稟議番号検索（5桁の数字）は V3 に稟議の表が無いので持ってこない。
 * 用途（contract_purposes）からの推奨判定も V3 には無いので、状況の表示だけにする。
 */

export type AgreementLine = ContractCheckResult["agreements"][number];

export interface DocumentLine { documentNo: string | null; label: string; status: string; issuedOn: string | null }
export interface MatterLine { matterNo: string | null; title: string; status: string }

/** 取引先1件の契約の状況。判定と文面は画面の「契約チェック」と同じもの。 */
export interface PartyStatus {
  partyCode: string | null;
  name: string;
  matchedOn: string;
  verdict: Verdict;
  message: string;
  needsLegalReview: boolean;
  agreements: AgreementLine[];
  documents: DocumentLine[];
  openMatters: MatterLine[];
}

export interface RequestLine {
  requestNo: string | null;
  title: string;
  state: string;
  matterNo: string | null;
  backlogIssueKey: string | null;
}

export interface LegalSearchResult {
  keyword: string;
  /** 取引先に1件だけ当たれば、その契約の状況。 */
  party: PartyStatus | null;
  /** 取引先の候補が複数なら名前だけ並べて絞り込ませる。 */
  partyNames: string[];
  /** 番号・件名に当たった案件・文書・条件・作品。 */
  hits: SearchHit[];
  /** 受付箱の依頼（REQ 番号・件名・Backlog キー）。 */
  requests: RequestLine[];
  /** Backlog の課題キーから辿った案件。 */
  backlogMatters: Array<MatterLine & { issueKey: string }>;
}

export class LegalSearchService {
  private readonly repository: SearchRepository;
  private readonly contracts: ContractCheckRepository;
  constructor(private readonly database: Transactable) {
    this.repository = new SearchRepository(database);
    this.contracts = new ContractCheckRepository(database);
  }

  async search(keyword: string): Promise<LegalSearchResult> {
    const q = keyword.trim().slice(0, 100);
    const empty: LegalSearchResult = {
      keyword: q, party: null, partyNames: [], hits: [], requests: [], backlogMatters: []
    };
    if (q.length < 2) return empty;
    const like = `%${q}%`;

    try {
      const [check, hits, requestRows, backlogRows] = await Promise.all([
        this.contracts.check(q),
        this.repository.search(q, 5),
        this.database.query(
          `SELECT r.request_no, r.title, r.state, r.backlog_issue_key, m.matter_no
             FROM intake_requests r LEFT JOIN matters m ON m.id = r.matter_id
            WHERE COALESCE(r.request_no,'') ILIKE $1 OR r.title ILIKE $1
               OR COALESCE(r.backlog_issue_key,'') ILIKE $1
               OR COALESCE(r.counterparty_name,'') ILIKE $1
            ORDER BY r.created_at DESC LIMIT 5`, [like]),
        this.database.query(
          `SELECT l.target_ref AS issue_key, m.matter_no, m.title, m.status
             FROM matter_links l JOIN matters m ON m.id = l.matter_id
            WHERE l.target_type = 'backlog_issue' AND upper(l.target_ref) = upper($1)
            LIMIT 5`, [q])
      ]);

      const single = check.matches.length === 1 ? check.matches[0] : null;
      const party = single ? await this.partyStatus(single.partyId, check) : null;

      return {
        keyword: q,
        party,
        partyNames: check.matches.length > 1 ? check.matches.map((m) => m.partyName) : [],
        // 取引先は上で詳しく出すので、横断検索の取引先・支払は重ねない。
        hits: hits.filter((h) => h.target !== "party" && h.target !== "payment"),
        requests: (requestRows.rows as any[]).map((r) => ({
          requestNo: str(r.request_no), title: String(r.title), state: String(r.state),
          matterNo: str(r.matter_no), backlogIssueKey: str(r.backlog_issue_key)
        })),
        backlogMatters: (backlogRows.rows as any[]).map((r) => ({
          issueKey: String(r.issue_key), matterNo: str(r.matter_no),
          title: String(r.title), status: String(r.status)
        }))
      };
    } catch (error) { throw translate(error); }
  }

  /** 契約チェックの結果に、直近の文書と進行中の案件を足す。統合を辿った相手先で引く。 */
  private async partyStatus(partyId: number, check: ContractCheckResult): Promise<PartyStatus> {
    const match = check.matches[0];
    const [documents, matters] = await Promise.all([
      this.database.query(
        `SELECT d.document_no, d.status, d.issued_at,
                COALESCE(t.label, a.title, '文書') AS label
           FROM documents d
           LEFT JOIN document_template_versions v ON v.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = v.template_id
           LEFT JOIN agreements a ON a.id = d.agreement_id
           LEFT JOIN matters m ON m.id = d.matter_id
          WHERE d.status = 'issued'
            AND EXISTS (SELECT 1 FROM v_party_resolved pr
                         WHERE pr.resolved_id = $1
                           AND pr.party_id IN (a.counterparty_id, m.counterparty_id))
          ORDER BY d.issued_at DESC NULLS LAST, d.id DESC
          LIMIT 5`, [partyId]),
      this.database.query(
        `SELECT m.matter_no, m.title, m.status
           FROM matters m
           JOIN v_party_resolved pr ON pr.party_id = m.counterparty_id
          WHERE pr.resolved_id = $1 AND m.merged_into_id IS NULL
            AND m.status IN ('open', 'waiting', 'blocked')
          ORDER BY m.updated_at DESC LIMIT 5`, [partyId])
    ]);
    return {
      partyCode: match.partyCode, name: match.partyName, matchedOn: match.matchedOn,
      verdict: check.verdict, message: check.message, needsLegalReview: check.needsLegalReview,
      agreements: check.agreements.filter((x) => x.kind !== "document"),
      documents: (documents.rows as any[]).map((r) => ({
        documentNo: str(r.document_no), label: String(r.label), status: String(r.status),
        issuedOn: dateStr(r.issued_at)
      })),
      openMatters: (matters.rows as any[]).map((r) => ({
        matterNo: str(r.matter_no), title: String(r.title), status: String(r.status)
      }))
    };
  }
}
