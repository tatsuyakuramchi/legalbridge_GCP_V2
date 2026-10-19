import type { Queryable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { joinContactParts } from "./contact-line.js";

/**
 * 通知先の空いた契約書（出版の基本契約書・条件書）を、通知先を入れて訂正版で出し直す。
 *
 * 契約なしから一括で作った契約書は、通知先が空のまま決定されていた。
 *   - 条件書の第９条 甲（許諾者）：取引先の主担当（個人は本人）。連絡先の無い取引先で空になる
 *   - 条件書の第９条 乙（当社）　：案件の担当者。一括作成は案件が無いので空になる
 *   - 基本契約書の 通知先 担当者・電話・メール：相手先の窓口。人が選ぶ欄で、自動では入らない
 * 甲・相手先の窓口：個人は本人（主担当がいればその人）。法人は主担当、いなければ代表者（肩書・氏名と
 * 取引先のメール・電話）、代表者も無ければ連絡先の先頭 → 取引先のメール・電話。
 * 乙は画面で選んだ当社の担当者（部署・氏名・メール・電話）。文書の担当者（_ownerStaffId）にもする。
 *
 * 決定済みの文書は中身が凍っているので、空いた欄だけを手入力に足した訂正版を、元の締結日・
 * 決定日のまま出し直す。入っている欄は触らない。必ず試算（preview）を見てから出す。
 */

export const TERMS_KEYS = ["pub_license_terms_v3", "pub_license_terms_v3_annex"];
export const MASTER_KEYS = ["pub_master_individual", "pub_master_corporate"];
export const NOTICE_REASON = "通知先を記載する";

export interface NoticeTarget {
  documentId: number;
  documentNo: string | null;
  kind: "terms" | "master";
  partyName: string | null;
  issuedOn: string | null;
  /** 入れる値（空いていた欄だけ）。画面に出す。 */
  fills: Array<{ field: string; label: string; value: string }>;
  /** 出し直せない理由（相手先の連絡先が無い・担当者を選んでいない・人の下書きが開いている）。 */
  skip: string | null;
  /** 前に決定に失敗して残った、この出し直しの下書き。作り直さずにこれを決定する。 */
  reuseDraftId: number | null;
  /** 訂正版の手入力に足すもの。 */
  patch: Record<string, unknown>;
}

export interface NoticeResult {
  documentId: number; documentNo: string | null;
  status: "reissued" | "skipped" | "error";
  newDocumentNo?: string | null; message?: string;
}

export interface NoticeReissuer {
  reissue(documentId: number, reason: string, actor: string): Promise<{ id: number }>;
  issue(documentId: number, actor: string, extra?: { issuedOn?: string | null }): Promise<{ documentNo?: string | null }>;
}

type Person = { department: string | null; name: string | null; email: string | null; phone: string | null };

const CANDIDATES = `
  SELECT d.id, d.document_no, d.issued_at, t.template_key,
         d.rendered_values->>'licensorContact' AS licensor,
         d.rendered_values->>'licenseeContact' AS licensee,
         d.rendered_values->>'通知先担当者' AS notice_name,
         d.rendered_values->>'通知先電話' AS notice_phone,
         d.rendered_values->>'通知先メール' AS notice_email,
         COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                       THEN (d.manual_inputs->>'_payeePartyId')::bigint END,
                  CASE WHEN t.template_key = ANY($2::text[]) THEN a.counterparty_id END,
                  (SELECT c.counterparty_id FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
                    WHERE dc.document_id = d.id ORDER BY dc.line_no NULLS LAST, dc.condition_id LIMIT 1),
                  a.counterparty_id) AS party_id,
         (SELECT x.id FROM documents x WHERE x.supersedes_id = d.id AND x.status = 'draft' ORDER BY x.id LIMIT 1) AS open_draft,
         (SELECT x.supersede_reason FROM documents x WHERE x.supersedes_id = d.id AND x.status = 'draft' ORDER BY x.id LIMIT 1) AS open_draft_reason
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
    LEFT JOIN agreements a ON a.id = d.agreement_id
   WHERE d.status = 'issued' AND t.template_key = ANY($1::text[])
     AND (
       (t.template_key = ANY($2::text[])
        AND COALESCE(btrim(d.rendered_values->>'通知先担当者'), '') = ''
        AND COALESCE(btrim(d.rendered_values->>'通知先電話'), '') = ''
        AND COALESCE(btrim(d.rendered_values->>'通知先メール'), '') = '')
       OR (NOT t.template_key = ANY($2::text[])
        AND (COALESCE(btrim(d.rendered_values->>'licensorContact'), '') = ''
             OR COALESCE(btrim(d.rendered_values->>'licenseeContact'), '') = ''))
     )
   ORDER BY d.document_no`;

const blank = (v: unknown) => String(v ?? "").trim() === "";
const line = (p: Person) => joinContactParts({
  department: p.department ?? "", name: p.name ?? "", email: p.email ?? "", phone: p.phone ?? ""
});

export class NoticeFillService {
  constructor(private readonly database: Queryable, private readonly issuer: NoticeReissuer | null = null) {}

  /** 出し直す契約書と、空いた欄に入れる値。ownerStaffId は条件書の乙（当社）の通知先。 */
  async preview(ownerStaffId: number | null = null): Promise<{ targets: NoticeTarget[]; staff: string | null }> {
    try {
      const rows = (await this.database.query(CANDIDATES, [[...TERMS_KEYS, ...MASTER_KEYS], MASTER_KEYS])).rows as Array<Record<string, any>>;
      const partyIds = [...new Set(rows.map((r) => r.party_id).filter((x) => x != null).map(Number))];
      const people = partyIds.length ? await this.partyWindows(partyIds) : new Map<number, { name: string; person: Person | null }>();
      const staff = ownerStaffId ? await this.staff(ownerStaffId) : null;
      if (ownerStaffId && !staff) throw new DomainError("NOT_FOUND", `担当者 ${ownerStaffId} が見つかりません`);

      const targets = rows.map((r): NoticeTarget => {
        const kind = MASTER_KEYS.includes(String(r.template_key)) ? "master" : "terms";
        const party = r.party_id != null ? people.get(Number(r.party_id)) ?? null : null;
        const fills: NoticeTarget["fills"] = [];
        const patch: Record<string, unknown> = {};
        const reasons: string[] = [];
        const window = party?.person ?? null;
        if (kind === "master") {
          if (window) {
            const name = [window.department, window.name].filter(Boolean).join(" ");
            if (name) { patch["通知先担当者"] = name; fills.push({ field: "通知先担当者", label: "通知先 担当者", value: name }); }
            if (window.phone) { patch["通知先電話"] = window.phone; fills.push({ field: "通知先電話", label: "通知先 電話", value: window.phone }); }
            if (window.email) { patch["通知先メール"] = window.email; fills.push({ field: "通知先メール", label: "通知先 メール", value: window.email }); }
          }
          if (!fills.length) reasons.push("取引先に連絡先（主担当・メール・電話）がありません。取引先の画面で入れてください");
        } else {
          if (blank(r.licensor)) {
            const value = window ? line(window) : "";
            if (value) { patch["許諾者連絡先"] = value; fills.push({ field: "許諾者連絡先", label: "甲（許諾者）", value }); }
            else reasons.push("取引先に連絡先（主担当・メール・電話）がありません。取引先の画面で入れてください");
          }
          if (blank(r.licensee)) {
            if (staff) {
              const value = line(staff);
              patch["被許諾者連絡先"] = value;
              patch["_ownerStaffId"] = ownerStaffId;
              fills.push({ field: "被許諾者連絡先", label: "乙（当社）", value });
            } else reasons.push("乙（当社）の通知先に入れる担当者を選んでください");
          }
        }
        let reuseDraftId: number | null = null;
        if (r.open_draft) {
          if (str(r.open_draft_reason) === NOTICE_REASON) reuseDraftId = Number(r.open_draft);
          else reasons.push(`訂正版の下書き（#${r.open_draft}）が開いています。それを決定するか捨ててください`);
        }
        return {
          documentId: Number(r.id), documentNo: str(r.document_no), kind, partyName: party?.name ?? null,
          issuedOn: dateStr(r.issued_at), fills, patch, reuseDraftId,
          // 入れられる欄が 1 つでもあれば出し直す（甲だけ・乙だけでも）。人の下書きがあれば出さない。
          skip: reasons.find((x) => x.startsWith("訂正版の下書き")) ?? (fills.length ? null : reasons.join("・") || "入れる値がありません")
        };
      });
      return { targets, staff: staff ? line(staff) : null };
    } catch (error) { throw translate(error); }
  }

  /** 選んだ契約書を、空いた欄を埋めた訂正版で出し直す（元の締結日・決定日のまま）。1 枚ずつ。失敗しても止めない。 */
  async run(documentIds: number[], ownerStaffId: number | null, actor: string): Promise<{ reissued: number; results: NoticeResult[] }> {
    if (!this.issuer) throw new DomainError("UNAVAILABLE", "出し直しの口がありません");
    const { targets } = await this.preview(ownerStaffId);
    const byId = new Map(targets.map((t) => [t.documentId, t]));
    const results: NoticeResult[] = [];
    for (const id of [...new Set(documentIds.map(Number))]) {
      const t = byId.get(id);
      if (!t) {
        results.push({ documentId: id, documentNo: null, status: "skipped", message: "通知先の空いた契約書ではありません（もう出し直したか、入っています）" });
        continue;
      }
      if (t.skip) { results.push({ documentId: id, documentNo: t.documentNo, status: "skipped", message: t.skip }); continue; }
      try {
        const draftId = t.reuseDraftId ?? (await this.issuer.reissue(id, NOTICE_REASON, actor)).id;
        await this.database.query(
          "UPDATE documents SET manual_inputs = COALESCE(manual_inputs, '{}'::jsonb) || $2::jsonb WHERE id = $1 AND status = 'draft'",
          [draftId, JSON.stringify(t.patch)]);
        const issued = await this.issuer.issue(draftId, actor, { issuedOn: t.issuedOn });
        results.push({ documentId: id, documentNo: t.documentNo, status: "reissued", newDocumentNo: issued.documentNo ?? null });
      } catch (error) {
        results.push({ documentId: id, documentNo: t.documentNo, status: "error",
                       message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { reissued: results.filter((r) => r.status === "reissued").length, results };
  }

  /** 取引先の窓口：主担当 → （法人は）代表者 → 連絡先の先頭 → 取引先そのもの（個人は本人、法人は氏名なしでメール・電話）。 */
  private async partyWindows(ids: number[]): Promise<Map<number, { name: string; person: Person | null }>> {
    const rows = (await this.database.query(
      `SELECT p.id, p.name, p.kind, p.email, p.phone,
              to_jsonb(p)->>'representative_name' AS rep_name, to_jsonb(p)->>'representative_title' AS rep_title,
              COALESCE((SELECT json_agg(json_build_object('name', c.name, 'email', c.email, 'phone', c.phone,
                                                          'department', c.department, 'roles', c.roles, 'role', c.role)
                                        ORDER BY c.id)
                          FROM party_contacts c WHERE c.party_id = p.id), '[]'::json) AS contacts
         FROM parties p WHERE p.id = ANY($1::bigint[])`, [ids])).rows as Array<Record<string, any>>;
    const out = new Map<number, { name: string; person: Person | null }>();
    for (const r of rows) {
      const contacts = (Array.isArray(r.contacts) ? r.contacts : []) as Array<Record<string, any>>;
      const asPerson = (c: Record<string, any>): Person => ({
        department: str(c.department), name: str(c.name), email: str(c.email), phone: str(c.phone)
      });
      const isPrimary = (c: Record<string, any>) =>
        (Array.isArray(c.roles) && c.roles.map(String).includes("primary")) || c.role === "primary";
      const useful = (p: Person) => Boolean(p.name || p.email || p.phone);
      const primary = contacts.find(isPrimary);
      const first = contacts.find((c) => useful(asPerson(c)));
      const self: Person = {
        department: null, name: String(r.kind) === "individual" ? str(r.name) : null,
        email: str(r.email), phone: str(r.phone)
      };
      // 法人で主担当がいなければ代表者。部署の位置に肩書（代表取締役 など）を置く。
      const rep: Person | null = String(r.kind) !== "individual" && str(r.rep_name)
        ? { department: str(r.rep_title), name: str(r.rep_name), email: str(r.email), phone: str(r.phone) } : null;
      const person = primary && useful(asPerson(primary)) ? asPerson(primary)
        : rep ? rep
        : first ? asPerson(first)
        : useful(self) ? self : null;
      out.set(Number(r.id), { name: String(r.name ?? ""), person });
    }
    return out;
  }

  private async staff(id: number): Promise<Person | null> {
    const r = (await this.database.query(
      "SELECT s.name, s.email, s.department, to_jsonb(s)->>'phone' AS phone FROM staff s WHERE s.id = $1", [id])).rows[0] as Record<string, any> | undefined;
    return r ? { department: str(r.department), name: str(r.name), email: str(r.email), phone: str(r.phone) } : null;
  }
}
