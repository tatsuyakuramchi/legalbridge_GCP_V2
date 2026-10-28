import { type Queryable, int, str } from "../core/db.js";
import { recordAudit } from "../core/audit.js";
import { DomainError } from "../core/errors.js";
import { baseDocumentNumber } from "../documents/numbering.js";

/**
 * 発注書の個別契約（docs/v3-condition-holder.md 段階2）。
 *
 * 条件明細を持つのは個別契約（条件書・発注書）か単体契約で、基本契約は個別契約を持つ。
 * 条件書は決定したとき合意の器（agreements/auto.ts）が立つが、発注書は文書だけで器が無く、
 * 条件明細は基本契約を直接指していた。発注書にも器を立てる：
 *   基本契約の下の発注書 → kind=supplement、親＝基本契約
 *   基本契約の無い発注書 → kind=standalone（発注書の約款で取引。あとで基本契約を結んだら親を付けるだけ）
 * 番号は発注書の番号（訂正版の -R2 を除いた本体。使われていれば発注書の番号そのまま）。
 * 器は order_document_id で発注書に結び、画面では発注書として見せる（契約の一覧には出さない）。
 *
 * 発注書に載っている条件明細のうち、契約の無いもの・基本契約を直接指すもの（個別契約待ち）・
 * 前からこの発注書の器を指すもの を器に向ける。単体契約・別の個別契約に載っている条件は動かさない。
 *
 * 発注書を決定したとき（issue-service）、発注書を条件に紐づけたとき（party-map）に呼ぶ。
 * 何度呼んでも 1 枚の発注書に器は 1 つ（既にあればそれを使い、親を合わせる）。
 */

export interface OrderAgreementInput {
  documentId: number;
  documentNo: string;
  title: string | null;
  conditionIds: number[];
  /**
   * 基本契約。undefined なら条件の契約の根から決める（1 本ならそれ、何本もあれば断る、無ければ基本契約なし）。
   * null は基本契約なし。
   */
  masterId?: number | null;
}

export interface OrderAgreementResult {
  agreementId: number; agreementNo: string | null; kind: "supplement" | "standalone";
  masterId: number | null; masterNo: string | null; created: boolean; conditionsLinked: number;
}

export async function ensureAgreementForOrder(
  client: Queryable, input: OrderAgreementInput, actor: string
): Promise<OrderAgreementResult | null> {
  const ids = [...new Set(input.conditionIds.map(Number))].filter((n) => n > 0);
  const conds = ids.length ? await client.query(
    `SELECT c.id, c.counterparty_id, c.direction, c.agreement_id,
            COALESCE(a.kind, 'master') AS agreement_kind, a.parent_id AS agreement_parent, a.order_document_id AS agreement_order
       FROM conditions c
       LEFT JOIN agreements a ON a.id = c.agreement_id
      WHERE c.id = ANY($1::bigint[])`, [ids]) : { rows: [] as any[] };
  const rows = conds.rows as any[];
  // 既にこの発注書の器があるか。
  const existing = (await client.query(
    "SELECT id, agreement_no, parent_id, counterparty_id, direction FROM agreements WHERE order_document_id = $1", [input.documentId])).rows[0] as any;
  if (!rows.length && !existing) return null;

  const parties = [...new Set(rows.map((r) => int(r.counterparty_id)).filter(Boolean))];
  if (parties.length > 1) throw new DomainError("VALIDATION", "相手先の違う条件明細を 1 枚の発注書に載せることはできません");
  const partyId = parties[0] ?? int(existing?.counterparty_id);
  if (!partyId) return null;
  const direction = rows.length ? (rows.every((r) => r.direction === "out") ? "out" : "in") : (existing?.direction === "out" ? "out" : "in");

  // 基本契約。人が選んだもの（null は基本契約なし）か、条件の契約の根（個別契約ならその親）から。
  let masterId: number | null;
  if (input.masterId !== undefined) {
    masterId = input.masterId;
  } else {
    const roots = [...new Set(rows.map((r) => {
      if (!r.agreement_id) return null;
      if (r.agreement_kind === "master") return int(r.agreement_id);
      if (r.agreement_kind === "supplement" || r.agreement_kind === "termination") return int(r.agreement_parent);
      return null;   // 単体契約（この発注書の器を含む）は基本契約ではない
    }).filter((x): x is number => x !== null))];
    if (roots.length > 1) {
      throw new DomainError("VALIDATION", "この発注書の条件明細は 2 本の基本契約に分かれています。どの基本契約の下の発注書にするか選んでください");
    }
    masterId = roots[0] ?? int(existing?.parent_id);
  }
  let master: { id: number; agreement_no: string | null; domain: string | null } | null = null;
  if (masterId) {
    master = (await client.query(
      `SELECT a.id, a.agreement_no, a.domain, COALESCE(a.kind, 'master') AS kind, a.terminated_on, r.resolved_id
         FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id WHERE a.id = $1`, [masterId])).rows[0] as any;
    if (!master) throw new DomainError("NOT_FOUND", `基本契約 ${masterId} が見つかりません`);
    if ((master as any).kind !== "master") throw new DomainError("VALIDATION", "発注書の親には基本契約を選んでください");
    const party = (await client.query("SELECT resolved_id FROM v_party_resolved WHERE party_id = $1", [partyId])).rows[0] as any;
    if (party && Number((master as any).resolved_id) !== Number(party.resolved_id)) {
      throw new DomainError("VALIDATION", "基本契約と条件明細の相手先が違います");
    }
  }
  const kind: "supplement" | "standalone" = master ? "supplement" : "standalone";

  let agreementId: number;
  let agreementNo: string | null;
  let created = false;
  if (existing) {
    agreementId = Number(existing.id);
    agreementNo = str(existing.agreement_no);
    await client.query(
      `UPDATE agreements SET kind = $2, parent_id = $3, domain = COALESCE($4, domain), updated_at = now()
        WHERE id = $1 AND (COALESCE(kind, 'master') <> $2 OR parent_id IS DISTINCT FROM $3)`,
      [agreementId, kind, master ? master.id : null, master ? str(master.domain) : null]);
  } else {
    // 番号は発注書の本体番号。契約の番号として使われていれば発注書の番号そのまま。それも使われていれば断る。
    const taken = async (no: string) => Boolean((await client.query("SELECT id FROM agreements WHERE agreement_no = $1 LIMIT 1", [no])).rows[0]);
    const base = baseDocumentNumber(input.documentNo);
    agreementNo = !(await taken(base)) ? base : !(await taken(input.documentNo)) ? input.documentNo : null;
    if (!agreementNo) throw new DomainError("CONFLICT", `番号 ${base} の契約が既にあります。取引先⇔基本契約で「発注書（文書）に寄せる」か、その契約の番号を直してください`);
    const r = await client.query(
      `INSERT INTO agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id, order_document_id)
       VALUES ($1, $2, $3, $4, 'negotiating', $5, $6, $7, $8) RETURNING id`,
      [agreementNo, String(input.title ?? "").trim() || `発注書 ${agreementNo}`, partyId, direction, kind,
       str(master?.domain ?? null) ?? "service", master ? master.id : null, input.documentId]);
    agreementId = Number((r.rows[0] as { id: number }).id);
    created = true;
  }
  await client.query("UPDATE documents SET agreement_id = $2 WHERE id = $1 AND agreement_id IS DISTINCT FROM $2", [input.documentId, agreementId]);

  // 条件を器に向ける。契約なし・基本契約を直接指す（個別契約待ち）・この器 だけ。単体契約・別の個別契約は動かさない。
  const movable = rows.filter((r) => !r.agreement_id || r.agreement_kind === "master" || Number(r.agreement_id) === agreementId)
    .map((r) => Number(r.id));
  const linked = movable.length
    ? await client.query("UPDATE conditions SET agreement_id = $2, updated_at = now() WHERE id = ANY($1::bigint[]) AND agreement_id IS DISTINCT FROM $2 RETURNING id",
        [movable, agreementId])
    : { rowCount: 0 };
  await recordAudit(client, {
    actor, action: "agreement.order", targetType: "agreement", targetId: agreementId,
    detail: { agreementNo, kind, masterId: master?.id ?? null, masterNo: master ? str(master.agreement_no) : null,
              documentId: input.documentId, documentNo: input.documentNo, created, conditionsLinked: linked.rowCount ?? 0 }
  });
  return { agreementId, agreementNo, kind, masterId: master?.id ?? null, masterNo: master ? str(master.agreement_no) : null,
           created, conditionsLinked: linked.rowCount ?? 0 };
}
