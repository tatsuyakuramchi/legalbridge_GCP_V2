import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, inTransaction, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { addMonths, renewalLabel } from "./renewal.js";

/**
 * 許諾期間の入っていない条件に、基本契約と同じ「3 年・以後 3 年ごとに自動更新」を入れる。
 *
 * 契約書の無い条件から一括で条件書を作ったところ、条件に終了日が無く、条件書の許諾期間が
 * 「期間の定めなし」「更新なし」で出た。基本契約に合わせて、開始日から 3 年（満了日は
 * 開始日の 3 年後の前日）、自動更新・3 年ごととして条件に書き込む。更新の回数は列に持たず、
 * 条件書の締結日から数える（renewal.ts）。開始が古い条件は「2018.4.1〜2027.3.31（更新 2回）」になる。
 *
 * 対象：出版の条件書（下書き・決定済み）に載っている、有効な取得（IN）の条件で、
 * 終了日が空のもの。開始日も空の条件は計算できないので直さない（理由を出す）。
 *
 * 期間は額に関わらないので、支払が立っている条件もその場で書き換える（改訂にしない。
 * 改訂にすると条件の id が替わり、条件書から辿れなくなる）。前後は監査に残す。
 *
 * 決定済みの条件書は中身が凍っているので、直した条件を載せた条件書を訂正版で出し直す
 * （reissueTargets / reissue）。下書きは開き直せば新しい期間で出る。
 *
 * 必ず試算（preview）を見てから直す。試算は何も書かない。
 */

/** 基本契約の期間と更新の単位（月）。 */
export const DEFAULT_TERM_MONTHS = 36;

export const PUB_TERMS_TEMPLATE_KEYS = ["pub_license_terms_v3", "pub_license_terms_v3_annex", "pub_license_terms"];

export interface TermTarget {
  conditionId: number;
  conditionNo: string | null;
  conditionName: string;
  partyId: number | null;
  partyName: string | null;
  workTitle: string | null;
  documentNos: string[];
  termStart: string | null;
  /** 入れる終了日（開始日の 3 年後の前日）。開始日が無ければ null。 */
  newTermEnd: string | null;
  /** 今日の時点の許諾期間（更新の回数つき）。 */
  label: string | null;
  /** 直せない理由（開始日が無い）。 */
  skip: string | null;
}

export interface ReissueTarget {
  documentId: number;
  documentNo: string | null;
  partyName: string | null;
  issuedOn: string | null;
  /** 直した条件のうち、この条件書に載っている数。 */
  conditions: number;
  /** 訂正版の下書きが開いているなど、出し直せない理由。 */
  skip: string | null;
  /**
   * この出し直しが前に作って、決定に失敗したまま残った訂正版の下書き。作り直さずにこれを決定する。
   * 人が作った訂正版の下書き（理由が違う）は触らない（skip）。
   */
  reuseDraftId: number | null;
}

export interface ReissueResult {
  documentId: number; documentNo: string | null;
  status: "reissued" | "skipped" | "error";
  newDocumentId?: number; newDocumentNo?: string | null; message?: string;
}

export interface TermReissuer {
  reissue(documentId: number, reason: string, actor: string): Promise<{ id: number }>;
  issue(documentId: number, actor: string, extra?: { issuedOn?: string | null }): Promise<{ documentNo?: string | null }>;
}

const CANDIDATES = `
  SELECT c.id, c.condition_no, c.name, c.term_start, p.id AS party_id, p.name AS party_name, w.title AS work_title,
         ARRAY(SELECT DISTINCT d.document_no FROM document_conditions dc
                 JOIN documents d ON d.id = dc.document_id
                 JOIN document_template_versions tv ON tv.id = d.template_version_id
                 JOIN document_templates t ON t.id = tv.template_id
                WHERE dc.condition_id = c.id AND d.status IN ('draft', 'issued')
                  AND t.template_key = ANY($1::text[]) AND d.document_no IS NOT NULL
                ORDER BY d.document_no) AS document_nos
    FROM conditions c
    LEFT JOIN parties p ON p.id = c.counterparty_id
    LEFT JOIN works w ON w.id = c.work_id
   WHERE c.direction = 'in' AND c.status = 'active' AND c.term_end IS NULL
     AND EXISTS (SELECT 1 FROM document_conditions dc
                   JOIN documents d ON d.id = dc.document_id
                   JOIN document_template_versions tv ON tv.id = d.template_version_id
                   JOIN document_templates t ON t.id = tv.template_id
                  WHERE dc.condition_id = c.id AND d.status IN ('draft', 'issued')
                    AND t.template_key = ANY($1::text[]))
   ORDER BY p.name, c.term_start NULLS LAST, c.id`;

/**
 * 出し直す条件書。決定済みの出版の条件書で、載っている条件のどれかに、作ったあとで
 * 期間を入れた（condition.term_default）もの。決定日ではなく作った日で見る（訂正版は元の決定日で
 * 決定するので、決定日で見ると出し直した版がまた出てくる）。
 */
const REISSUE_CANDIDATES = `
  SELECT d.id, d.document_no, d.issued_at, p.name AS party_name,
         count(DISTINCT dc.condition_id)::int AS conditions,
         (SELECT x.id FROM documents x WHERE x.supersedes_id = d.id AND x.status = 'draft' ORDER BY x.id LIMIT 1) AS open_draft,
         (SELECT x.supersede_reason FROM documents x WHERE x.supersedes_id = d.id AND x.status = 'draft' ORDER BY x.id LIMIT 1) AS open_draft_reason
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
    JOIN document_conditions dc ON dc.document_id = d.id
    JOIN conditions c ON c.id = dc.condition_id
    -- 受取人（共著の取り分）宛ての条件書は受取人の名前。
    LEFT JOIN parties p ON p.id = COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                                THEN (d.manual_inputs->>'_payeePartyId')::bigint END, c.counterparty_id)
   WHERE d.status = 'issued' AND t.template_key = ANY($1::text[])
     AND EXISTS (SELECT 1 FROM audit_events a
                  WHERE a.target_type = 'condition' AND a.target_id = dc.condition_id
                    AND a.action = 'condition.term_default' AND a.occurred_at > d.created_at)
   GROUP BY d.id, d.document_no, d.issued_at, p.name
   ORDER BY p.name, d.document_no`;

/** 開始日の n か月後の前日（満了日）。 */
export function termEndFrom(start: string, months = DEFAULT_TERM_MONTHS): string {
  // 前日を先に取ってから足す（4/1 開始 → 3/31 → 3 年後の 3/31。月末は月末に寄る）。
  const eve = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  eve.setUTCDate(eve.getUTCDate() - 1);
  return addMonths(eve, months).toISOString().slice(0, 10);
}

export const DEFAULT_REISSUE_REASON = "許諾期間（3年・3年ごとの自動更新）を記載する";

/** 開いている訂正版の下書き。この出し直しが作ったもの（理由が同じ）なら使い回し、人のものなら飛ばす。 */
function draftOf(r: Record<string, any>): { skip: string | null; reuseDraftId: number | null } {
  if (!r.open_draft) return { skip: null, reuseDraftId: null };
  if (str(r.open_draft_reason) === DEFAULT_REISSUE_REASON) return { skip: null, reuseDraftId: Number(r.open_draft) };
  return { skip: `訂正版の下書き（#${r.open_draft}）が開いています。それを決定するか捨ててください`, reuseDraftId: null };
}

export class TermDefaultService {
  constructor(
    private readonly database: Transactable,
    private readonly issuer: TermReissuer | null = null,
    private readonly today = () => new Date().toISOString().slice(0, 10)
  ) {}

  async preview(): Promise<{ targets: TermTarget[] }> {
    try { return { targets: await this.targets(this.database) }; }
    catch (error) { throw translate(error); }
  }

  /** 選んだ条件（conditionIds）だけ直す。直す直前にもう一度確かめる（その間に終了日が入った条件は飛ばす）。 */
  async run(conditionIds: number[], actor: string): Promise<{ updated: number; targets: TermTarget[] }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const wanted = new Set(conditionIds.map(Number));
        const targets = (await this.targets(client))
          .filter((t) => wanted.has(t.conditionId) && t.newTermEnd && !t.skip);
        for (const t of targets) {
          await client.query(
            `UPDATE conditions SET term_end = $2::date, auto_renew = true, renew_months = $3
              WHERE id = $1 AND term_end IS NULL`, [t.conditionId, t.newTermEnd, DEFAULT_TERM_MONTHS]);
          await recordAudit(client, {
            actor, action: "condition.term_default", targetType: "condition", targetId: t.conditionId,
            detail: { termStart: t.termStart, termEnd: { from: null, to: t.newTermEnd },
                      autoRenew: true, renewMonths: DEFAULT_TERM_MONTHS }
          });
        }
        return { updated: targets.length, targets };
      });
    } catch (error) { throw translate(error); }
  }

  async reissueTargets(): Promise<{ targets: ReissueTarget[] }> {
    try {
      const rows = (await this.database.query(REISSUE_CANDIDATES, [PUB_TERMS_TEMPLATE_KEYS])).rows as Array<Record<string, any>>;
      return {
        targets: rows.map((r) => ({
          documentId: Number(r.id), documentNo: str(r.document_no), partyName: str(r.party_name),
          issuedOn: dateStr(r.issued_at), conditions: Number(r.conditions ?? 0),
          ...draftOf(r)
        }))
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 選んだ条件書を訂正版で出し直す（元の締結日・決定日のまま。更新の回数も元の締結日で数える）。
   * 1 枚ずつ。途中で失敗しても止めない。
   */
  async reissue(documentIds: number[], actor: string, reason?: string | null): Promise<{ reissued: number; results: ReissueResult[] }> {
    if (!this.issuer) throw new DomainError("UNAVAILABLE", "出し直しの口がありません");
    const why = String(reason ?? "").trim() || DEFAULT_REISSUE_REASON;
    const { targets } = await this.reissueTargets();
    const byId = new Map(targets.map((t) => [t.documentId, t]));
    const results: ReissueResult[] = [];
    for (const id of [...new Set(documentIds.map(Number))]) {
      const t = byId.get(id);
      if (!t) {
        results.push({ documentId: id, documentNo: null, status: "skipped", message: "出し直す条件書ではありません（もう出し直したか、期間を入れた条件が載っていません）" });
        continue;
      }
      if (t.skip) { results.push({ documentId: id, documentNo: t.documentNo, status: "skipped", message: t.skip }); continue; }
      try {
        const draft = t.reuseDraftId ? { id: t.reuseDraftId } : await this.issuer.reissue(id, why, actor);
        const issued = await this.issuer.issue(draft.id, actor, { issuedOn: t.issuedOn });
        results.push({ documentId: id, documentNo: t.documentNo, status: "reissued",
                       newDocumentId: draft.id, newDocumentNo: issued.documentNo ?? null });
      } catch (error) {
        results.push({ documentId: id, documentNo: t.documentNo, status: "error",
                       message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { reissued: results.filter((r) => r.status === "reissued").length, results };
  }

  private async targets(client: Queryable): Promise<TermTarget[]> {
    const rows = (await client.query(CANDIDATES, [PUB_TERMS_TEMPLATE_KEYS])).rows as Array<Record<string, any>>;
    const today = this.today();
    return rows.map((r) => {
      const termStart = dateStr(r.term_start);
      const newTermEnd = termStart ? termEndFrom(termStart) : null;
      return {
        conditionId: Number(r.id), conditionNo: str(r.condition_no), conditionName: String(r.name ?? ""),
        partyId: r.party_id != null ? Number(r.party_id) : null, partyName: str(r.party_name), workTitle: str(r.work_title),
        documentNos: (Array.isArray(r.document_nos) ? r.document_nos : []).map(String),
        termStart, newTermEnd,
        label: termStart && newTermEnd
          ? renewalLabel({ termStart, termEnd: newTermEnd, autoRenew: true, renewMonths: DEFAULT_TERM_MONTHS, renewStoppedOn: null }, today)
          : null,
        skip: termStart ? null : "開始日が無いので計算できません（条件に開始日を入れてください）"
      };
    });
  }
}
