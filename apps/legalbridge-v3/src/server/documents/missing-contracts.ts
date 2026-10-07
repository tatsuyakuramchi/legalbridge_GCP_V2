import type { Queryable } from "../core/db.js";
import { int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { TERMS_IMPORT_KINDS, TERMS_TEMPLATES } from "../conditions/contracts.js";
import { PUB_TERMS_ANNEX_KEY, PUB_TERMS_KEY, PUB_TITLES_ANNEX_HINT } from "./pub-terms.js";
import { issueDocumentSet, type DocumentSetDeps, type DocumentSetResult } from "./document-set.js";

/**
 * 契約書の無い相手先（出版）を一覧し、基本契約（出版許諾契約書）＋出版条件書をまとめて起こす
 * （docs/royalty-shares.md §5.5）。
 *
 * 作品・条件は CSV で一括で入るが、相手と結ぶ契約書（出版許諾契約書＝基本契約を兼ねる、
 * 出版条件書＝条件明細を載せた個別契約）は 1 相手先ずつ「文書をまとめて作る」で起こす形
 * だった。相手先が何十人もいるので、条件書の無い条件を相手先ごとに集め、既存の文書セット
 * の決定（issueDocumentSet）を相手先ごとに回す。
 *
 *   - 対象：有効な IN の出版（紙・電子）の料率条件のうち、決定済みの条件書（出版条件書・
 *     取り込んだ利用許諾契約書）に載っていないもの。相手先ごとにまとめる。
 *   - 基本契約：相手先に基本契約（kind=master, IN）があればそれを使い、無ければ
 *     出版許諾契約書（個人／法人）を基本契約として作る。
 *   - 条件書：出版条件書。作品が多ければ別紙形式。
 *   - 必ず試算（preview）で必須の欄の不足を見てから決定する。相手先ごとに独立して回し、
 *     1 件の失敗で他を止めない。
 */

export interface MissingContractCondition {
  id: number; conditionNo: string | null; workId: number | null; workTitle: string | null; usageType: string | null;
  hasTerms: boolean;
}
export interface MissingContractParty {
  partyId: number; partyName: string; partyKind: string | null;
  email: string | null;
  master: { id: number; agreementNo: string | null; title: string } | null;
  conditions: MissingContractCondition[];
  /** 条件書の無い条件の数。 */
  missingTerms: number;
  /** 条件書の無い作品の数（紙・電子は同じ作品）。 */
  missingWorks: number;
}

export interface MissingContractRun {
  partyIds: number[];
  /** 締結日（両方の文書）。空なら今日。 */
  signedOn?: string | null;
  /** 基本契約書のひな形。空なら相手先の区分で 出版許諾契約書（個人／法人）。 */
  masterTemplateKey?: string | null;
  /** 条件書のひな形。空なら作品数で 一覧形式／別紙形式。 */
  termsTemplateKey?: string | null;
}

export interface MissingContractOutcome {
  partyId: number; partyName: string;
  status: "ok" | "missing" | "error" | "nothing";
  /** 試算：空の必須欄。決定：止まった理由。 */
  problems: string[];
  plan: { master: "existing" | "create"; masterTemplateKey: string | null; termsTemplateKey: string; conditionIds: number[] } | null;
  result?: DocumentSetResult | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export class MissingContractsService {
  constructor(private readonly database: Queryable, private readonly deps: DocumentSetDeps) {}

  /** 契約書の無い相手先。条件書の無い条件が 1 本も無い相手先は出さない。 */
  async list(): Promise<{ parties: MissingContractParty[] }> {
    try {
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.usage_type, c.counterparty_id, c.work_id, w.title AS work_title,
                p.name AS party_name, p.kind AS party_kind,
                COALESCE(NULLIF(btrim(p.email), ''),
                         (SELECT pc.email FROM party_contacts pc
                           WHERE pc.party_id = p.id AND NULLIF(btrim(pc.email), '') IS NOT NULL ORDER BY pc.id LIMIT 1)) AS email,
                (SELECT jsonb_build_object('id', a.id, 'no', a.agreement_no, 'title', a.title)
                   FROM agreements a
                  WHERE a.counterparty_id = p.id AND COALESCE(a.kind, 'master') = 'master' AND a.direction = 'in'
                    AND a.terminated_on IS NULL
                  ORDER BY (a.status = 'executed') DESC, a.id DESC LIMIT 1) AS master,
                EXISTS (
                  SELECT 1 FROM document_conditions dc
                    JOIN documents d ON d.id = dc.document_id
                    LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
                    LEFT JOIN document_templates t ON t.id = tv.template_id
                   WHERE dc.condition_id IN (SELECT x.id FROM conditions x
                                              WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))
                     AND d.status = 'issued'
                     AND (t.template_key = ANY($1::text[]) OR d.manual_inputs->>'documentKind' = ANY($2::text[]))
                ) AS has_terms
           FROM conditions c
           JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
          WHERE c.direction = 'in' AND c.kind = 'license' AND c.status = 'active'
            AND c.pricing_model = 'revenue_rate' AND c.usage_type IN ('pub_print', 'pub_digital')
          ORDER BY p.name, w.title NULLS LAST, c.id`, [TERMS_TEMPLATES, TERMS_IMPORT_KINDS]);
      const byParty = new Map<number, MissingContractParty>();
      for (const row of r.rows as Array<Record<string, any>>) {
        const partyId = Number(row.counterparty_id);
        const party = byParty.get(partyId) ?? {
          partyId, partyName: String(row.party_name ?? ""), partyKind: str(row.party_kind), email: str(row.email),
          master: row.master ? { id: Number(row.master.id), agreementNo: str(row.master.no), title: String(row.master.title ?? "") } : null,
          conditions: [], missingTerms: 0, missingWorks: 0
        };
        party.conditions.push({
          id: Number(row.id), conditionNo: str(row.condition_no), workId: int(row.work_id), workTitle: str(row.work_title),
          usageType: str(row.usage_type), hasTerms: row.has_terms === true
        });
        byParty.set(partyId, party);
      }
      const parties = [...byParty.values()].map((p) => {
        const missing = p.conditions.filter((c) => !c.hasTerms);
        return { ...p, missingTerms: missing.length,
                 missingWorks: new Set(missing.map((c) => c.workId ?? `n:${c.conditionNo}`)).size };
      }).filter((p) => p.missingTerms > 0);
      return { parties };
    } catch (error) { throw translate(error); }
  }

  /** 相手先ごとの作る計画。 */
  private planFor(party: MissingContractParty, input: MissingContractRun) {
    const conditionIds = party.conditions.filter((c) => !c.hasTerms).map((c) => c.id);
    if (!conditionIds.length) return null;
    const works = new Set(party.conditions.filter((c) => !c.hasTerms).map((c) => c.workId ?? `n:${c.id}`)).size;
    const termsTemplateKey = input.termsTemplateKey?.trim()
      || (works > PUB_TITLES_ANNEX_HINT ? PUB_TERMS_ANNEX_KEY : PUB_TERMS_KEY);
    const masterTemplateKey = party.master ? null
      : (input.masterTemplateKey?.trim() || (party.partyKind === "individual" ? "pub_master_individual" : "pub_master_corporate"));
    return { master: party.master ? "existing" as const : "create" as const, masterTemplateKey, termsTemplateKey, conditionIds };
  }

  /** 試算：必須の欄の不足を相手先ごとに出す。何も作らない。 */
  async preview(input: MissingContractRun): Promise<{ outcomes: MissingContractOutcome[] }> {
    try {
      const { parties } = await this.list();
      const signedOn = input.signedOn?.trim() || today();
      const outcomes: MissingContractOutcome[] = [];
      for (const partyId of input.partyIds) {
        const party = parties.find((p) => p.partyId === partyId);
        if (!party) { outcomes.push({ partyId, partyName: `#${partyId}`, status: "nothing", problems: ["条件書の無い条件がありません"], plan: null }); continue; }
        const plan = this.planFor(party, input)!;
        const problems: string[] = [];
        try {
          if (plan.master === "create") {
            const r = await this.deps.preview({ templateKey: plan.masterTemplateKey!, conditionIds: [], matterId: null,
                                                agreementId: null, manualInputs: { 締結日: signedOn } });
            if (r.missing.length) problems.push(`${r.templateLabel ?? plan.masterTemplateKey}：${r.missing.map((m) => m.label ?? m.name).join("・")}`);
          }
          const t = await this.deps.preview({ templateKey: plan.termsTemplateKey, conditionIds: plan.conditionIds, matterId: null,
                                              agreementId: null, manualInputs: { 締結日: signedOn } });
          if (t.missing.length) problems.push(`${t.templateLabel ?? plan.termsTemplateKey}：${t.missing.map((m) => m.label ?? m.name).join("・")}`);
          outcomes.push({ partyId, partyName: party.partyName, status: problems.length ? "missing" : "ok", problems, plan });
        } catch (e) {
          outcomes.push({ partyId, partyName: party.partyName, status: "error", problems: [(e as Error).message], plan });
        }
      }
      return { outcomes };
    } catch (error) { throw translate(error); }
  }

  /** 決定：相手先ごとに文書セット（基本契約＋条件書）を決定する。1 件の失敗で他を止めない。 */
  async run(input: MissingContractRun, actor: string): Promise<{ outcomes: MissingContractOutcome[]; issued: number }> {
    if (!input.partyIds.length) throw new DomainError("VALIDATION", "相手先を 1 件以上選んでください");
    try {
      const { parties } = await this.list();
      const signedOn = input.signedOn?.trim() || today();
      const outcomes: MissingContractOutcome[] = [];
      let issued = 0;
      for (const partyId of input.partyIds) {
        const party = parties.find((p) => p.partyId === partyId);
        if (!party) { outcomes.push({ partyId, partyName: `#${partyId}`, status: "nothing", problems: ["条件書の無い条件がありません"], plan: null }); continue; }
        const plan = this.planFor(party, input)!;
        try {
          const result = await issueDocumentSet(this.deps, {
            domain: "license", counterpartyId: partyId, matterId: null,
            master: plan.master === "existing"
              ? { existingAgreementId: party.master!.id }
              : { templateKey: plan.masterTemplateKey, title: "出版等利用許諾基本契約", manualInputs: { 締結日: signedOn } },
            docs: [{ templateKey: plan.termsTemplateKey, conditionIds: plan.conditionIds, role: "main", manualInputs: { 締結日: signedOn } }]
          }, actor);
          if (result.error) outcomes.push({ partyId, partyName: party.partyName, status: "error", problems: [result.error], plan, result });
          else { issued += 1; outcomes.push({ partyId, partyName: party.partyName, status: "ok", problems: [], plan, result }); }
        } catch (e) {
          outcomes.push({ partyId, partyName: party.partyName, status: "error", problems: [(e as Error).message], plan });
        }
      }
      await recordAudit(this.database, {
        actor, action: "document_sets.bulk", targetType: "import", targetId: 0,
        detail: { partyIds: input.partyIds, issued, signedOn,
                  outcomes: outcomes.map((o) => ({ partyId: o.partyId, status: o.status, documents: o.result?.documents?.map((d) => d.documentNo) ?? [] })) }
      });
      return { outcomes, issued };
    } catch (error) { throw translate(error); }
  }
}
