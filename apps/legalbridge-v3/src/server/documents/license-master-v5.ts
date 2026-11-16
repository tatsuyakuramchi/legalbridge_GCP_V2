import type { TemplateVariable } from "./binding.js";

/**
 * 著作物利用許諾基本契約書V5（license_master_v5）。出版・ボードゲーム共通の基本契約。
 *
 * 本文は infra/v3/templates/license_master_v5.html（登録は infra/v3/212）。条文は固定で、
 * 差し込むのは当事者・締結日・支払先・税務・通知先・署名欄だけ。事業別条項は基本契約に置かず、
 * 個別利用許諾条件書V5（出版：pub_license_terms_v5/_annex、ボードゲーム：individual_license_terms_v5）に置く。
 *
 * 項目はコードが持つ（V1 から移した license_master の field_schema は使わない）。
 * 甲＝許諾者＝相手先、乙＝被許諾者＝当社（IN の基本契約）。
 */
export const LICENSE_MASTER_V5_KEY = "license_master_v5";
export const isLicenseMasterV5Template = (templateKey: string): boolean => templateKey === LICENSE_MASTER_V5_KEY;
/** 基本契約V5 として作るときの契約の名前（agreements.title）。 */
export const LICENSE_MASTER_V5_TITLE = "著作物利用許諾基本契約書";

type Data = Record<string, any>;

export const LICENSE_MASTER_V5_VARIABLES: TemplateVariable[] = [
  { name: "書類番号", label: "書類番号", group: "I. 基本情報", dbField: "auto.docNumber", noGuess: true },
  { name: "締結日", label: "締結日", type: "date", group: "I. 基本情報", required: true,
    dbField: "auto.today", noGuess: true },
  { name: "署名欄", label: "署名欄", type: "select", options: ["署名", "押印"], group: "I. 基本情報",
    noGuess: true, default: "署名", helpText: "署名＝電子署名の枠、押印＝印の枠" },

  { name: "許諾者名称", label: "許諾者（甲）名称", group: "II. 許諾者（甲）", required: true,
    from: "condition.counterparty.name", helpText: "個人で筆名があれば「氏名（筆名：◯◯）」の形にする" },
  { name: "許諾者住所", label: "許諾者（甲）住所", type: "textarea", group: "II. 許諾者（甲）", required: true,
    from: "condition.counterparty.address" },
  { name: "許諾者代表者名", label: "許諾者（甲）代表者名", group: "II. 許諾者（甲）",
    dbField: "vendor.vendor_rep_line", noGuess: true,
    helpText: "法人の代表者の肩書と氏名（代表取締役 ◯◯）。個人の許諾者は空のままでよい（署名欄は「個人のため省略」）" },
  { name: "許諾者登録番号", label: "許諾者（甲）登録番号（T番号）", group: "II. 許諾者（甲）",
    from: "condition.counterparty.invoiceNo", helpText: "適格請求書発行事業者でなければ空のまま（基本条件の税務に「未登録」と出る）" },
  { name: "許諾者連絡先", label: "許諾者（甲）通知先", type: "contact", group: "II. 許諾者（甲）",
    dbField: "vendor.contact_line", noGuess: true,
    helpText: "取引先の主担当（個人は本人）が入ります。違う人にするなら上書きする" },

  { name: "被許諾者名称", label: "被許諾者（乙）名称", group: "III. 被許諾者（乙）", required: true, from: "company.name" },
  { name: "被許諾者住所", label: "被許諾者（乙）住所", type: "textarea", group: "III. 被許諾者（乙）", from: "company.address" },
  { name: "被許諾者代表者名", label: "被許諾者（乙）代表者名", group: "III. 被許諾者（乙）", from: "company.rep" },
  { name: "被許諾者連絡先", label: "被許諾者（乙）通知先", type: "contact", group: "III. 被許諾者（乙）",
    dbField: "staff.contact_line", noGuess: true,
    helpText: "文書の担当者（部署・氏名・メール・電話）が入ります。違う人にするなら上書きする" }
];

const text = (v: unknown): string => (v == null ? "" : String(v).trim());
const joinContact = (parts: unknown[]) => parts.map((v) => text(v)).filter(Boolean).join(" ／ ");

/**
 * 本文に渡す値。項目（bound）→ 手入力（manual）→ 文脈 の順で見る（pubTermsPatch と同じ規則）。
 * 支払先の 1 行（BANK_INFO）は共通の値（template-context の common）から来る。
 */
export function licenseMasterV5Patch(context: Data, manual: Data = {}): Data {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = manual[key] ?? context[key];
      if (value != null && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };
  const counterparty = context.condition?.counterparty ?? {};
  const isCorp = text(counterparty.kind) !== "individual";
  const contacts = Array.isArray(context.contacts) ? context.contacts : [];
  const primary = contacts.find((c: Data) => c?.role === "primary") ?? {};
  const company = context.company ?? {};
  const owner = context.owner ?? {};
  const representative = [text(counterparty.representativeTitle), text(counterparty.representativeName)].filter(Boolean).join(" ");
  return {
    docNo: pick("書類番号") || text(context.document?.number),
    signDate: pick("締結日") || text(context.document?.issuedOn),
    署名欄: pick("署名欄") || "署名",

    licensorName: pick("許諾者名称") || text(counterparty.name),
    licensorAddress: pick("許諾者住所") || text(counterparty.address),
    licensorRep: isCorp ? (pick("許諾者代表者名") || representative) : "",
    licensorIsCorp: isCorp,
    licensorInvoiceNo: pick("許諾者登録番号") || text(counterparty.invoiceNo),
    /** 源泉徴収。取引先の設定（個人はふつう対象）。 */
    withholding: counterparty.withholding === true,
    // 主担当 → （個人は）本人の連絡先。
    licensorContact: pick("許諾者連絡先")
      || joinContact([primary.department, primary.name, primary.email, primary.phone])
      || (isCorp ? "" : joinContact([counterparty.name, counterparty.email, counterparty.phone])),

    licenseeName: pick("被許諾者名称") || text(company.name),
    licenseeAddress: pick("被許諾者住所") || text(company.address),
    licenseeRep: pick("被許諾者代表者名") || text(company.rep ?? company.representative),
    // 乙（当社）の通知先：欄 → 文書の担当者 → 自社の設定。
    licenseeContact: pick("被許諾者連絡先")
      || joinContact([owner.department, owner.name, owner.email, owner.phone])
      || joinContact([company.department ?? company.contactDepartment, company.contactName ?? company.contact,
                      company.email ?? company.contactEmail, company.tel ?? company.phone]),

    hasBank: Boolean(context.bank)
  };
}
