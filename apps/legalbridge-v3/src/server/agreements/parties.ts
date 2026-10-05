import { type Queryable, type Transactable, inTransaction, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 契約の当事者（A-068）。
 *
 * 契約の相手方は agreements.counterparty_id の 1 列だった。三社間契約のように
 * 当社 対 相手方が 1 対 N になる契約は「相手方を 1 社だけ選ぶ」か「同じ契約を
 * 2 本登録する」しかなく、もう 1 社は検索・取引先の画面・法務検索のどれにも出なかった。
 *
 * 主たる相手先は counterparty_id のまま（既存の画面・番号・条件の向きを壊さない）。
 * 他の当事者だけを agreement_parties に持ち、読むときは v_agreement_parties
 * （主たる相手先 seq 1 ＋ 他の当事者）で 1 本に並べる。
 *
 * 条件明細と支払の相手先は 1 社のまま。金銭の向きは必ず 2 者間で決まるので、
 * 三社間契約でも支払先は条件ごとに 1 社で正しい。
 */

export type AgreementPartyRole = "co_party" | "agent" | "guarantor" | "rights_holder" | "other";

export const PARTY_ROLES: AgreementPartyRole[] = ["co_party", "agent", "guarantor", "rights_holder", "other"];

export const PARTY_ROLE_LABEL: Record<AgreementPartyRole | "counterparty", string> = {
  counterparty: "主たる相手先",
  co_party: "共同当事者", agent: "窓口・代理", guarantor: "保証人", rights_holder: "権利者", other: "その他"
};

/** 契約書の頭書きの呼び方。主たる相手先が乙（当社が甲）なので、他の当事者は丙から。 */
const ORDINALS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
export const ordinalFor = (seq: number): string => ORDINALS[seq] ?? `当事者${seq + 1}`;

export interface AgreementParty {
  partyId: number;
  name: string;
  role: AgreementPartyRole | "counterparty";
  roleLabel: string;
  /** 頭書きの順。1 ＝主たる相手先。 */
  seq: number;
  /** 頭書きの呼び方（乙・丙・丁 …）。当社が甲。 */
  ordinal: string;
  primary: boolean;
  note: string | null;
  /** 統合された取引先を指しているか（参照は付け替えない決まり）。 */
  merged: boolean;
}

/** HEAD などの SELECT に差す、他の当事者の JSON（別名 a が agreements）。 */
export const EXTRA_PARTIES_SQL = `
  (SELECT COALESCE(json_agg(json_build_object(
            'partyId', ap.party_id, 'name', xp.name, 'role', ap.role, 'seq', ap.seq, 'note', ap.note,
            'merged', (xr.party_id <> xr.resolved_id)) ORDER BY ap.seq, ap.id), '[]'::json)
     FROM agreement_parties ap
     JOIN parties xp ON xp.id = ap.party_id
     JOIN v_party_resolved xr ON xr.party_id = ap.party_id
    WHERE ap.agreement_id = a.id AND ap.party_id <> a.counterparty_id)`;

/**
 * 「契約 A に取引先 P が当事者として入っているか」（統合を辿る）。
 * 両方とも取引先の id を返す SQL の式。契約→取引先の逆引きはすべてこれを通す。
 */
export const AGREEMENT_HAS_PARTY = (agreementExpr: string, partyExpr: string) =>
  `EXISTS (SELECT 1 FROM v_agreement_parties vap
             JOIN v_party_resolved vr ON vr.party_id = vap.party_id
            WHERE vap.agreement_id = ${agreementExpr}
              AND vr.resolved_id = (SELECT resolved_id FROM v_party_resolved WHERE party_id = ${partyExpr}))`;

/** 「契約 A に、統合先が R の取引先が当事者として入っているか」。R は resolved_id の式。 */
export const AGREEMENT_HAS_RESOLVED = (agreementExpr: string, resolvedExpr: string) =>
  `EXISTS (SELECT 1 FROM v_agreement_parties vap
             JOIN v_party_resolved vr ON vr.party_id = vap.party_id
            WHERE vap.agreement_id = ${agreementExpr} AND vr.resolved_id = ${resolvedExpr})`;

/** 他の当事者の JSON と主たる相手先から、画面に出す当事者の列を組む（DB を読まない）。 */
export function partiesOf(
  primary: { id: number; name: string; merged?: boolean },
  extras: unknown
): AgreementParty[] {
  const list = Array.isArray(extras) ? extras as Array<Record<string, unknown>> : [];
  const head: AgreementParty = {
    partyId: primary.id, name: primary.name, role: "counterparty", roleLabel: PARTY_ROLE_LABEL.counterparty,
    seq: 1, ordinal: ordinalFor(1), primary: true, note: null, merged: primary.merged === true
  };
  const rest = list
    .filter((x) => Number(x.partyId) !== primary.id)
    .map((x) => {
      const role = (PARTY_ROLES as string[]).includes(String(x.role)) ? String(x.role) as AgreementPartyRole : "other";
      const seq = Math.max(2, Number(x.seq ?? 2));
      return {
        partyId: Number(x.partyId), name: String(x.name ?? ""), role, roleLabel: PARTY_ROLE_LABEL[role],
        seq, ordinal: ordinalFor(seq), primary: false, note: str(x.note), merged: x.merged === true
      } satisfies AgreementParty;
    })
    .sort((x, y) => x.seq - y.seq);
  return [head, ...rest];
}

export interface AddPartyInput {
  partyId: number;
  role?: AgreementPartyRole | null;
  note?: string | null;
}

/** 契約 1 本の、主たる相手先と他の当事者。 */
interface Head {
  id: number; agreementNo: string | null; counterpartyId: number; counterpartyResolvedId: number;
  extras: Array<{ partyId: number; resolvedId: number; role: string; seq: number; note: string | null }>;
}

export class AgreementPartyService {
  constructor(private readonly database: Transactable) {}

  async list(agreementId: number): Promise<AgreementParty[]> {
    try {
      const r = await this.database.query(
        `SELECT a.id, a.counterparty_id, p.name AS party_name, (r.party_id <> r.resolved_id) AS party_merged,
                ${EXTRA_PARTIES_SQL} AS extra_parties
           FROM agreements a
           JOIN parties p ON p.id = a.counterparty_id
           JOIN v_party_resolved r ON r.party_id = a.counterparty_id
          WHERE a.id = $1`, [agreementId]);
      const row = r.rows[0] as Record<string, any> | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `契約 ${agreementId} が見つかりません`);
      return partiesOf({ id: Number(row.counterparty_id), name: String(row.party_name ?? ""),
                         merged: row.party_merged === true }, row.extra_parties);
    } catch (error) { throw translate(error); }
  }

  /** 他の当事者を足す。主たる相手先と同じ取引先（統合先が同じ）は断る。 */
  async add(agreementId: number, input: AddPartyInput, actor: string): Promise<void> {
    const role = roleOf(input.role);
    try {
      await inTransaction(this.database, async (client) => {
        const head = await this.head(client, agreementId);
        const target = await this.resolved(client, input.partyId);
        if (target === head.counterpartyResolvedId) {
          throw new DomainError("VALIDATION", "主たる相手先と同じ取引先です。他の当事者には入れられません");
        }
        if (head.extras.some((x) => x.resolvedId === target)) {
          throw new DomainError("VALIDATION", "この取引先はすでに当事者に入っています");
        }
        const seq = head.extras.reduce((m, x) => Math.max(m, x.seq), 1) + 1;
        await client.query(
          `INSERT INTO agreement_parties (agreement_id, party_id, role, seq, note, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [agreementId, input.partyId, role, seq, str(input.note), actor]);
        await recordAudit(client, {
          actor, action: "agreement.party.add", targetType: "agreement", targetId: agreementId,
          detail: { agreementNo: head.agreementNo, partyId: input.partyId, role, seq }
        });
      });
    } catch (error) { throw translate(error); }
  }

  /** 立場・メモ・順を直す。順を入れ替えるときは相手の行と交換する（頭書きの丙・丁が入れ替わる）。 */
  async update(
    agreementId: number, partyId: number,
    patch: { role?: AgreementPartyRole | null; note?: string | null; seq?: number | null }, actor: string
  ): Promise<void> {
    try {
      await inTransaction(this.database, async (client) => {
        const head = await this.head(client, agreementId);
        const current = head.extras.find((x) => x.partyId === partyId);
        if (!current) throw new DomainError("NOT_FOUND", `取引先 ${partyId} はこの契約の他の当事者にいません`);
        const sets: string[] = [];
        const vals: unknown[] = [];
        const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
        if (patch.role !== undefined && patch.role !== null) put("role", roleOf(patch.role));
        if (patch.note !== undefined) put("note", str(patch.note));
        if (patch.seq !== undefined && patch.seq !== null && patch.seq !== current.seq) {
          const seq = Number(patch.seq);
          if (!Number.isInteger(seq) || seq < 2) throw new DomainError("VALIDATION", "順は 2（丙）以上で入れてください");
          const other = head.extras.find((x) => x.seq === seq);
          if (other) {
            // 交換。UNIQUE(agreement_id, seq) は DEFERRABLE なので、同じトランザクションの中で入れ替えられる。
            await client.query(
              "UPDATE agreement_parties SET seq = $3 WHERE agreement_id = $1 AND party_id = $2",
              [agreementId, other.partyId, current.seq]);
          }
          put("seq", seq);
        }
        if (!sets.length) return;
        vals.push(agreementId, partyId);
        await client.query(
          `UPDATE agreement_parties SET ${sets.join(", ")} WHERE agreement_id = $${vals.length - 1} AND party_id = $${vals.length}`,
          vals);
        await recordAudit(client, {
          actor, action: "agreement.party.update", targetType: "agreement", targetId: agreementId,
          detail: { agreementNo: head.agreementNo, partyId, patch }
        });
      });
    } catch (error) { throw translate(error); }
  }

  /** 他の当事者から外す。主たる相手先は外せない（契約の相手先は付け替えで直す）。 */
  async remove(agreementId: number, partyId: number, actor: string): Promise<void> {
    try {
      await inTransaction(this.database, async (client) => {
        const head = await this.head(client, agreementId);
        if (partyId === head.counterpartyId) {
          throw new DomainError("VALIDATION", "主たる相手先は外せません。相手先を変えるときは契約の付け替えで");
        }
        const gone = await client.query(
          "DELETE FROM agreement_parties WHERE agreement_id = $1 AND party_id = $2", [agreementId, partyId]);
        if (!gone.rowCount) throw new DomainError("NOT_FOUND", `取引先 ${partyId} はこの契約の他の当事者にいません`);
        await recordAudit(client, {
          actor, action: "agreement.party.remove", targetType: "agreement", targetId: agreementId,
          detail: { agreementNo: head.agreementNo, partyId }
        });
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 他の当事者を主たる相手先にする（入れ替え）。いまの主たる相手先は、その当事者の
   * 立場・順を引き継いで他の当事者に下がる。条件明細・文書の相手先は触らない。
   */
  async makePrimary(agreementId: number, partyId: number, actor: string): Promise<void> {
    try {
      await inTransaction(this.database, async (client) => {
        const head = await this.head(client, agreementId);
        const target = head.extras.find((x) => x.partyId === partyId);
        if (!target) throw new DomainError("NOT_FOUND", `取引先 ${partyId} はこの契約の他の当事者にいません`);
        const kids = await client.query(
          "SELECT count(*)::int AS n FROM agreements WHERE parent_id = $1", [agreementId]);
        if (Number((kids.rows[0] as { n: number } | undefined)?.n ?? 0) > 0) {
          throw new DomainError("VALIDATION",
            "補助文書・解除合意がぶら下がっています。主たる相手先の入れ替えは取引先⇔基本契約の付け替えで（子の相手先とずれます）");
        }
        await client.query(
          "UPDATE agreement_parties SET party_id = $3 WHERE agreement_id = $1 AND party_id = $2",
          [agreementId, partyId, head.counterpartyId]);
        await client.query(
          "UPDATE agreements SET counterparty_id = $2, updated_at = now() WHERE id = $1", [agreementId, partyId]);
        await recordAudit(client, {
          actor, action: "agreement.party.make_primary", targetType: "agreement", targetId: agreementId,
          detail: { agreementNo: head.agreementNo, before: head.counterpartyId, after: partyId,
                    demotedRole: target.role, demotedSeq: target.seq }
        });
      });
    } catch (error) { throw translate(error); }
  }

  private async head(client: Queryable, agreementId: number): Promise<Head> {
    const r = await client.query(
      `SELECT a.id, a.agreement_no, a.counterparty_id, r.resolved_id
         FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id
        WHERE a.id = $1 FOR UPDATE OF a`, [agreementId]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `契約 ${agreementId} が見つかりません`);
    const x = await client.query(
      `SELECT ap.party_id, ap.role, ap.seq, ap.note, r.resolved_id
         FROM agreement_parties ap JOIN v_party_resolved r ON r.party_id = ap.party_id
        WHERE ap.agreement_id = $1 ORDER BY ap.seq, ap.id`, [agreementId]);
    return {
      id: Number(row.id), agreementNo: str(row.agreement_no),
      counterpartyId: Number(row.counterparty_id), counterpartyResolvedId: Number(row.resolved_id),
      extras: (x.rows as Array<Record<string, any>>).map((e) => ({
        partyId: Number(e.party_id), resolvedId: Number(e.resolved_id), role: String(e.role),
        seq: Number(e.seq), note: str(e.note)
      }))
    };
  }

  private async resolved(client: Queryable, partyId: number): Promise<number> {
    const r = await client.query("SELECT resolved_id FROM v_party_resolved WHERE party_id = $1", [partyId]);
    const id = int((r.rows[0] as Record<string, any> | undefined)?.resolved_id);
    if (!id) throw new DomainError("NOT_FOUND", `取引先 ${partyId} が見つかりません`);
    return id;
  }
}

export function roleOf(value: unknown): AgreementPartyRole {
  if (value === null || value === undefined || value === "") return "co_party";
  if ((PARTY_ROLES as string[]).includes(String(value))) return String(value) as AgreementPartyRole;
  throw new DomainError("VALIDATION", "当事者の立場が読めません（共同当事者・窓口・保証人・権利者・その他）");
}
