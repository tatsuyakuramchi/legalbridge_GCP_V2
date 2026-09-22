import { type Queryable, int, str } from "../core/db.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";

/**
 * 条件書を決定したとき、合意を自動で起こす（合意の生まれ方 ②）。
 *
 * 個別利用許諾条件書・出版条件書は、条件明細が先にあって紙が後。
 * 相手と結ぶ契約そのものなので、決定した瞬間に合意の器を立てる。
 *   載せた条件に基本契約が付いていれば → その下の補助文書（親番号-S01）
 *   付いていなければ                   → 単体契約（ARC-ILT）
 * 文書.合意 と、載せた条件の合意（空のものだけ）を同時に埋める。
 * 状態は「交渉中」。送信→締結の記録で「締結済み」になる（send-service）。
 *
 * 発注書・検収書・計算書はここを通らない（基本契約の下の個別取引で、合意ではない）。
 * 文書に既に合意が付いていれば何もしない（人が選んだものを上書きしない）。
 */

/** 合意を起こす条件書のひな形。 */
export const TERMS_TEMPLATE_KEYS = new Set([
  "individual_license_terms_v3", "pub_license_terms_v3", "pub_license_terms_v3_annex"
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
}

export interface AutoAgreementResult {
  agreementId: number; agreementNo: string | null; kind: "supplement" | "standalone";
  parentId: number | null; conditionsLinked: number;
}

export async function ensureAgreementForTerms(
  client: Queryable, input: AutoAgreementInput, actor: string
): Promise<AutoAgreementResult | null> {
  if (!TERMS_TEMPLATE_KEYS.has(input.templateKey)) return null;
  if (input.agreementId) return null;
  if (!input.conditionIds.length) return null;

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
  const partyId = parties[0]!;
  const direction = rows.every((r) => r.direction === "out") ? "out" : "in";

  // 載せた条件の基本契約。基本契約そのもの（か単体契約）だけを親にする。
  // 補助文書に付いていれば、その親を辿る。
  const parents = [...new Set(rows.map((r) => {
    if (!r.agreement_id) return null;
    if (r.agreement_kind === "master" || r.agreement_kind === "standalone") return int(r.agreement_id);
    return int(r.agreement_parent);
  }).filter((x): x is number => x !== null))];
  if (parents.length > 1) return null;   // 基本契約が2本 → 人が決める

  const today = input.issuedOn ?? new Date().toISOString().slice(0, 10);
  const workTitle = str(rows[0].work_title);
  const title = `${input.templateLabel}${workTitle ? `（${workTitle}）` : ""}`;

  let agreementId: number;
  let agreementNo: string | null;
  let kind: "supplement" | "standalone";
  const parentId = parents[0] ?? null;
  if (parentId) {
    const parent = (await client.query(
      "SELECT id, agreement_no, domain FROM agreements WHERE id = $1", [parentId])).rows[0] as any;
    const used = await client.query(
      "SELECT count(*)::int AS n FROM agreements WHERE parent_id = $1 AND kind = 'supplement'", [parentId]);
    const n = Number((used.rows[0] as { n: number }).n) + 1;
    agreementNo = `${str(parent.agreement_no) ?? `#${parentId}`}-S${String(n).padStart(2, "0")}`;
    kind = "supplement";
    const r = await client.query(
      `INSERT INTO agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id,
                               effective_on)
       VALUES ($1, $2, $3, $4, 'negotiating', 'supplement', $5, $6, $7::date) RETURNING id`,
      [agreementNo, title, partyId, direction, str(parent.domain) ?? "license", parentId, today]);
    agreementId = Number((r.rows[0] as { id: number }).id);
  } else {
    agreementNo = await allocateNumber(client, { prefix: "ARC-ILT", table: "agreements", column: "agreement_no", width: 4 });
    kind = "standalone";
    const r = await client.query(
      `INSERT INTO agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, effective_on)
       VALUES ($1, $2, $3, $4, 'negotiating', 'standalone', 'license', $5::date) RETURNING id`,
      [agreementNo, title, partyId, direction, today]);
    agreementId = Number((r.rows[0] as { id: number }).id);
  }

  await client.query("UPDATE documents SET agreement_id = $2 WHERE id = $1 AND agreement_id IS NULL",
    [input.documentId, agreementId]);
  // 条件の合意は空のものだけ埋める。補助文書のときは親（基本契約）のままにする
  // （条件は基本契約の明細であって、覚書の明細ではない）。
  const linked = kind === "standalone"
    ? await client.query(
        "UPDATE conditions SET agreement_id = $2 WHERE id = ANY($1::bigint[]) AND agreement_id IS NULL RETURNING id",
        [input.conditionIds, agreementId])
    : { rowCount: 0 };

  await recordAudit(client, {
    actor, action: "agreement.auto", targetType: "agreement", targetId: agreementId,
    detail: { agreementNo, kind, parentId, documentId: input.documentId, documentNo: input.documentNo,
              templateKey: input.templateKey, conditionsLinked: linked.rowCount ?? 0 }
  });
  return { agreementId, agreementNo, kind, parentId, conditionsLinked: linked.rowCount ?? 0 };
}
