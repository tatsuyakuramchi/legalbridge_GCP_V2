import type { Queryable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 相手先ごとの「未送付の文書」（docs/royalty-shares.md §5.6）。
 *
 * 一括で決定した基本契約書（出版許諾契約書）・条件書・利用許諾計算書を、相手先ごとに
 * 1 通（メール）・1 封筒（CloudSign）で送るための一覧。決定済みで、送った記録
 * （gmail.send / cloudsign.send）の無い文書を相手先で束ねる。
 *
 * 相手先は文書の相手先（契約・案件・先頭の条件の相手先）。受取人宛ての文書
 * （共著の取り分。manual_inputs._payeePartyId）はその受取人。
 * 送るのは既存の「選んだ文書を 1 通・1 封筒で送る」（/documents/send-many・/sign-many）。
 */

export const BUNDLE_TEMPLATE_KEYS = [
  "pub_master_individual", "pub_master_corporate", "license_master",
  "pub_license_terms_v3", "pub_license_terms_v3_annex", "individual_license_terms_v3", "individual_license_terms_v4",
  "royalty_statement", "royalty_statement_pub"
];

export type UnsentKind = "master" | "terms" | "statement" | "other";

export interface UnsentDoc {
  id: number; documentNo: string | null; templateKey: string | null; templateLabel: string | null;
  kind: UnsentKind; issuedOn: string | null;
}
export interface UnsentBundle {
  partyId: number; partyName: string; partyKind: string | null; email: string | null;
  docs: UnsentDoc[];
  counts: Record<UnsentKind, number>;
}

export function kindOfTemplate(templateKey: string | null): UnsentKind {
  const k = String(templateKey ?? "");
  if (/master/.test(k)) return "master";
  if (/terms/.test(k)) return "terms";
  if (k === "royalty_statement" || k === "royalty_statement_pub") return "statement";
  return "other";
}

export class UnsentBundlesService {
  constructor(private readonly database: Queryable) {}

  async list(): Promise<{ bundles: UnsentBundle[] }> {
    try {
      const docs = (await this.database.query(
        `SELECT d.id, d.document_no, d.issued_at, t.template_key,
                COALESCE(t.label, d.manual_inputs->>'documentKind') AS template_label,
                COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                              THEN (d.manual_inputs->>'_payeePartyId')::bigint END,
                         v.counterparty_id) AS party_id
           FROM documents d
           JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE d.status = 'issued' AND t.template_key = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM audit_events a
                             WHERE a.target_type = 'document' AND a.target_id = d.id
                               AND a.action IN ('gmail.send', 'cloudsign.send'))
          ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [BUNDLE_TEMPLATE_KEYS])).rows as Array<Record<string, any>>;
      const partyIds = [...new Set(docs.map((d) => d.party_id).filter((x) => x !== null && x !== undefined).map(Number))];
      const parties = partyIds.length ? (await this.database.query(
        `SELECT p.id, p.name, p.kind,
                COALESCE(NULLIF(btrim(p.email), ''),
                         (SELECT pc.email FROM party_contacts pc
                           WHERE pc.party_id = p.id AND NULLIF(btrim(pc.email), '') IS NOT NULL ORDER BY pc.id LIMIT 1)) AS email
           FROM parties p WHERE p.id = ANY($1::bigint[])`, [partyIds])).rows as Array<Record<string, any>> : [];
      const byParty = new Map<number, UnsentBundle>();
      for (const p of parties) {
        byParty.set(Number(p.id), { partyId: Number(p.id), partyName: String(p.name ?? ""), partyKind: str(p.kind), email: str(p.email),
                                    docs: [], counts: { master: 0, terms: 0, statement: 0, other: 0 } });
      }
      for (const d of docs) {
        const partyId = d.party_id === null || d.party_id === undefined ? null : Number(d.party_id);
        if (partyId === null) continue;
        const bundle = byParty.get(partyId);
        if (!bundle) continue;
        const kind = kindOfTemplate(str(d.template_key));
        bundle.docs.push({ id: Number(d.id), documentNo: str(d.document_no), templateKey: str(d.template_key),
                           templateLabel: str(d.template_label), kind, issuedOn: dateStr(d.issued_at) });
        bundle.counts[kind] += 1;
      }
      const order: Record<UnsentKind, number> = { master: 0, terms: 1, statement: 2, other: 3 };
      const bundles = [...byParty.values()].filter((b) => b.docs.length)
        .map((b) => ({ ...b, docs: [...b.docs].sort((x, y) => order[x.kind] - order[y.kind] || x.id - y.id) }))
        .sort((a, b) => a.partyId - b.partyId);
      return { bundles };
    } catch (error) { throw translate(error); }
  }
}
