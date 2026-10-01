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
 *
 * 案件の無い文書（デイリータスクで作ったもの。A-064）は、繋がっている依頼と作業から
 * 同じものを取る：依頼者＝依頼の依頼者、法務の担当＝作業の担当、案件番号＝依頼番号、
 * 案件名＝作業の件名。依頼者のメールが無ければ Slack の ID から社員を引く。
 */

/** 依頼者・担当・番号・件名。案件からでも、依頼と作業からでも同じ形にする。 */
interface Origin {
  no: string | null;
  title: string | null;
  ownerStaffId: number | null;
  requesterEmail: string | null;
  requesterSlackId: string | null;
  requesterName: string | null;
  counterpartyId: number | null;
  counterpartyName: string | null;
  /** 「案件」か「デイリータスク」か。警告の文に使う。 */
  label: string;
}

export interface DocumentRecipients {
  counterparty: { id: number | null; name: string; email: string | null } | null;
  contacts: Array<{ name: string | null; email: string; roles: string[]; department: string | null }>;
  /** 署名者の候補。署名者の印が付いた連絡先、無ければ主担当。 */
  signers: Array<{ name: string | null; email: string; roles: string[]; department: string | null }>;
  signersFrom: "signer" | "primary" | null;
  /** 事業部の担当者（依頼者）。 */
  requester: Person | null;
  /** 法務の担当（案件の担当かデイリータスクの担当）。 */
  owner: Person | null;
  origin: { label: string; no: string | null; title: string | null } | null;
}

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

  /**
   * 送り先の候補（CloudSign の署名者・確認者、メールの宛先を人が選ぶとき）。
   * 署名者＝取引先の連絡先のうち署名者の印が付いた人（無ければ主担当）、
   * 事業部の担当者＝依頼者（案件・デイリータスクの依頼者のメール）、法務の担当。
   */
  async recipients(documentId: number): Promise<DocumentRecipients> {
    try {
      const c = await this.loadContext(documentId);
      const person = (p: any): Person | null => (p?.email ? { name: str(p.name), email: String(p.email) } : null);
      const roles = (x: any) => (Array.isArray(x.roles) ? x.roles.map(String) : []) as string[];
      const contacts = c.contacts.map((x) => ({
        name: str(x.name), email: String(x.email), roles: roles(x), department: str(x.department)
      }));
      const signers = contacts.filter((x) => x.roles.includes("signer"));
      const primaries = contacts.filter((x) => x.roles.includes("primary"));
      return {
        counterparty: c.counterpartyId || c.counterpartyName
          ? { id: c.counterpartyId, name: c.counterpartyName, email: c.partyEmail } : null,
        contacts,
        signers: signers.length ? signers : primaries,
        signersFrom: signers.length ? "signer" : primaries.length ? "primary" : null,
        requester: person(c.requester),
        owner: person(c.owner),
        origin: c.origin ? { label: c.origin.label, no: c.origin.no, title: c.origin.title } : null
      };
    } catch (error) { throw translate(error); }
  }

  /** 文書の出どころ（案件かデイリータスク）と、相手先・担当・依頼者。下書きと候補の両方が使う。 */
  private async loadContext(documentId: number) {
      const head = await this.database.query(
        `SELECT d.id, d.document_no, d.status, d.issued_at, d.matter_id, d.rendered_values,
                v.counterparty, v.counterparty_id, t.template_key,
                COALESCE(v.template_label, d.manual_inputs->>'documentKind') AS template_label,
                m.matter_no, m.title AS matter_title, m.owner_staff_id, m.requester_email, m.requester_slack_id
           FROM documents d
           LEFT JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
           LEFT JOIN matters m ON m.id = d.matter_id
          WHERE d.id = $1`, [documentId]);
      const doc = head.rows[0] as Record<string, any> | undefined;
      if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);

      const origin = doc.matter_id
        ? {
            no: str(doc.matter_no), title: str(doc.matter_title),
            ownerStaffId: doc.owner_staff_id ? Number(doc.owner_staff_id) : null,
            requesterEmail: str(doc.requester_email), requesterSlackId: str(doc.requester_slack_id),
            requesterName: null, counterpartyId: null, counterpartyName: null, label: "案件"
          } satisfies Origin
        : await this.originOfRequest(documentId);
      const counterpartyId: number | null = doc.counterparty_id ? Number(doc.counterparty_id) : origin?.counterpartyId ?? null;
      const counterpartyName = str(doc.counterparty) ?? origin?.counterpartyName ?? "";
      const owner = origin?.ownerStaffId
        ? (await this.database.query("SELECT name, email FROM staff WHERE id = $1", [origin.ownerStaffId])).rows[0] as any
        : null;
      const requester = await this.requesterOf(origin);
      const contacts = counterpartyId
        ? (await this.database.query(
            `SELECT name, email, roles, department FROM party_contacts
              WHERE party_id = $1 AND email IS NOT NULL AND email <> '' ORDER BY id`, [counterpartyId])).rows as any[]
        : [];
      const partyEmail = counterpartyId
        ? str(((await this.database.query("SELECT email FROM parties WHERE id = $1", [counterpartyId])).rows[0] as any)?.email)
        : null;
      return { doc, origin, counterpartyId, counterpartyName, owner, requester, contacts, partyEmail };
  }

  async draft(documentId: number, purpose: MailPurpose): Promise<MailDraft> {
    try {
      const { doc, origin, counterpartyName, owner, requester, contacts, partyEmail } = await this.loadContext(documentId);

      const settings = await this.database.query(
        "SELECT key, value FROM settings WHERE key = ANY($1::text[])", [[MAIL_TEMPLATES_KEY, "company_profile"]]);
      const setting = (key: string) =>
        (settings.rows as Array<{ key: string; value: unknown }>).find((r) => r.key === key)?.value;
      const templates = readMailTemplates(setting(MAIL_TEMPLATES_KEY));
      const company = String((setting("company_profile") as Record<string, unknown> | undefined)?.name ?? "").trim();

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
        if (!requesterP) {
          warnings.push(origin
            ? `${origin.label}に依頼者のメールが無いので、宛先を法務の担当にしました。${origin.label}で依頼者のメールを入れるか、宛先を直してください`
            : "この文書は案件にもデイリータスクにも繋がっていないので、宛先を入れてください");
        }
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
        相手先: counterpartyName,
        宛名: to.length === 1 ? to[0].name ?? "" : "",
        文書番号: str(doc.document_no) ?? "",
        文書名: str(doc.template_label) ?? "書類",
        案件番号: origin?.no ?? "",
        案件名: origin?.title ?? "",
        金額: amountOf((doc.rendered_values ?? {}) as Record<string, unknown>),
        発行日: japaneseDate(dateStr(doc.issued_at)),
        会社名: company
      });
      if (kind !== "owner_check" && !company) warnings.push("自社情報の会社名が空です（運用 → 設定 → 自社情報）");
      return { purpose, kind, to, cc, subject: rendered.subject, body: rendered.body, warnings };
    } catch (error) { throw translate(error); }
  }

  /**
   * 案件の無い文書の出どころ。繋がっている依頼（intake_request_links の document）と、
   * その依頼から起こした作業（デイリータスク）。無ければ null。
   */
  private async originOfRequest(documentId: number): Promise<Origin | null> {
    const r = await this.database.query(
      `SELECT r.request_no, r.title AS request_title, r.requester_email, r.requester_slack_id, r.requester_name,
              r.counterparty_id, r.counterparty_name, t.title AS task_title, t.assignee_staff_id
         FROM intake_request_links l
         JOIN intake_requests r ON r.id = l.request_id
         LEFT JOIN tasks t ON t.request_id = r.id
        WHERE l.target_type = 'document' AND l.target_id = $1
        ORDER BY l.created_at DESC LIMIT 1`, [documentId]);
    const x = r.rows[0] as Record<string, any> | undefined;
    if (!x) return null;
    return {
      no: str(x.request_no), title: str(x.task_title) ?? str(x.request_title),
      ownerStaffId: x.assignee_staff_id ? Number(x.assignee_staff_id) : null,
      requesterEmail: str(x.requester_email), requesterSlackId: str(x.requester_slack_id),
      requesterName: str(x.requester_name),
      counterpartyId: x.counterparty_id ? Number(x.counterparty_id) : null,
      counterpartyName: str(x.counterparty_name), label: "デイリータスク"
    };
  }

  /**
   * 依頼者。メールがあればそれ（社員なら名前も）。無ければ Slack の ID から社員を引く
   * （Slack・手で登録した依頼はメールを持たない）。
   */
  private async requesterOf(origin: Origin | null): Promise<{ name: string | null; email: string } | null> {
    if (!origin) return null;
    if (origin.requesterEmail) {
      const s = (await this.database.query(
        "SELECT name, email FROM staff WHERE lower(email) = lower($1) LIMIT 1", [origin.requesterEmail])).rows[0] as any;
      return s ?? { name: origin.requesterName, email: origin.requesterEmail };
    }
    if (origin.requesterSlackId) {
      const s = (await this.database.query(
        "SELECT name, email FROM staff WHERE slack_user_id = $1 AND email IS NOT NULL LIMIT 1",
        [origin.requesterSlackId])).rows[0] as any;
      if (s?.email) return { name: str(s.name) ?? origin.requesterName, email: String(s.email) };
    }
    return null;
  }
}
