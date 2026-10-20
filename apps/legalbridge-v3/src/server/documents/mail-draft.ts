import { dateStr, str, type Queryable } from "../core/db.js";
import { splitContact } from "./contact-line.js";
import { printedDocumentNumber, showRevisionOf } from "./numbering.js";
import { DomainError, translate } from "../core/errors.js";
import {
  MAIL_TEMPLATES_KEY, readMailTemplates, renderMail, templateKindOf,
  type MailPurpose, type MailTemplateKind, isCustomPurpose, resolveMailTemplate
} from "../ops/mail-templates.js";

/**
 * 文書を送るメールの下書き（宛先・件名・本文）。
 *
 * 文面は設定（mail_templates）から取り、文書・案件・取引先の値を差し込む。
 * 宛先は「何のメールか」で決める。
 *   owner_check … 依頼した事業部の担当者（案件の依頼者）へ。法務の担当を cc
 *   party_check … 取引先の主担当（無ければ連絡先の全員）へ。依頼者を cc
 *   contract_unify … 契約書の統一（書面化）のご案内。宛先・cc は party_check と同じ
 *   delivery    … 取引先の請求先（無ければ主担当）へ。依頼者を cc
 * 取引先へのメール（party_check・contract_unify・delivery）には、設定の「いつも入れる cc」も足す。
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
  /** 使った文面。決まったものは種類、足したものは custom:<key>。 */
  kind: string;
  /** {担当者名} に入れた値と、その出どころ（notice＝通知条項／input＝送る画面で入れた／null＝無い）。 */
  staffName: string; staffNameFrom: "notice" | "input" | null;
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

/** 計算書に載っている対象期間（出版の計算書 pubPeriodLabel、回の期間 rs_period_label、旧 対象期間）。 */
export function periodOf(d: Record<string, any>): string {
  const v = (d.rendered_values ?? {}) as Record<string, unknown>;
  const m = (d.manual_inputs ?? {}) as Record<string, unknown>;
  for (const x of [v.pubPeriodLabel, m.rs_period_label, v["対象期間"], v.periodLabel, v.period, v["計算期間"]]) {
    if (x && String(x).trim()) return String(x).trim();
  }
  return "";
}
/** 計算書に載っている支払期日（PAYMENT_DATE ほか。legacy-variables と同じ名前）。 */
export function payDateOf(d: Record<string, any>): string {
  const v = (d.rendered_values ?? {}) as Record<string, unknown>;
  for (const x of [v.PAYMENT_DATE, v.paymentDueDate, v["支払期日"], v.summaryPaymentDate, v["支払予定日"], v["お支払予定日"]]) {
    if (x && String(x).trim()) return String(x).trim();
  }
  return "";
}
/** 通知条項の当社担当者の氏名（基本契約書の乙 STAFF_NAME・条件書の被許諾者連絡先）。部署・メール・電話は落とす。 */
export function noticeStaffOf(d: Record<string, any>): string {
  const v = (d.rendered_values ?? {}) as Record<string, unknown>;
  for (const x of [v.STAFF_NAME, v.licenseeContact, v["被許諾者連絡先"]]) {
    const line = String(x ?? "").trim();
    if (!line) continue;
    const parts = splitContact(line);
    if (parts.name) return parts.name;
  }
  return "";
}

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
                -- 受取人（共著の取り分）宛ての文書は、相手先を受取人にする（代表の連絡先に送らない）。
                COALESCE(pp.name, v.counterparty) AS counterparty, COALESCE(pp.id, v.counterparty_id) AS counterparty_id,
                t.template_key,
                COALESCE(v.template_label, d.manual_inputs->>'documentKind') AS template_label,
                NULLIF(d.manual_inputs->>'_ownerStaffId', '')::bigint AS manual_owner_staff_id,
                d.manual_inputs->>'_showRevision' AS show_revision,
                m.matter_no, m.title AS matter_title, m.owner_staff_id, m.requester_email, m.requester_slack_id
           FROM documents d
           LEFT JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN parties pp ON pp.id = CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                                THEN (d.manual_inputs->>'_payeePartyId')::bigint END
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
      // 当社担当者は 文書の画面で選んだ担当（manual_inputs._ownerStaffId）→ 案件の担当 →
      // デイリータスクの担当。文書で選び直したのにメールの cc と署名が元の担当のままだった。
      const ownerStaffId = doc.manual_owner_staff_id ? Number(doc.manual_owner_staff_id) : origin?.ownerStaffId ?? null;
      const owner = ownerStaffId
        ? (await this.database.query("SELECT name, email FROM staff WHERE id = $1", [ownerStaffId])).rows[0] as any
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

  /**
   * 何枚かの文書を 1 通で送る下書き。宛先・cc は 1 枚目の文書から（取引先の主担当や担当者）、
   * 文書番号・文書名・金額は全部を「・」でつなぐ。相手先の違う文書は混ぜられない。
   * 送付（delivery）の文面は、種類が揃っていればその種類、混ざれば「その他の書類」。
   */
  async draftMany(documentIds: number[], purpose: MailPurpose, options: { staffName?: string | null } = {}): Promise<MailDraft> {
    const ids = [...new Set(documentIds.map(Number))];
    if (!ids.length) throw new DomainError("VALIDATION", "文書を選んでください");
    return this.draft(ids[0]!, purpose, ids.slice(1), options);
  }

  /** options.staffName … 通知条項に担当者が無いとき、送る画面で入れた名前（{担当者名}）。 */
  async draft(documentId: number, purpose: MailPurpose, extraIds: number[] = [], options: { staffName?: string | null } = {}): Promise<MailDraft> {
    try {
      const { doc, origin, counterpartyName, owner, requester, contacts, partyEmail, counterpartyId } = await this.loadContext(documentId);
      // 2 枚目以降。相手先が違えば止める（A社への便りに B社の書類が付く）。
      const extras = extraIds.length ? (await this.database.query(
        `SELECT d.id, d.document_no, d.issued_at, d.rendered_values, d.manual_inputs->>'_showRevision' AS show_revision,
                t.template_key, COALESCE(v.template_label, d.manual_inputs->>'documentKind') AS template_label,
                COALESCE(pp.id, v.counterparty_id) AS counterparty_id, COALESCE(pp.name, v.counterparty) AS counterparty
           FROM documents d
           LEFT JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN parties pp ON pp.id = CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                                THEN (d.manual_inputs->>'_payeePartyId')::bigint END
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE d.id = ANY($1::bigint[])
          ORDER BY array_position($1::bigint[], d.id)`, [extraIds])).rows as Array<Record<string, any>> : [];
      if (extras.length !== extraIds.length) throw new DomainError("NOT_FOUND", "選んだ文書の一部が見つかりません");
      const mixed = extras.filter((e) => (e.counterparty_id ? Number(e.counterparty_id) : null) !== counterpartyId);
      if (mixed.length) {
        throw new DomainError("VALIDATION",
          `相手先の違う文書は 1 通にまとめられません（${[counterpartyName, ...mixed.map((e) => String(e.counterparty ?? "（相手先なし）"))].join("・")}）`);
      }
      const all = [doc, ...extras];

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
      // 足した文面は、その文面に書いてある相手（取引先／社内の担当者）。
      const custom = isCustomPurpose(purpose) ? resolveMailTemplate(templates, purpose, null) : null;
      if (isCustomPurpose(purpose) && !custom) throw new DomainError("NOT_FOUND", "その文面は設定にありません（運用 → 設定 → メールの文面）");
      const toOwner = purpose === "owner_check" || custom?.audience === "owner";
      if (toOwner) {
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

      // 送付の文面は文書の種類で選ぶ。混ざっていれば「その他の書類」。
      const kinds = custom ? [custom.kind]
        : [...new Set(all.map((d) => resolveMailTemplate(templates, purpose, str(d.template_key))!.kind))];
      const kind = kinds.length === 1 ? kinds[0]! : "general";
      const template = custom ? custom.template : templates.templates[kind as MailTemplateKind];
      // 紙と同じ番号（訂正版の枝番は出さず、改訂の印は選んだときだけ）。何枚かなら「・」でつなぐ。
      const numberOf = (d: Record<string, any>) => d.document_no
        ? printedDocumentNumber(String(d.document_no), showRevisionOf({ _showRevision: d.show_revision })) : "";
      const amounts = all.map((d) => amountOf((d.rendered_values ?? {}) as Record<string, unknown>));
      const latest = all.map((d) => dateStr(d.issued_at)).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
      // {対象期間}{支払予定日}：利用許諾計算書に載っている値（どの計算書でも同じ鍵で持つ）。
      // 支払期日が計算書に無ければ、その文書から立てた支払の期日。
      const periods = [...new Set(all.map(periodOf).filter(Boolean))];
      const payDates = [...new Set(all.map(payDateOf).filter(Boolean))];
      const pay = payDates.length ? null : (await this.database.query(
        `SELECT min(p.due_on) AS due_on FROM payments p
           JOIN payment_allocations a ON a.payment_id = p.id
           JOIN condition_events e ON e.id = a.event_id
          WHERE e.document_id = ANY($1::bigint[]) AND p.status <> 'canceled'`, [all.map((d) => Number(d.id))])).rows[0] as any;
      // {担当者名}：通知条項の当社担当者（基本契約書の乙 STAFF_NAME・条件書の被許諾者連絡先）。無ければ送る画面で入れた名前。
      const noticeName = all.map(noticeStaffOf).find(Boolean) ?? "";
      const inputName = String(options.staffName ?? "").trim();
      const staffName = noticeName || inputName;
      const staffNameFrom: MailDraft["staffNameFrom"] = noticeName ? "notice" : inputName ? "input" : null;
      const rendered = renderMail(template, templates.signature, {
        相手先: counterpartyName,
        担当者名: staffName,
        対象期間: periods.join("・"),
        支払予定日: payDates.length ? payDates.join("・") : pay?.due_on ? japaneseDate(dateStr(pay.due_on)) : "",
        宛名: to.length === 1 ? to[0].name ?? "" : "",
        文書番号: all.map(numberOf).filter(Boolean).join("・"),
        文書名: [...new Set(all.map((d) => str(d.template_label) ?? "書類"))].join("・"),
        案件番号: origin?.no ?? "",
        案件名: origin?.title ?? "",
        // 1 枚でも額が分からなければ空（取り違えを避ける）。
        金額: amounts.every(Boolean) ? amounts.join("・") : "",
        発行日: latest ? japaneseDate(latest) : "",
        会社名: company
      });
      if (!toOwner && !company) warnings.push("自社情報の会社名が空です（運用 → 設定 → 自社情報）");
      if (!staffName && /\{担当者名\}/.test(`${template.subject}\n${template.body}`)) {
        warnings.push("通知条項に当社担当者が無いので {担当者名} が空です。送る画面の「担当者名」に入れてください");
      }
      return { purpose, kind, staffName, staffNameFrom, to, cc, subject: rendered.subject, body: rendered.body, warnings };
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
