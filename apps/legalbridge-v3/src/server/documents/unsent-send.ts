import type { Queryable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { DomainError } from "../core/errors.js";
import { noticeStaffOf, payDateOf, periodOf } from "./mail-draft.js";
import { MAIL_TEMPLATES_KEY, deliveryKindOf, readMailTemplates, renderMail, isCustomPurpose, resolveMailTemplate, type MailTemplateKind } from "../ops/mail-templates.js";
import { amountOf } from "./mail-draft.js";
import { printedDocumentNumber, showRevisionOf } from "./numbering.js";
import { UnsentBundlesService, type UnsentBundle, type UnsentKind } from "./unsent-bundles.js";

/**
 * 未送付の文書を、選んだ相手先へ相手先ごとに 1 通でまとめて送るための下書き（取引先へ）。
 *
 * 1 相手先ずつ「メールで 1 通」を開いて送っていたのを、何十相手先でも一度に流せるようにする
 * （再作成した利用許諾計算書を、受取人ごとにまとめて送り直す、など）。
 *
 *   - 相手先と文書は「未送付の文書」と同じ（共著の取り分の計算書は受取人）。種類で絞れる
 *   - 宛先は相手先の請求先 → 主担当 → 連絡先の全員 → 相手先のメール（文書の「送付」と同じ順）
 *   - Cc は設定の「取引先へのメールにいつも入れる cc」
 *   - 件名・本文は設定の「メールの文面」。計算書だけなら利用許諾計算書の送付、検収書だけなら
 *     検収書の送付、混ざれば「その他の書類の送付」。文書番号・金額は文書ごとに「・」でつなぐ
 *   - 1 通に添付するのは 20 枚まで。超える相手先は分けて送る
 *
 * 文面（purpose）:
 *   - delivery（既定）… 上の送付の文面。送ったら「送付済み」（gmail.send）になり一覧から消える
 *   - contract_unify … 「契約書の統一（書面化）のご案内」。契約書案を添付して内容確認をお願いする。
 *     宛先は主担当 → 連絡先の全員 → 相手先のメール（文書の「取引先への内容確認」と同じ順）。
 *     送っても「送付」にはしない（gmail.party_check）。返信をもらったら、同じ一覧から CloudSign で送る
 *
 * 下書きを返すだけで送らない。送るのは routes（/documents/unsent-bundles/send）。
 */

export type UnsentMailPurpose = "delivery" | "contract_unify" | `custom:${string}`;

export const PER_MAIL = 20;

export interface PartyMail {
  partyId: number;
  partyName: string;
  docs: Array<{ id: number; documentNo: string | null; kind: UnsentKind }>;
  to: Array<{ name: string | null; email: string }>;
  cc: Array<{ name: string | null; email: string }>;
  subject: string;
  body: string;
  /** 1 通に分けた数（20 枚ごと）。 */
  mails: number;
  /** 送る前に人が見ること（宛先が無い、など）。宛先が無ければ送れない。 */
  warnings: string[];
}

type Person = { name: string | null; email: string };

export class UnsentSendPlanner {
  constructor(private readonly database: Queryable) {}

  async plan(partyIds: number[], kinds: UnsentKind[], purpose: UnsentMailPurpose = "delivery", staffName: string | null = null): Promise<PartyMail[]> {
    try {
      const { bundles } = await new UnsentBundlesService(this.database).list();
      const wanted = new Set(partyIds.map(Number));
      const picked = bundles
        .filter((b) => wanted.has(b.partyId))
        .map((b) => ({ ...b, docs: b.docs.filter((d) => kinds.includes(d.kind)) }))
        .filter((b) => b.docs.length);
      if (!picked.length) return [];

      const settings = await this.database.query(
        "SELECT key, value FROM settings WHERE key = ANY($1::text[])", [[MAIL_TEMPLATES_KEY, "company_profile"]]);
      const setting = (key: string) =>
        (settings.rows as Array<{ key: string; value: unknown }>).find((r) => r.key === key)?.value;
      const templates = readMailTemplates(setting(MAIL_TEMPLATES_KEY));
      const company = String((setting("company_profile") as Record<string, unknown> | undefined)?.name ?? "").trim();

      const ids = picked.flatMap((b) => b.docs.map((d) => d.id));
      const docRows = (await this.database.query(
        `SELECT d.id, d.document_no, d.issued_at, d.rendered_values, d.manual_inputs ->> '_showRevision' AS show_revision,
                t.template_key, COALESCE(t.label, d.manual_inputs ->> 'documentKind') AS template_label
           FROM documents d
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE d.id = ANY($1::bigint[])`, [ids])).rows as Array<Record<string, any>>;
      const docOf = new Map(docRows.map((r) => [Number(r.id), r]));

      const partyRows = (await this.database.query(
        `SELECT p.id, p.email,
                COALESCE((SELECT json_agg(json_build_object('name', c.name, 'email', c.email, 'roles', c.roles) ORDER BY c.id)
                            FROM party_contacts c
                           WHERE c.party_id = p.id AND NULLIF(btrim(c.email), '') IS NOT NULL), '[]'::json) AS contacts
           FROM parties p WHERE p.id = ANY($1::bigint[])`, [picked.map((b) => b.partyId)])).rows as Array<Record<string, any>>;
      const partyOf = new Map(partyRows.map((r) => [Number(r.id), r]));

      return picked.map((b) => this.mailOf(b, docOf, partyOf.get(b.partyId), templates, company, purpose, staffName));
    } catch (error) { throw translate(error); }
  }

  private mailOf(
    b: UnsentBundle, docOf: Map<number, Record<string, any>>, party: Record<string, any> | undefined,
    templates: ReturnType<typeof readMailTemplates>, company: string, purpose: UnsentMailPurpose, staffName: string | null = null
  ): PartyMail {
    const warnings: string[] = [];
    const contacts = (Array.isArray(party?.contacts) ? party!.contacts : []) as Array<{ name: string | null; email: string; roles: unknown }>;
    const withRole = (role: string) => contacts
      .filter((c) => Array.isArray(c.roles) && (c.roles as unknown[]).map(String).includes(role))
      .map((c) => ({ name: str(c.name), email: String(c.email).trim() }));
    // 送付は請求先から、内容確認（契約書の統一）は主担当から。
    // 足した文面（custom:<key>）は取引先の主担当へ（社内向けの文面はまとめて送る対象にしない）。
    const custom = isCustomPurpose(purpose) ? resolveMailTemplate(templates, purpose, null) : null;
    if (isCustomPurpose(purpose) && !custom) throw new DomainError("NOT_FOUND", "その文面は設定にありません（運用 → 設定 → メールの文面）");
    let to: Person[] = purpose !== "delivery" ? withRole("primary") : withRole("billing");
    if (!to.length && purpose === "delivery") to = withRole("primary");
    if (!to.length) to = contacts.map((c) => ({ name: str(c.name), email: String(c.email).trim() }));
    if (!to.length && str(party?.email)) to = [{ name: null, email: String(party!.email).trim() }];
    to = to.filter((p, i, all) => all.findIndex((x) => x.email.toLowerCase() === p.email.toLowerCase()) === i);
    if (!to.length) warnings.push("メールアドレスの登録がありません（取引先の連絡先に入れてください）。送りません");
    const cc = templates.partyCc.map((email) => ({ name: null, email }))
      .filter((c) => !to.some((t) => t.email.toLowerCase() === c.email.toLowerCase()));
    if (!company) warnings.push("自社情報の会社名が空です（運用 → 設定 → 自社情報）");

    const rows = b.docs.map((d) => docOf.get(d.id)).filter((r): r is Record<string, any> => Boolean(r));
    const kinds = [...new Set(rows.map((r) => deliveryKindOf(str(r.template_key))))];
    const kind: MailTemplateKind = purpose === "contract_unify" ? "contract_unify"
      : kinds.length === 1 ? kinds[0]! : "general";
    const template = custom ? custom.template : templates.templates[kind];
    const numberOf = (r: Record<string, any>) => r.document_no
      ? printedDocumentNumber(String(r.document_no), showRevisionOf({ _showRevision: r.show_revision })) : `#${r.id}`;
    const amounts = rows.map((r) => amountOf((r.rendered_values ?? {}) as Record<string, unknown>));
    const labels = [...new Set(rows.map((r) => str(r.template_label) ?? "書類"))];
    const latest = rows.map((r) => dateStr(r.issued_at)).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
    const noticeName = rows.map(noticeStaffOf).find(Boolean) ?? "";
    const name = noticeName || String(staffName ?? "").trim();
    if (!name && /\{担当者名\}/.test(`${template.subject}\n${template.body}`)) {
      warnings.push("通知条項に当社担当者が無いので {担当者名} が空です。「担当者名」に入れてください");
    }
    const rendered = renderMail(template, templates.signature, {
      相手先: b.partyName,
      担当者名: name, 対象期間: [...new Set(rows.map(periodOf).filter(Boolean))].join("・"),
      支払予定日: [...new Set(rows.map(payDateOf).filter(Boolean))].join("・"),
      宛名: to.length === 1 ? to[0]!.name ?? "" : "",
      文書番号: rows.map(numberOf).join("・"),
      文書名: labels.join("・"),
      案件番号: "", 案件名: "",
      // 文書ごとの額を文書番号と同じ順に。1 枚でも額が分からなければ空（取り違えを避ける）。
      金額: amounts.every(Boolean) ? amounts.join("・") : "",
      発行日: latest ? japaneseDate(latest) : "",
      会社名: company
    });
    return {
      partyId: b.partyId, partyName: b.partyName,
      docs: b.docs.map((d) => ({ id: d.id, documentNo: d.documentNo, kind: d.kind })),
      to, cc, subject: rendered.subject, body: rendered.body,
      mails: Math.ceil(b.docs.length / PER_MAIL), warnings
    };
  }
}

function japaneseDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return y ? `${y}年${m}月${d}日` : "";
}
