import { type Queryable, int, str } from "../core/db.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { DomainError } from "../core/errors.js";
import { baseDocumentNumber } from "../documents/numbering.js";

/**
 * 条件書を決定したとき、合意を自動で起こす（合意の生まれ方 ②）。発注書は order-agreement.ts。
 *
 * 個別利用許諾条件書・出版条件書は、条件明細が先にあって紙が後。
 * 相手と結ぶ契約そのものなので、決定した瞬間に合意の器を立てる。
 *   載せた条件に基本契約が付いていれば → その下の個別契約（補助文書）
 *   付いていなければ                   → 単体契約
 * 番号は条件書の番号（訂正版の -R2 を除いた本体の番号）。契約と紙が同じ番号で並ぶ
 * （「文書から契約を立てる」と同じ決め方）。その番号が既に契約に使われていれば、
 * 親番号-S01（単体契約は ARC-ILT）で採番する。
 * 文書.合意 と、載せた条件の合意（空のものだけ）を同時に埋める。
 * 状態は「交渉中」。送信→締結の記録で「締結済み」になる（send-service）。
 *
 * 発注書・検収書・計算書はここを通らない（基本契約の下の個別取引で、合意ではない）。
 *
 * 文書に既に合意が付いているとき
 *   基本契約     → それを親にして、その下に個別契約を立てる（基本契約に条件書を直付けしない）
 *   個別契約・単体契約 → それを使う（人が選んだもの。新しく立てない）。載せた条件のうち契約の無いもの・
 *                  親の基本契約を直接指すものだけ、その契約に寄せる
 * 訂正版（-R2 …）は、前の版の個別契約・単体契約を引き継ぐ（版ごとに器を立てない）。
 * 条件書の番号（本体）の個別契約・単体契約が同じ相手で既にあれば、それを使う。
 */

/** 合意を起こす条件書のひな形。旧システム（V2）から移した pub_license_terms・individual_license_terms の訂正版も同じ。 */
export const TERMS_TEMPLATE_KEYS = new Set([
  "individual_license_terms_v3", "individual_license_terms_v4", "pub_license_terms_v3", "pub_license_terms_v3_annex",
  "pub_license_terms", "individual_license_terms"
]);

export interface AutoAgreementInput {
  documentId: number;
  documentNo: string;
  templateKey: string;
  templateLabel: string;
  conditionIds: number[];
  /** 文書に付いている合意。あれば触らない。 */
  agreementId: number | null;
  issuedOn: string | null;
  /**
   * 受取人（共著の取り分。A-068）宛ての条件書。合意の相手は条件の相手先ではなく受取人で、
   * 親は文書で選んだ受取人の基本契約（parentAgreementId）。無ければ受取人との単体契約。
   * 条件の合意は触らない（条件は代表との契約の明細）。
   */
  payeePartyId?: number | null;
  parentAgreementId?: number | null;
  /**
   * 訂正版の決定か。受取人宛ての訂正版は、前の版の決定で文書の合意が補助文書（または単体契約）に
   * 差し替わったものを引き継ぐ。そのときはその合意をそのまま使う（新しい合意を立てない）。
   */
  revision?: boolean;
}

export interface AutoAgreementResult {
  agreementId: number; agreementNo: string | null; kind: "supplement" | "standalone";
  parentId: number | null; conditionsLinked: number;
}

export async function ensureAgreementForTerms(
  client: Queryable, input: AutoAgreementInput, actor: string
): Promise<AutoAgreementResult | null> {
  if (!TERMS_TEMPLATE_KEYS.has(input.templateKey)) return null;
  const payeeId = input.payeePartyId ?? null;
  if (!input.conditionIds.length) return null;

  // 文書に付いている合意（受取人宛ては親の基本契約として別に扱う）。
  let chosenMaster: number | null = null;
  if (input.agreementId && !payeeId) {
    const a = (await client.query(
      "SELECT id, agreement_no, COALESCE(kind, 'master') AS kind, parent_id FROM agreements WHERE id = $1",
      [input.agreementId])).rows[0] as any;
    if (!a) return null;
    if (a.kind === "supplement" || a.kind === "standalone") {
      return attachToExisting(client, input, actor, { id: Number(a.id), agreement_no: str(a.agreement_no), kind: a.kind, parent_id: int(a.parent_id) });
    }
    if (a.kind !== "master") return null;
    chosenMaster = Number(a.id);
  }

  const conds = await client.query(
    `SELECT c.id, c.counterparty_id, c.direction, c.agreement_id, a.kind AS agreement_kind,
            a.parent_id AS agreement_parent, w.title AS work_title
       FROM conditions c
       LEFT JOIN agreements a ON a.id = c.agreement_id
       LEFT JOIN works w ON w.id = c.work_id
      WHERE c.id = ANY($1::bigint[])`, [input.conditionIds]);
  const rows = conds.rows as any[];
  if (!rows.length) return null;
  const parties = [...new Set(rows.map((r) => int(r.counterparty_id)).filter(Boolean))];
  // 相手が2社にまたがる条件書は無い。あれば合意を勝手に立てない。
  if (parties.length !== 1) return null;
  const partyId = payeeId ?? parties[0]!;
  const direction = rows.every((r) => r.direction === "out") ? "out" : "in";

  // 載せた条件の基本契約。基本契約そのもの（か単体契約）だけを親にする。
  // 補助文書に付いていれば、その親を辿る。
  // 受取人宛てなら、文書で選んだ受取人の基本契約だけが親（条件の契約は代表のもの）。
  let parents: number[];
  if (payeeId) {
    parents = [];
    if (input.parentAgreementId) {
      const p = (await client.query(
        "SELECT id, counterparty_id, kind FROM agreements WHERE id = $1", [input.parentAgreementId])).rows[0] as any;
      if (!p) throw new DomainError("NOT_FOUND", `契約 ${input.parentAgreementId} が見つかりません`);
      if (int(p.counterparty_id) !== payeeId) {
        throw new DomainError("VALIDATION", "選んだ基本契約は受取人の契約ではありません。受取人の基本契約を選んでください");
      }
      if (String(p.kind ?? "master") !== "master") {
        // 訂正版：前の版で立てた受取人との合意（補助文書・単体契約）を引き継いでいる。それを使い続ける
        // （受取人宛てでない条件書の訂正版が、文書に付いた合意を触らないのと同じ）。
        if (input.revision && (p.kind === "supplement" || p.kind === "standalone")) return null;
        throw new DomainError("VALIDATION", "受取人宛ての条件書の親に選べるのは基本契約だけです");
      }
      parents = [Number(p.id)];
    }
  } else if (chosenMaster) {
    parents = [chosenMaster];
  } else {
    parents = [...new Set(rows.map((r) => {
      if (!r.agreement_id) return null;
      if (r.agreement_kind === "master" || r.agreement_kind === "standalone") return int(r.agreement_id);
      return int(r.agreement_parent);
    }).filter((x): x is number => x !== null))];
    if (parents.length > 1) return null;   // 基本契約が2本 → 人が決める
  }

  const today = input.issuedOn ?? new Date().toISOString().slice(0, 10);
  const workTitle = str(rows[0].work_title);
  const title = `${input.templateLabel}${workTitle ? `（${workTitle}）` : ""}${payeeId ? "（共著の取り分）" : ""}`;

  let agreementId: number;
  let agreementNo: string | null;
  let kind: "supplement" | "standalone";
  const parentId = parents[0] ?? null;

  // 前の版の器・同じ番号の器があれば、それを使う（受取人宛ては前からの扱いのまま）。
  if (!payeeId) {
    const prior = await findReusable(client, input, partyId);
    if (prior) return attachToExisting(client, input, actor, prior, parentId);
  }
  // 番号は条件書の番号（本体）。既に別の契約が使っていれば null（下で従来の採番）。
  const docNo = baseDocumentNumber(input.documentNo);
  const taken = docNo ? await client.query("SELECT id FROM agreements WHERE agreement_no = $1 LIMIT 1", [docNo]) : null;
  const fromDoc: string | null = docNo && !(taken?.rows.length) ? docNo : null;
  if (parentId) {
    const parent = (await client.query(
      "SELECT id, agreement_no, domain FROM agreements WHERE id = $1", [parentId])).rows[0] as any;
    if (fromDoc) agreementNo = fromDoc;
    else {
      const used = await client.query(
        "SELECT count(*)::int AS n FROM agreements WHERE parent_id = $1 AND kind = 'supplement'", [parentId]);
      const n = Number((used.rows[0] as { n: number }).n) + 1;
      agreementNo = `${str(parent.agreement_no) ?? `#${parentId}`}-S${String(n).padStart(2, "0")}`;
    }
    kind = "supplement";
    const r = await client.query(
      `INSERT INTO agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id,
                               effective_on)
       VALUES ($1, $2, $3, $4, 'negotiating', 'supplement', $5, $6, $7::date) RETURNING id`,
      [agreementNo, title, partyId, direction, str(parent.domain) ?? "license", parentId, today]);
    agreementId = Number((r.rows[0] as { id: number }).id);
  } else {
    agreementNo = fromDoc ?? await allocateNumber(client, { prefix: "ARC-ILT", table: "agreements", column: "agreement_no", width: 4 });
    kind = "standalone";
    const r = await client.query(
      `INSERT INTO agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, effective_on)
       VALUES ($1, $2, $3, $4, 'negotiating', 'standalone', 'license', $5::date) RETURNING id`,
      [agreementNo, title, partyId, direction, today]);
    agreementId = Number((r.rows[0] as { id: number }).id);
  }

  // 受取人宛て・基本契約が付いていた文書は、その基本契約（親）をこの合意に差し替える。
  await client.query(
    payeeId ? "UPDATE documents SET agreement_id = $2 WHERE id = $1"
            : "UPDATE documents SET agreement_id = $2 WHERE id = $1 AND (agreement_id IS NULL OR agreement_id = $3)",
    payeeId ? [input.documentId, agreementId] : [input.documentId, agreementId, parentId]);
  // 条件明細はこの器（個別契約・単体契約）のものにする。契約なしのものと、親の基本契約を
  // 直接指しているもの（個別契約待ち）だけ。別の契約に載っているものは動かさない。受取人宛ては触らない。
  const linked = !payeeId
    ? await client.query(
        "UPDATE conditions SET agreement_id = $2 WHERE id = ANY($1::bigint[]) AND (agreement_id IS NULL OR agreement_id = $3) RETURNING id",
        [input.conditionIds, agreementId, parentId])
    : { rowCount: 0 };

  await recordAudit(client, {
    actor, action: "agreement.auto", targetType: "agreement", targetId: agreementId,
    detail: { agreementNo, kind, parentId, documentId: input.documentId, documentNo: input.documentNo,
              templateKey: input.templateKey, conditionsLinked: linked.rowCount ?? 0 }
  });
  return { agreementId, agreementNo, kind, parentId, conditionsLinked: linked.rowCount ?? 0 };
}

interface Existing { id: number; agreement_no: string | null; kind: "supplement" | "standalone"; parent_id: number | null }

/**
 * 使い回せる器：前の版（差し替え元を辿る）に付いていた個別契約・単体契約、
 * 無ければ条件書の番号（本体）と同じ番号の、同じ相手の個別契約・単体契約（発注書の器は除く）。
 */
async function findReusable(client: Queryable, input: AutoAgreementInput, partyId: number): Promise<Existing | null> {
  const prior = (await client.query(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT supersedes_id, 1 FROM documents WHERE id = $1 AND supersedes_id IS NOT NULL
       UNION ALL
       SELECT d.supersedes_id, c.depth + 1 FROM documents d JOIN chain c ON d.id = c.id
        WHERE d.supersedes_id IS NOT NULL AND c.depth < 100
     )
     SELECT a.id, a.agreement_no, a.kind, a.parent_id
       FROM chain c JOIN documents d ON d.id = c.id JOIN agreements a ON a.id = d.agreement_id
      WHERE a.kind IN ('supplement', 'standalone') AND a.order_document_id IS NULL AND a.counterparty_id = $2
      ORDER BY c.depth LIMIT 1`, [input.documentId, partyId])).rows[0] as any;
  const hit = prior ?? (await client.query(
    `SELECT id, agreement_no, kind, parent_id FROM agreements
      WHERE agreement_no = $1 AND kind IN ('supplement', 'standalone') AND order_document_id IS NULL AND counterparty_id = $2
      ORDER BY id LIMIT 1`, [baseDocumentNumber(input.documentNo), partyId])).rows[0] as any;
  return hit ? { id: Number(hit.id), agreement_no: str(hit.agreement_no), kind: hit.kind, parent_id: int(hit.parent_id) } : null;
}

/**
 * 既にある個別契約・単体契約に、文書と条件を寄せる。単体契約で、条件に基本契約が付いていれば
 * その下の個別契約にする（あとから基本契約を結んだ形）。
 */
async function attachToExisting(
  client: Queryable, input: AutoAgreementInput, actor: string, a: Existing, parentId: number | null = null
): Promise<AutoAgreementResult> {
  let kind = a.kind;
  let parent = a.parent_id;
  if (kind === "standalone" && !parent && parentId) {
    await client.query("UPDATE agreements SET kind = 'supplement', parent_id = $2, updated_at = now() WHERE id = $1", [a.id, parentId]);
    kind = "supplement"; parent = parentId;
  }
  // 文書：合意が無いか、親の基本契約・前の版の器を指していれば、この器に。
  await client.query(
    "UPDATE documents SET agreement_id = $2 WHERE id = $1 AND (agreement_id IS NULL OR agreement_id = $3 OR agreement_id = $4)",
    [input.documentId, a.id, parent, input.agreementId]);
  // 条件：契約なし・親の基本契約を直接指すものだけ。別の契約に載っているものは動かさない。
  const linked = await client.query(
    "UPDATE conditions SET agreement_id = $2 WHERE id = ANY($1::bigint[]) AND (agreement_id IS NULL OR agreement_id = $3) RETURNING id",
    [input.conditionIds, a.id, parent]);
  if (linked.rowCount) {
    await recordAudit(client, {
      actor, action: "agreement.auto", targetType: "agreement", targetId: a.id,
      detail: { agreementNo: a.agreement_no, kind, parentId: parent, documentId: input.documentId, documentNo: input.documentNo,
                templateKey: input.templateKey, reused: true, conditionsLinked: linked.rowCount }
    });
  }
  return { agreementId: a.id, agreementNo: a.agreement_no, kind, parentId: parent, conditionsLinked: linked.rowCount ?? 0 };
}
