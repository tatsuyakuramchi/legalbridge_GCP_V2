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
 *   - 共著の受取人（取り分を直接払う条件の、相手先以外の取り分の人）も 1 行にする。
 *     計算書は受取人宛てに出るので、契約書も受取人宛て（manual_inputs._payeePartyId）が要る。
 *     基本契約は受取人のもの（無ければ受取人と作る）、条件書は受取人宛てで受取人の基本契約の下。
 *     条件は代表（相手先）との契約の明細のままにする（document-set.ts）。
 */

export interface MissingContractCondition {
  id: number; conditionNo: string | null; workId: number | null; workTitle: string | null; usageType: string | null;
  hasTerms: boolean;
}
export interface MissingContractParty {
  /** 選ぶときの鍵。相手先は party:<id>、共著の受取人は payee:<id>。 */
  key: string;
  /** party＝条件の相手先／payee＝共著の受取人（取り分を直接払う条件の、相手先以外の人）。 */
  role: "party" | "payee";
  partyId: number; partyName: string; partyKind: string | null;
  /** 受取人の行：条件の相手先（代表）の名前。 */
  representatives?: string[];
  email: string | null;
  master: { id: number; agreementNo: string | null; title: string } | null;
  conditions: MissingContractCondition[];
  /** 条件書の無い条件の数。 */
  missingTerms: number;
  /** 条件書の無い作品の数（紙・電子は同じ作品）。 */
  missingWorks: number;
}

export interface MissingContractRun {
  /** 選んだ行の鍵（party:<id>／payee:<id>）。 */
  keys?: string[];
  /** 相手先の行（party:<id>）。keys が無いときの旧い指定。 */
  partyIds?: number[];
  /** 締結日（両方の文書）。空なら今日。 */
  signedOn?: string | null;
  /** 基本契約書のひな形。空なら相手先の区分で 出版許諾契約書（個人／法人）。 */
  masterTemplateKey?: string | null;
  /** 条件書のひな形。空なら作品数で 一覧形式／別紙形式。 */
  termsTemplateKey?: string | null;
}

export interface MissingContractOutcome {
  key: string; role: "party" | "payee";
  partyId: number; partyName: string;
  status: "ok" | "missing" | "error" | "nothing";
  /** 試算：空の必須欄。決定：止まった理由。 */
  problems: string[];
  plan: { master: "existing" | "create"; masterTemplateKey: string | null; termsTemplateKey: string; conditionIds: number[] } | null;
  result?: DocumentSetResult | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** 相手先の基本契約（IN・出版の基本契約を兼ねるもの）。締結済みを先に、新しいものを先に。 */
const masterOf = (party: string) => `(SELECT jsonb_build_object('id', a.id, 'no', a.agreement_no, 'title', a.title)
                   FROM agreements a
                  WHERE a.counterparty_id = ${party} AND COALESCE(a.kind, 'master') = 'master' AND a.direction = 'in'
                    AND a.terminated_on IS NULL
                  ORDER BY (a.status = 'executed') DESC, a.id DESC LIMIT 1)`;
const emailOf = (party: string) => `COALESCE(NULLIF(btrim(p.email), ''),
                         (SELECT pc.email FROM party_contacts pc
                           WHERE pc.party_id = ${party} AND NULLIF(btrim(pc.email), '') IS NOT NULL ORDER BY pc.id LIMIT 1))`;
/** 条件の系列に、決定済みの条件書（出版条件書・取り込んだ利用許諾契約書）で $3 宛てのものがあるか。 */
const termsFor = (addressee: string) => `EXISTS (
                  SELECT 1 FROM document_conditions dc
                    JOIN documents d ON d.id = dc.document_id
                    LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
                    LEFT JOIN document_templates t ON t.id = tv.template_id
                   WHERE dc.condition_id IN (SELECT x.id FROM conditions x
                                              WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))
                     AND d.status = 'issued'
                     AND (t.template_key = ANY($1::text[]) OR d.manual_inputs->>'documentKind' = ANY($2::text[]))
                     AND COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                       THEN (d.manual_inputs->>'_payeePartyId')::bigint END, c.counterparty_id) = ${addressee}
                )`;
const PUB_CONDITIONS = `c.direction = 'in' AND c.kind = 'license' AND c.status = 'active'
            AND c.pricing_model = 'revenue_rate' AND c.usage_type IN ('pub_print', 'pub_digital')`;

const masterRow = (m: any) => m ? { id: Number(m.id), agreementNo: str(m.no), title: String(m.title ?? "") } : null;

export class MissingContractsService {
  constructor(private readonly database: Queryable, private readonly deps: DocumentSetDeps) {}

  /** 契約書の無い相手先。条件書の無い条件が 1 本も無い相手先は出さない。 */
  async list(): Promise<{ parties: MissingContractParty[] }> {
    try {
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.usage_type, c.counterparty_id, c.work_id, w.title AS work_title,
                p.name AS party_name, p.kind AS party_kind,
                ${emailOf("p.id")} AS email,
                ${masterOf("p.id")} AS master,
                ${termsFor("c.counterparty_id")} AS has_terms
           FROM conditions c
           JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
          WHERE ${PUB_CONDITIONS}
          ORDER BY p.name, w.title NULLS LAST, c.id`, [TERMS_TEMPLATES, TERMS_IMPORT_KINDS]);
      const byKey = new Map<string, MissingContractParty>();
      const add = (key: string, role: MissingContractParty["role"], row: Record<string, any>, partyId: number,
                   condition: MissingContractCondition, representative?: string) => {
        const party = byKey.get(key) ?? {
          key, role, partyId, partyName: String(row.party_name ?? ""), partyKind: str(row.party_kind), email: str(row.email),
          master: masterRow(row.master), conditions: [], missingTerms: 0, missingWorks: 0,
          ...(role === "payee" ? { representatives: [] } : {})
        };
        party.conditions.push(condition);
        if (representative && !party.representatives!.includes(representative)) party.representatives!.push(representative);
        byKey.set(key, party);
      };
      const conditionOf = (row: Record<string, any>, hasTerms: boolean): MissingContractCondition => ({
        id: Number(row.id), conditionNo: str(row.condition_no), workId: int(row.work_id), workTitle: str(row.work_title),
        usageType: str(row.usage_type), hasTerms
      });
      const representativeOf = new Map<number, { partyId: number; name: string }>();
      for (const row of r.rows as Array<Record<string, any>>) {
        const partyId = Number(row.counterparty_id);
        add(`party:${partyId}`, "party", row, partyId, conditionOf(row, row.has_terms === true));
        representativeOf.set(Number(row.id), { partyId, name: String(row.party_name ?? "") });
      }

      // 共著の受取人：取り分を直接払う条件の、相手先以外の取り分の人。取り分は系列でいちばん新しい組。
      const s = await this.database.query(
        `WITH latest AS (
           SELECT c.id, (SELECT max(cs.condition_id) FROM condition_shares cs
                           JOIN conditions x ON x.id = cs.condition_id
                          WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id)) AS share_condition_id
             FROM conditions c
            WHERE ${PUB_CONDITIONS}
              AND COALESCE(to_jsonb(c) ->> 'distribution', 'direct') <> 'representative'
         )
         SELECT c.id, c.condition_no, c.usage_type, c.work_id, w.title AS work_title,
                s.party_id, p.name AS party_name, p.kind AS party_kind,
                ${emailOf("p.id")} AS email,
                ${masterOf("p.id")} AS master,
                ${termsFor("s.party_id")} AS payee_has_terms
           FROM latest l
           JOIN conditions c ON c.id = l.id
           JOIN condition_shares s ON s.condition_id = l.share_condition_id
           JOIN parties p ON p.id = s.party_id
           LEFT JOIN works w ON w.id = c.work_id
          WHERE s.party_id <> c.counterparty_id
          ORDER BY p.name, w.title NULLS LAST, c.id`, [TERMS_TEMPLATES, TERMS_IMPORT_KINDS]);
      for (const row of s.rows as Array<Record<string, any>>) {
        const partyId = Number(row.party_id);
        add(`payee:${partyId}`, "payee", row, partyId, conditionOf(row, row.payee_has_terms === true),
            representativeOf.get(Number(row.id))?.name);
      }

      const parties = [...byKey.values()].map((p) => {
        const missing = p.conditions.filter((c) => !c.hasTerms);
        return { ...p, missingTerms: missing.length,
                 missingWorks: new Set(missing.map((c) => c.workId ?? `n:${c.conditionNo}`)).size };
      }).filter((p) => p.missingTerms > 0)
        .sort((a, b) => a.partyName.localeCompare(b.partyName, "ja") || (a.role === b.role ? 0 : a.role === "party" ? -1 : 1));
      return { parties };
    } catch (error) { throw translate(error); }
  }

  /** 選んだ行の鍵。keys が無ければ partyIds を相手先の行として読む。 */
  private keysOf(input: MissingContractRun): string[] {
    const keys = input.keys?.length ? input.keys : (input.partyIds ?? []).map((id) => `party:${id}`);
    return [...new Set(keys.map((k) => String(k).trim()).filter(Boolean))];
  }

  /** 選んだ行が無いときの結果。 */
  private nothing(key: string): MissingContractOutcome {
    const [role, id] = key.split(":");
    return { key, role: role === "payee" ? "payee" : "party", partyId: Number(id) || 0, partyName: `#${id ?? key}`,
             status: "nothing", problems: ["条件書の無い条件がありません"], plan: null };
  }

  /** 行ごとの作る計画。 */
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

  /** 条件書の入力。受取人宛ては受取人を宛名にする（宛名・住所・口座が受取人になる）。 */
  private termsInputs(party: MissingContractParty, signedOn: string): Record<string, unknown> {
    return party.role === "payee" ? { 締結日: signedOn, _payeePartyId: party.partyId } : { 締結日: signedOn };
  }

  /** 試算：必須の欄の不足を行ごとに出す。何も作らない。 */
  async preview(input: MissingContractRun): Promise<{ outcomes: MissingContractOutcome[] }> {
    try {
      const { parties } = await this.list();
      const signedOn = input.signedOn?.trim() || today();
      const outcomes: MissingContractOutcome[] = [];
      for (const key of this.keysOf(input)) {
        const party = parties.find((p) => p.key === key);
        if (!party) { outcomes.push(this.nothing(key)); continue; }
        const head = { key, role: party.role, partyId: party.partyId, partyName: party.partyName };
        const plan = this.planFor(party, input)!;
        const problems: string[] = [];
        try {
          if (plan.master === "create") {
            const r = await this.deps.preview({ templateKey: plan.masterTemplateKey!, conditionIds: [], matterId: null,
                                                agreementId: null, manualInputs: { 締結日: signedOn } });
            if (r.missing.length) problems.push(`${r.templateLabel ?? plan.masterTemplateKey}：${r.missing.map((m) => m.label ?? m.name).join("・")}`);
          }
          // 受取人宛ては受取人の基本契約を親に渡す（相手先の条件書は合意を付けない）。
          const t = await this.deps.preview({ templateKey: plan.termsTemplateKey, conditionIds: plan.conditionIds, matterId: null,
                                              agreementId: party.role === "payee" ? party.master?.id ?? null : null,
                                              manualInputs: this.termsInputs(party, signedOn) });
          if (t.missing.length) problems.push(`${t.templateLabel ?? plan.termsTemplateKey}：${t.missing.map((m) => m.label ?? m.name).join("・")}`);
          outcomes.push({ ...head, status: problems.length ? "missing" : "ok", problems, plan });
        } catch (e) {
          outcomes.push({ ...head, status: "error", problems: [(e as Error).message], plan });
        }
      }
      return { outcomes };
    } catch (error) { throw translate(error); }
  }

  /**
   * 決定：行ごとに文書セット（基本契約＋条件書）を決定する。1 件の失敗で他を止めない。
   * 同じ人が相手先と受取人の両方に出ていれば、相手先の行を先に回し、そこで作った基本契約を
   * 受取人の行でも使う（基本契約を 2 本作らない）。
   */
  async run(input: MissingContractRun, actor: string): Promise<{ outcomes: MissingContractOutcome[]; issued: number }> {
    const keys = this.keysOf(input);
    if (!keys.length) throw new DomainError("VALIDATION", "相手先を 1 件以上選んでください");
    keys.sort((a, b) => (a.startsWith("payee:") ? 1 : 0) - (b.startsWith("payee:") ? 1 : 0));
    try {
      const { parties } = await this.list();
      const signedOn = input.signedOn?.trim() || today();
      const outcomes: MissingContractOutcome[] = [];
      const madeMasters = new Map<number, NonNullable<MissingContractParty["master"]>>();
      let issued = 0;
      for (const key of keys) {
        const listed = parties.find((p) => p.key === key);
        if (!listed) { outcomes.push(this.nothing(key)); continue; }
        const party = { ...listed, master: listed.master ?? madeMasters.get(listed.partyId) ?? null };
        const head = { key, role: party.role, partyId: party.partyId, partyName: party.partyName };
        const plan = this.planFor(party, input)!;
        try {
          const result = await issueDocumentSet(this.deps, {
            domain: "license", counterpartyId: party.partyId, matterId: null,
            payeePartyId: party.role === "payee" ? party.partyId : null,
            master: plan.master === "existing"
              ? { existingAgreementId: party.master!.id }
              : { templateKey: plan.masterTemplateKey, title: "出版等利用許諾基本契約", manualInputs: { 締結日: signedOn } },
            docs: [{ templateKey: plan.termsTemplateKey, conditionIds: plan.conditionIds, role: "main", manualInputs: { 締結日: signedOn } }]
          }, actor);
          if (result.agreement?.created) {
            madeMasters.set(party.partyId, { id: result.agreement.id, agreementNo: result.agreement.agreementNo, title: "出版等利用許諾基本契約" });
          }
          if (result.error) outcomes.push({ ...head, status: "error", problems: [result.error], plan, result });
          else { issued += 1; outcomes.push({ ...head, status: "ok", problems: [], plan, result }); }
        } catch (e) {
          outcomes.push({ ...head, status: "error", problems: [(e as Error).message], plan });
        }
      }
      await recordAudit(this.database, {
        actor, action: "document_sets.bulk", targetType: "import", targetId: 0,
        detail: { keys, issued, signedOn,
                  outcomes: outcomes.map((o) => ({ key: o.key, status: o.status, documents: o.result?.documents?.map((d) => d.documentNo) ?? [] })) }
      });
      return { outcomes, issued };
    } catch (error) { throw translate(error); }
  }
}
