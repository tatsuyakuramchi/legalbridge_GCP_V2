import { dateStr, str, type Queryable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import {
  MAIL_TEMPLATES_KEY, readMailTemplates, renderMail, templateKindOf,
  type MailPurpose, type MailTemplateKind
} from "../ops/mail-templates.js";

/**
 * 文書を送るメールの下書き（宛先・件名・本文）。
 *
 * 文面は設定（mail_templates）から取り、文書・案件・取引先の値を差し込む。
 * 宛先は「何のメールか」で決める。
 *   owner_check … 依頼した事業部の担当者（案件の依頼者）へ。法務の担当を cc
 *   party_check … 取引先の主担当（無ければ連絡先の全員）へ。依頼者を cc
 *   delivery    … 取引先の請求先（無ければ主担当）へ。依頼者を cc
 * 取引先へのメール（party_check・delivery）には、設定の「いつも入れる cc」も足す。
 * 下書きを返すだけで送らない。人が画面で直してから送る。
 */

export interface MailDraft {
  purpose: MailPurpose;
  kind: MailTemplateKind;
  to: Array<{ name: string | null; email: string }>;
  cc: Array<{ name: string | null; email: string }>;
  subject: string;
  body: string;
  /** 宛先が見つからなかったなど、送る前に人が見るべきこと。 */
  warnings: string[];
}

type Person = { name: string | null; email: string };

/** 書類に載っている合計（検収金額・利用許諾料額）。整形済みの値を優先する。 */
export function amountOf(values: Record<string, unknown>): string {
  for (const key of ["grandTotalPayableStr", "totalPaymentStr", "totalAmountStr", "差引振込額", "grandTotalPayable", "totalAmount"]) {
    const v = values?.[key];
    if (v === null || v === undefined || String(v).trim() === "") continue;
    const s = String(v).trim();
    const n = Number(s.replace(/[,¥￥円\s]/g, ""));
    if (/^[0-9.,\s]+$/.test(s) && Number.isFinite(n)) return `¥${n.toLocaleString("ja-JP")}`;
    return s;
  }
  return "";
}

const japaneseDate = (iso: string | null) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return y ? `${y}年${m}月${d}日` : "";
};

export class MailDraftService {
  constructor(private readonly database: Queryable) {}

  async draft(documentId: number, purpose: MailPurpose): Promise<MailDraft> {
    try {
      const head = await this.database.query(
        `SELECT d.id, d.document_no, d.status, d.issued_at, d.matter_id, d.rendered_values,
                v.counterparty, v.counterparty_id, t.template_key,
                COALESCE(v.template_label, d.manual_inputs->>'documentKind') AS template_label,
                m.matter_no, m.title AS matter_title, m.owner_staff_id, m.requester_email
           FROM documents d
           LEFT JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
           LEFT JOIN matters m ON m.id = d.matter_id
          WHERE d.id = $1`, [documentId]);
      const doc = head.rows[0] as Record<string, any> | undefined;
      if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);

      const settings = await this.database.query(
        "SELECT key, value FROM settings WHERE key = ANY($1::text[])", [[MAIL_TEMPLATES_KEY, "company_profile"]]);
      const setting = (key: string) =>
        (settings.rows as Array<{ key: string; value: unknown }>).find((r) => r.key === key)?.value;
      const templates = readMailTemplates(setting(MAIL_TEMPLATES_KEY));
      const company = String((setting("company_profile") as Record<string, unknown> | undefined)?.name ?? "").trim();

      const owner = doc.owner_staff_id
        ? (await this.database.query("SELECT name, email FROM staff WHERE id = $1", [doc.owner_staff_id])).rows[0] as any
        : null;
      const requesterEmail = str(doc.requester_email);
      const requester = requesterEmail
        ? ((await this.database.query(
            "SELECT name, email FROM staff WHERE lower(email) = lower($1) LIMIT 1", [requesterEmail])).rows[0] as any
          ?? { name: null, email: requesterEmail })
        : null;
      const contacts = doc.counterparty_id
        ? (await this.database.query(
            `SELECT name, email, roles FROM party_contacts
              WHERE party_id = $1 AND email IS NOT NULL AND email <> '' ORDER BY id`, [doc.counterparty_id])).rows as any[]
        : [];
      const partyEmail = doc.counterparty_id
        ? str(((await this.database.query("SELECT email FROM parties WHERE id = $1", [doc.counterparty_id])).rows[0] as any)?.email)
        : null;

      const person = (p: any): Person | null => (p?.email ? { name: str(p.name), email: String(p.email) } : null);
      const withRole = (role: string) => contacts.filter((c) => Array.isArray(c.roles) && c.roles.includes(role)).map(person)
        .filter(Boolean) as Person[];
      const allContacts = contacts.map(person).filter(Boolean) as Person[];
      const partyPeople = (prefer: string[]) => {
        for (const role of prefer) { const got = withRole(role); if (got.length) return got; }
        if (allContacts.length) return allContacts;
        return partyEmail ? [{ name: null, email: partyEmail }] : [];
      };

      const warnings: string[] = [];
      if (doc.status !== "issued") warnings.push("下書きの文書です。送る前に決定してください");
      let to: Person[] = [];
      let cc: Person[] = [];
      const ownerP = person(owner);
      const requesterP = person(requester);
      if (purpose === "owner_check") {
        to = requesterP ? [requesterP] : ownerP ? [ownerP] : [];
        cc = requesterP && ownerP && ownerP.email !== requesterP.email ? [ownerP] : [];
        if (!requesterP) warnings.push("案件に依頼者のメールが無いので、宛先を法務の担当にしました。担当者を選び直してください");
      } else {
        to = partyPeople(purpose === "delivery" ? ["billing", "primary"] : ["primary"]);
        cc = requesterP ? [requesterP] : ownerP ? [ownerP] : [];
        // 取引先へのメールにいつも入れる cc（経理など。V1 の EMAIL_CC）。
        cc = [...cc, ...templates.partyCc.map((email) => ({ name: null, email }))]
          .filter((c, i, all) => all.findIndex((x) => x.email.toLowerCase() === c.email.toLowerCase()) === i);
        if (!to.length) warnings.push("取引先にメールアドレスの登録がありません。宛先を入れてください");
      }
      cc = cc.filter((c) => !to.some((t) => t.email.toLowerCase() === c.email.toLowerCase()));

      const kind = templateKindOf(purpose, str(doc.template_key));
      const rendered = renderMail(templates.templates[kind], templates.signature, {
        相手先: str(doc.counterparty) ?? "",
        宛名: to.length === 1 ? to[0].name ?? "" : "",
        文書番号: str(doc.document_no) ?? "",
        文書名: str(doc.template_label) ?? "書類",
        案件番号: str(doc.matter_no) ?? "",
        案件名: str(doc.matter_title) ?? "",
        金額: amountOf((doc.rendered_values ?? {}) as Record<string, unknown>),
        発行日: japaneseDate(dateStr(doc.issued_at)),
        会社名: company
      });
      if (kind !== "owner_check" && !company) warnings.push("自社情報の会社名が空です（運用 → 設定 → 自社情報）");
      return { purpose, kind, to, cc, subject: rendered.subject, body: rendered.body, warnings };
    } catch (error) { throw translate(error); }
  }
}
