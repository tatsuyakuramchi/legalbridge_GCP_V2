import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 取引先の名寄せ。
 *
 * 参照は付け替えない。条件も支払も文書も、統合前の相手先を指したままにし、
 * 表示と集計は v_party_resolved で統合先まで辿る。
 *
 * 付け替える方式を採らない理由は2つ。
 *   - 取り消せなくなる。元がどれだったか分からなくなる。
 *   - 書き換え漏れが起きた箇所だけ古い名前が残り、しかも気づけない。
 *     V1 の取引先が2,552件まで膨らんだのと同じ壊れ方をする。
 */

export interface MergeCandidate {
  keyName: string;
  parties: Array<{
    id: number; partyCode: string | null; name: string; kind: string; status: string;
    invoiceNo: string | null; corporateNo: string | null;
    conditions: number; payments: number; agreements: number; matters: number;
  }>;
}

export interface MergePreview {
  from: { id: number; name: string; partyCode: string | null };
  into: { id: number; name: string; partyCode: string | null };
  /** 統合後に統合先を通して見えるようになる件数。 */
  moves: { conditions: number; payments: number; agreements: number; matters: number };
  /** 統合を止めるべき理由。空なら実行できる。 */
  blockers: string[];
  /** 止めはしないが確認すべきこと。 */
  warnings: string[];
}

const COUNTS = `
  (SELECT count(*)::int FROM conditions c WHERE c.counterparty_id = p.id) AS conditions,
  (SELECT count(*)::int FROM payments y   WHERE y.party_id = p.id)        AS payments,
  (SELECT count(*)::int FROM agreements a WHERE a.counterparty_id = p.id) AS agreements,
  (SELECT count(*)::int FROM matters m    WHERE m.counterparty_id = p.id) AS matters`;

export class PartyMergeService {
  constructor(private readonly database: Transactable) {}

  /**
   * 名寄せの候補。
   * 完全一致・カナ一致・法人番号一致だけを見る。表記ゆれの推測はしない
   * （間違った統合は取り消せても、気づかれないまま数字が狂う）。
   */
  async candidates(limit = 100): Promise<MergeCandidate[]> {
    try {
      const r = await this.database.query(
        `WITH keyed AS (
           SELECT p.id, p.party_code, p.name, p.kind, p.status,
                  p.invoice_no, p.corporate_no,
                  COALESCE(
                    NULLIF(btrim(p.corporate_no), ''),
                    NULLIF(btrim(p.name_kana), ''),
                    btrim(p.name)
                  ) AS key_name,
                  ${COUNTS}
             FROM parties p
            WHERE p.status <> 'merged' AND p.party_code IS DISTINCT FROM 'UNRESOLVED'
         )
         SELECT key_name, json_agg(row_to_json(keyed) ORDER BY conditions DESC, id) AS parties
           FROM keyed GROUP BY key_name HAVING count(*) > 1
          ORDER BY count(*) DESC, key_name LIMIT $1`, [limit]);

      return (r.rows as any[]).map((row) => ({
        keyName: String(row.key_name),
        parties: (row.parties as any[]).map((p) => ({
          id: Number(p.id), partyCode: p.party_code ?? null, name: String(p.name),
          kind: String(p.kind), status: String(p.status),
          invoiceNo: p.invoice_no ?? null, corporateNo: p.corporate_no ?? null,
          conditions: Number(p.conditions), payments: Number(p.payments),
          agreements: Number(p.agreements), matters: Number(p.matters)
        }))
      }));
    } catch (error) { throw translate(error); }
  }

  async preview(fromId: number, intoId: number): Promise<MergePreview> {
    try {
      return await this.check(this.database, fromId, intoId);
    } catch (error) { throw translate(error); }
  }

  async merge(fromId: number, intoId: number, actor: string): Promise<MergePreview> {
    try {
      return await inTransaction(this.database, async (client) => {
        const check = await this.check(client, fromId, intoId);
        if (check.blockers.length) {
          throw new DomainError("CONFLICT", check.blockers.join(" / "), { blockers: check.blockers });
        }

        // 統合元の名前を統合先の別名に残す。検索で辿れなくなると困る。
        await client.query(
          `UPDATE parties SET
             aliases = (SELECT array_agg(DISTINCT a) FROM unnest(
                          aliases || ARRAY[$2::text] ||
                          (SELECT COALESCE(aliases, '{}') FROM parties WHERE id = $3)
                        ) a WHERE a IS NOT NULL AND btrim(a) <> '' AND a <> name),
             updated_at = now()
           WHERE id = $1`, [intoId, check.from.name, fromId]);

        await client.query(
          `UPDATE parties SET status = 'merged', merged_into_id = $2, updated_at = now()
            WHERE id = $1`, [fromId, intoId]);

        await recordAudit(client, {
          actor, action: "party.merge", targetType: "party", targetId: fromId,
          detail: { from: check.from, into: check.into, moves: check.moves,
                    warnings: check.warnings }
        });
        return check;
      });
    } catch (error) { throw translate(error); }
  }

  /** 統合を取り消す。参照を付け替えていないので、印を外すだけで元に戻る。 */
  async unmerge(partyId: number, actor: string): Promise<{ id: number; name: string }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          "SELECT id, name, status, merged_into_id FROM parties WHERE id = $1 FOR UPDATE", [partyId]);
        const row = r.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `取引先 ${partyId} が見つかりません`);
        if (row.status !== "merged") {
          throw new DomainError("CONFLICT", "この取引先は統合されていません");
        }
        await client.query(
          "UPDATE parties SET status = 'active', merged_into_id = NULL, updated_at = now() WHERE id = $1",
          [partyId]);
        await recordAudit(client, {
          actor, action: "party.unmerge", targetType: "party", targetId: partyId,
          detail: { name: row.name, was: Number(row.merged_into_id) }
        });
        return { id: partyId, name: String(row.name) };
      });
    } catch (error) { throw translate(error); }
  }

  private async check(client: Queryable, fromId: number, intoId: number): Promise<MergePreview> {
    if (fromId === intoId) {
      throw new DomainError("VALIDATION", "同じ取引先どうしは統合できません");
    }
    const r = await client.query(
      `SELECT p.id, p.party_code, p.name, p.kind, p.status, p.merged_into_id,
              p.invoice_no, p.corporate_no, ${COUNTS}
         FROM parties p WHERE p.id = ANY($1::bigint[])`, [[fromId, intoId]]);
    const rows = r.rows as any[];
    const from = rows.find((x) => Number(x.id) === fromId);
    const into = rows.find((x) => Number(x.id) === intoId);
    if (!from) throw new DomainError("NOT_FOUND", `統合元 ${fromId} が見つかりません`);
    if (!into) throw new DomainError("NOT_FOUND", `統合先 ${intoId} が見つかりません`);

    const blockers: string[] = [];
    const warnings: string[] = [];

    if (from.status === "merged") blockers.push("統合元はすでに統合されています");
    if (into.status === "merged") {
      blockers.push("統合先が別の取引先へ統合されています。最終的な統合先を指定してください");
    }
    if (from.party_code === "UNRESOLVED" || into.party_code === "UNRESOLVED") {
      blockers.push("「（相手先未特定）」の受け皿は統合に使えません。個別に相手先を割り当ててください");
    }
    if (from.kind !== into.kind) {
      // 個人と法人では源泉も取適法の扱いも違う。取り違えると支払が狂う。
      blockers.push(
        `区分が違います（${from.kind === "individual" ? "個人" : "法人"} → ` +
        `${into.kind === "individual" ? "個人" : "法人"}）。源泉と取適法の扱いが変わるため統合できません`);
    }

    const inv = [from.invoice_no, into.invoice_no].filter((x) => x && String(x).trim());
    if (inv.length === 2 && String(from.invoice_no).trim() !== String(into.invoice_no).trim()) {
      warnings.push(
        `インボイス番号が違います（${from.invoice_no} / ${into.invoice_no}）。別法人の可能性があります`);
    }
    const corp = [from.corporate_no, into.corporate_no].filter((x) => x && String(x).trim());
    if (corp.length === 2 && String(from.corporate_no).trim() !== String(into.corporate_no).trim()) {
      warnings.push(
        `法人番号が違います（${from.corporate_no} / ${into.corporate_no}）。別法人です`);
    }

    return {
      from: { id: fromId, name: String(from.name), partyCode: from.party_code ?? null },
      into: { id: intoId, name: String(into.name), partyCode: into.party_code ?? null },
      moves: {
        conditions: Number(from.conditions), payments: Number(from.payments),
        agreements: Number(from.agreements), matters: Number(from.matters)
      },
      blockers, warnings
    };
  }
}
