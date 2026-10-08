import { dateStr, int, str, type Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";

/**
 * 条件明細の「基本契約」と「個別契約」。
 *
 *   基本契約 … 条件が載っている合意（conditions.agreement_id）。条件は基本契約の明細。
 *              補助文書（覚書・個別条件書の合意 -S01）に載っていれば、その親を基本契約とみなす。
 *   個別契約 … この条件を載せた条件書（個別利用許諾条件書・出版条件書）か、取り込んだ
 *              利用許諾契約書・覚書。条件の「文書」の繋がり（document_conditions）から引く。
 *              複数あれば決定済みで新しいものを使う（訂正版は旧版が退くので最新が残る）。
 *
 * 状態は増やさない。付け替えは既存の繋ぎ（/links）でする：基本契約は条件の合意、
 * 個別契約は条件の文書。計算書の「契約番号」はここから「基本 / 個別」で出す。
 */

/** 個別契約とみなす文書：条件書のひな形、取り込みなら文書の種別。 */
export const TERMS_TEMPLATES = ["individual_license_terms_v3", "individual_license_terms_v4",
  "pub_license_terms", "pub_license_terms_v3", "pub_license_terms_v3_annex"];
export const TERMS_IMPORT_KINDS = ["利用許諾契約書", "覚書"];

const TERMS_DOC_SQL = `(t.template_key = ANY($2::text[]) OR d.manual_inputs->>'documentKind' = ANY($3::text[]))`;

export interface ContractAgreement { id: number; no: string | null; title: string; kind: string; status: string }
export interface TermsDocument {
  id: number; no: string | null; label: string; status: string; issuedOn: string | null;
  agreementNo: string | null; used: boolean;
}
export interface ConditionContracts {
  conditionId: number; direction: string; counterpartyId: number | null;
  /** 条件が直接載っている合意（基本契約か、補助文書）。 */
  agreement: ContractAgreement | null;
  /** 基本契約（補助文書に載っていればその親）。 */
  master: ContractAgreement | null;
  /** 繋がっている個別契約の文書。used が計算書に出すもの。 */
  terms: TermsDocument[];
  /** 紙に出る契約番号（基本 / 個別）。 */
  contractRef: string;
}

const agreementOf = (row: any): ContractAgreement | null => row?.id ? ({
  id: Number(row.id), no: str(row.agreement_no), title: String(row.title ?? ""),
  kind: String(row.kind ?? "master"), status: String(row.status ?? "")
}) : null;

/** 計算書の契約番号。基本と個別の番号を「 / 」で並べる。片方だけならそれ。 */
export function contractRefText(masterNo: string | null | undefined, termsNo: string | null | undefined): string {
  return [masterNo, termsNo].map((x) => String(x ?? "").trim()).filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i).join(" / ");
}

/** 条件（改訂の全版）に繋がった個別契約の文書。決定済み・新しい順。 */
export async function termsDocumentsOf(q: Queryable, conditionId: number): Promise<TermsDocument[]> {
  const r = await q.query(
    `SELECT d.id, d.document_no, d.status, d.issued_at, COALESCE(t.label, d.manual_inputs->>'documentKind') AS label,
            a.agreement_no
       FROM documents d
       LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
       LEFT JOIN document_templates t ON t.id = tv.template_id
       LEFT JOIN agreements a ON a.id = d.agreement_id
      WHERE EXISTS (SELECT 1 FROM document_conditions dc
                     WHERE dc.document_id = d.id
                       AND dc.condition_id IN (SELECT x.id FROM conditions x
                                                WHERE COALESCE(x.series_id, x.id) =
                                                      (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = $1)))
        AND d.status <> 'void'
        AND ${TERMS_DOC_SQL}
      ORDER BY (d.status = 'issued') DESC, d.issued_at DESC NULLS LAST, d.id DESC`,
    [conditionId, TERMS_TEMPLATES, TERMS_IMPORT_KINDS]);
  const docs = (r.rows as any[]).map((d): TermsDocument => ({
    id: Number(d.id), no: str(d.document_no), label: String(d.label ?? "文書"), status: String(d.status),
    issuedOn: dateStr(d.issued_at), agreementNo: str(d.agreement_no), used: false
  }));
  const used = docs.find((d) => d.status === "issued");
  if (used) used.used = true;
  return docs;
}

export async function conditionContracts(q: Queryable, conditionId: number): Promise<ConditionContracts> {
  const c = (await q.query(
    `SELECT c.id, c.direction, c.counterparty_id,
            a.id AS a_id, a.agreement_no AS a_no, a.title AS a_title, a.kind AS a_kind, a.status AS a_status,
            p.id AS p_id, p.agreement_no AS p_no, p.title AS p_title, p.kind AS p_kind, p.status AS p_status
       FROM conditions c
       LEFT JOIN agreements a ON a.id = c.agreement_id
       LEFT JOIN agreements p ON p.id = a.parent_id
      WHERE c.id = $1`, [conditionId])).rows[0] as any;
  if (!c) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
  const agreement = agreementOf({ id: c.a_id, agreement_no: c.a_no, title: c.a_title, kind: c.a_kind, status: c.a_status });
  const parent = agreementOf({ id: c.p_id, agreement_no: c.p_no, title: c.p_title, kind: c.p_kind, status: c.p_status });
  const master = agreement && (agreement.kind === "master" || agreement.kind === "standalone") ? agreement : parent ?? agreement;
  const terms = await termsDocumentsOf(q, conditionId);
  const used = terms.find((t) => t.used);
  return {
    conditionId, direction: String(c.direction), counterpartyId: int(c.counterparty_id),
    agreement, master, terms,
    contractRef: contractRefText(master?.no, used?.no)
  };
}

/** 付け替えの候補：同じ相手先・同じ向きの基本契約（単体契約を含む）と、まだ繋いでいない個別契約の文書。 */
export async function contractCandidates(q: Queryable, conditionId: number) {
  const masters = await q.query(
    `SELECT a.id, a.agreement_no, a.title, a.kind, a.status
       FROM agreements a, conditions c
      WHERE c.id = $1 AND a.direction = c.direction
        AND a.kind IN ('master', 'standalone')
        AND (a.counterparty_id = c.counterparty_id OR c.counterparty_id IS NULL)
        AND a.terminated_on IS NULL
      ORDER BY a.id DESC LIMIT 50`, [conditionId]);
  const docs = await q.query(
    `SELECT d.id, d.document_no, d.status, d.issued_at, COALESCE(t.label, d.manual_inputs->>'documentKind') AS label,
            a.agreement_no
       FROM documents d
       JOIN v_document_display v ON v.document_id = d.id
       LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
       LEFT JOIN document_templates t ON t.id = tv.template_id
       LEFT JOIN agreements a ON a.id = d.agreement_id
      WHERE d.status <> 'void' AND ${TERMS_DOC_SQL}
        AND v.counterparty_id = (SELECT counterparty_id FROM conditions WHERE id = $1)
        AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id AND dc.condition_id = $1)
      ORDER BY d.id DESC LIMIT 50`, [conditionId, TERMS_TEMPLATES, TERMS_IMPORT_KINDS]);
  return {
    masters: (masters.rows as any[]).map((a) => agreementOf(a)!),
    terms: (docs.rows as any[]).map((d): TermsDocument => ({
      id: Number(d.id), no: str(d.document_no), label: String(d.label ?? "文書"), status: String(d.status),
      issuedOn: dateStr(d.issued_at), agreementNo: str(d.agreement_no), used: false
    }))
  };
}
