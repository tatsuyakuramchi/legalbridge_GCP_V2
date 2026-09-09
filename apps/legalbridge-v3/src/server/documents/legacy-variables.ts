/**
 * V1/V2 のひな形が使う変数名を、V3 の文脈へ自動で対応させる。
 *
 * V3 の binding は「ひな形が供給元（from）を宣言する」設計だが、V1 の
 * field_schema にその概念は無く、移行のしようがない。結果として26件すべて
 * 全項目が手入力になり、検収書1枚に8項目を打つことになっていた。
 *
 * V2 は同じ問題を、変数名から値を組み立てることで解いていた
 * （context-adapter.ts の buildCommonDocumentContext）。同じ名前に同じ値を
 * 入れれば、移行済みのひな形がそのまま動く。ここはその移植。
 *
 * 対応表に無い名前は、これまでどおり手入力（と候補からの選択）に回る。
 * 当てずっぽうで埋めない。書類は出したら直せないので、間違った値が黙って
 * 入るくらいなら空欄で止まるほうがよい。
 */

import { accountTypeLabel, bankInfoLine } from "./template-context.js";

type Ctx = Record<string, any>;

/** 個人なら「様」、法人なら「御中」。V1 の resolveHonorific と同じ規則。 */
const honorific = (kind: string | null | undefined) =>
  kind === "individual" ? "様" : "御中";

const yen = (v: unknown) =>
  typeof v === "number" ? String(Math.round(v)) : v === null || v === undefined ? "" : String(v);

/**
 * 変数名 → 値の取り出し。同じ意味の別名は V1/V2 の実データに合わせて並べる
 * （document-business-columns.ts の PARTY_NAME_KEYS / TITLE_KEYS ほか）。
 */
const RESOLVERS: Array<{ names: string[]; get: (c: Ctx) => unknown }> = [
  // ---- 文書そのもの ----
  { names: ["CONTRACT_NO", "DOC_NO", "ORDER_NO", "documentNumber", "文書番号", "契約書番号", "発注番号"],
    get: (c) => c.document?.number },
  { names: ["SIGN_DATE", "CONTRACT_DATE", "契約締結日"],
    get: (c) => c.agreement?.executedOn ?? c.document?.issuedOn },
  // 発行日・発注日はその書類を出した日。合意の締結日ではない。
  { names: ["documentDate", "発行日", "発注日", "order_date", "ORDER_DATE", "issue_date", "date"],
    get: (c) => c.document?.issuedOn },
  // 準拠する契約の番号。合意から引ける。
  { names: ["linked_contract_number", "MASTER_CONTRACT_REF", "契約番号", "基本契約番号",
            "parent_contract_number"],
    get: (c) => c.agreement?.no },
  { names: ["CONTRACT_TITLE_REF", "基本契約名"], get: (c) => c.agreement?.title },
  // 検収書の見出しの「発注番号」。同じ条件から出ている発注書を辿る。
  { names: ["parent_po_number", "PARENT_PO_NUMBER", "発注番号", "元発注番号"],
    get: (c) => relatedNo(c, "purchase_order") ?? relatedNo(c, "intl_purchase_order") },
  { names: ["issueKey", "BACKLOG_KEY", "課題キー"], get: (c) => c.backlogKey },

  // ---- 相手先（受注者・許諾者） ----
  { names: ["VENDOR_NAME", "LICENSOR_NAME", "Licensor_氏名会社名", "Licensor_名称",
            "許諾者", "相手先", "取引先", "counterparty", "licensor", "PARTY_A_NAME",
            "contractor_name", "受託者名"],
    get: (c) => c.condition?.counterparty?.name },
  { names: ["VENDOR_KANA", "取引先カナ", "LICENSOR_KANA"],
    get: (c) => c.condition?.counterparty?.kana },
  { names: ["VENDOR_SUFFIX", "LICENSOR_SUFFIX", "取引先敬称", "許諾者敬称"],
    get: (c) => honorific(c.condition?.counterparty?.kind) },
  // 本番の検収書は「法人」「個人」の2値で分岐する（COUNTERPARTY_IS_CORPORATION）。
  // こちらは3値ではなく2値なので、空文字ではなく「個人」を返す。
  { names: ["COUNTERPARTY_IS_CORPORATION", "受託者種別", "相手先種別"],
    get: (c) => (c.condition?.counterparty?.kind === "individual" ? "個人" : "法人") },
  { names: ["counterpartyRep", "受託者代表者名", "相手先代表者"],
    get: (c) => contact(c, "signer")?.name ?? contact(c, "primary")?.name },
  { names: ["VENDOR_IS_CORPORATION", "VENDOR_MASTER_ENTITY_TYPE", "取引先種別",
            "vendorEntityType", "LICENSOR_IS_CORPORATION"],
    // V2 と同じく、法人は "法人"・個人は空文字。テンプレートが
    // `eq VENDOR_IS_CORPORATION "法人"` と `or VENDOR_IS_CORPORATION ...` の
    // 両方で使うため、真偽値にすると片方が常に偽になる。
    get: (c) => (c.condition?.counterparty?.kind === "individual" ? "" : "法人") },
  { names: ["VENDOR_INVOICE_NO", "インボイス登録番号", "invoiceNo"],
    get: (c) => c.condition?.counterparty?.invoiceNo },
  { names: ["VENDOR_CORPORATE_NO", "法人番号"],
    get: (c) => c.condition?.counterparty?.corporateNo },
  { names: ["VENDOR_CONTACT_NAME", "先方担当者名"],
    get: (c) => contact(c, "primary")?.name },
  { names: ["VENDOR_CONTACT_EMAIL", "先方担当者メール"],
    get: (c) => contact(c, "primary")?.email },
  { names: ["VENDOR_SIGNER_NAME", "署名者名"],
    get: (c) => contact(c, "signer")?.name },
  { names: ["VENDOR_REP", "VENDOR_REPRESENTATIVE", "Licensor_代表者名", "代表者氏名",
            "許諾者代表者", "受託者代表者"],
    get: (c) => contact(c, "signer")?.name ?? contact(c, "primary")?.name },
  // V1 はこの欄に「様」まで含めて持っていた（本文は敬称を付けない）。
  { names: ["VENDOR_REPRESENTATIVE_SAMA", "代表者名様"],
    get: (c) => {
      const name = contact(c, "signer")?.name ?? contact(c, "primary")?.name;
      return name ? `${name} 様` : undefined;
    } },
  { names: ["VENDOR_ADDRESS", "Licensor_住所", "許諾者住所", "取引先住所", "相手先住所"],
    get: (c) => c.condition?.counterparty?.address },
  { names: ["VENDOR_EMAIL", "Licensor_メール", "担当者メール", "取引先メール"],
    get: (c) => contact(c, "primary")?.email ?? contact(c, "billing")?.email },
  { names: ["VENDOR_CONTACT_DEPARTMENT", "先方担当者部署", "担当者部署名"],
    get: (c) => contact(c, "primary")?.department },
  { names: ["VENDOR_CONTACT_PHONE", "Licensor_電話", "担当者電話番号", "取引先電話"],
    get: (c) => contact(c, "primary")?.phone ?? c.condition?.counterparty?.phone },
  { names: ["INVOICE_REGISTRATION_NUMBER", "invoiceRegistrationNumber", "counterpartyTni",
            "登録番号", "適格請求書発行事業者登録番号"],
    get: (c) => c.condition?.counterparty?.invoiceNo },
  { names: ["WITHHOLDING_TAX", "源泉徴収"],
    get: (c) => (c.condition?.counterparty?.withholding === true ? "対象"
      : c.condition?.counterparty?.withholding === false ? "対象外" : undefined) },

  // ---- 振込先 ----
  // 名前は V1 の form-mapper.ts（vendor エイリアス表）と揃える。ここが
  // 欠けていたせいで、検収書の振込先に口座番号と名義しか出ていなかった。
  { names: ["BANK_INFO", "振込先", "bank_line", "bankInfo", "振込先口座", "お振込先"],
    get: (c) => bankLine(c) },
  { names: ["BANK_NAME", "bank_name", "bankName", "振込先銀行", "振込先銀行名", "銀行名",
            "金融機関名", "金融機関"],
    get: (c) => c.bank?.bankName },
  { names: ["BRANCH_NAME", "BANK_BRANCH", "branch_name", "branchName",
            "振込先支店", "支店名", "支店"],
    get: (c) => c.bank?.branchName },
  { names: ["ACCOUNT_TYPE", "account_type", "accountType", "口座種別", "預金種別", "種別"],
    get: (c) => accountTypeLabel(c.bank?.accountType) },
  { names: ["ACCOUNT_NUMBER", "BANK_ACCOUNT_NO", "account_number", "accountNo", "accountNumber",
            "口座番号"],
    get: (c) => c.bank?.accountNumber },
  { names: ["ACCOUNT_HOLDER_KANA", "ACCOUNT_HOLDER", "BANK_ACCOUNT_HOLDER",
            "account_holder_kana", "accountHolder", "accountHolderKana",
            "口座名義", "口座名義カナ", "口座名義人"],
    get: (c) => c.bank?.holderKana },

  // ---- 自社の担当者 ----
  { names: ["STAFF_NAME", "担当者名", "申請者名", "requester", "inspector_name", "検収者氏名"],
    get: (c) => c.owner?.name },
  { names: ["STAFF_DEPARTMENT", "担当者部署", "申請部署", "inspector_dept", "検収者部署"],
    get: (c) => c.owner?.department },
  { names: ["STAFF_EMAIL", "inspectorEmail", "申請者メール", "検収者メールアドレス"],
    get: (c) => c.owner?.email },
  { names: ["STAFF_PHONE", "担当者電話"], get: (c) => c.owner?.phone },
  { names: ["監修者", "inspectorName"], get: (c) => c.owner?.name },
  { names: ["inspectorDept"], get: (c) => c.owner?.department },

  // ---- 自社 ----
  { names: ["COMPANY_NAME", "PARTY_A_NAME", "Licensee_名称", "Licensee_氏名会社名",
            "licensee", "自社名", "payerCompany"],
    get: (c) => c.company?.name },
  { names: ["COMPANY_ADDRESS", "PARTY_A_ADDRESS", "Licensee_住所",
            "アークライト住所", "自社住所"],
    get: (c) => c.company?.address },
  { names: ["COMPANY_REP", "COMPANY_REPRESENTATIVE", "PARTY_A_REP", "Licensee_代表者名",
            "アークライト代表者氏名", "代表者名"],
    get: (c) => c.company?.rep ?? c.company?.representative },
  { names: ["COMPANY_INVOICE_NO", "自社インボイス番号"],
    get: (c) => c.company?.invoiceNo },
  { names: ["COMPANY_TEL", "自社電話"], get: (c) => c.company?.tel },
  { names: ["COMPANY_POSTAL_CODE", "自社郵便番号"], get: (c) => c.company?.postalCode },
  // 自社プロファイルは10項目あるのに、別名を用意していたのは6項目だけだった。
  // 残りは設定に入れても書類に出ない（入れた側からは入ったように見える）。
  { names: ["COMPANY_NAME_KANA", "自社名カナ", "自社カナ"], get: (c) => c.company?.nameKana },
  { names: ["COMPANY_FAX", "自社FAX"], get: (c) => c.company?.fax },
  // 相手先の口座（BANK_NAME 系）とは別物。こちらは自社の入金先。
  { names: ["COMPANY_BANK_INFO", "自社振込先", "入金先"], get: (c) => c.company?.bankInfo },
  { names: ["COMPANY_SEAL_NOTE", "捺印備考"], get: (c) => c.company?.sealNote },

  // ---- 件名・案件 ----
  { names: ["PROJECT_TITLE", "CONTRACT_TITLE", "基本契約名", "件名", "title",
            "contractTitle", "projectTitle", "deliverable", "成果物"],
    get: (c) => c.matter?.title ?? c.condition?.name },
  { names: ["WORK_TITLE", "作品名", "原著作物名", "originalWork",
            "対象作品予定名", "対象製品予定名"],
    get: (c) => c.condition?.work?.title },
  { names: ["productName", "製品名", "商品名"],
    get: (c) => c.condition?.work?.title ?? c.condition?.name },
  { names: ["currency", "通貨"], get: (c) => c.condition?.currency },
  { names: ["WORK_ID", "work_id", "台帳ID", "作品コード"],
    get: (c) => c.condition?.work?.code },

  // ---- 期間・支払条件 ----
  { names: ["TERM_START", "契約開始日", "開始日"], get: (c) => c.condition?.termStart },
  { names: ["TERM_END", "契約終了日", "終了日"], get: (c) => c.condition?.termEnd },
  { names: ["PAYMENT_TERMS", "paymentConditionSummary", "支払条件"],
    get: (c) => c.condition?.paymentTerms },

  // ---- 金額 ----
  { names: ["AMOUNT_EX_TAX", "税抜金額", "itemsSubtotalExTax", "amount_ex_tax", "納品額"],
    get: (c) => yen(c.event?.amount ?? c.totals?.exTax) },
  { names: ["TAX_AMOUNT", "消費税", "taxAmount"], get: (c) => yen(c.totals?.tax) },
  { names: ["AMOUNT_INC_TAX", "税込金額"], get: (c) => yen(c.totals?.incTax) },

  // ---- 実績（検収書・納品書） ----
  { names: ["DELIVERY_DATE", "deliveredAt", "実納品日", "納品日", "delivered_on",
            "summaryDeliveryDate"],
    get: (c) => c.event?.occurredOn },
  { names: ["INSPECTION_DATE", "inspectionCompletedAt", "completionDate",
            "検収完了日", "検収日", "inspected_on", "完成日"],
    get: (c) => c.event?.occurredOn },
  { names: ["PAYMENT_DATE", "paymentDueDate", "支払期日", "summaryPaymentDate"],
    get: (c) => c.schedule?.payOn },
  { names: ["PERIOD", "対象期間", "対象月"], get: (c) => c.event?.period },

  // ---- 計算書 ----
  { names: ["grossRoyalty", "grossRoyaltyStr", "グロス"], get: (c) => yen(c.royalty?.grossExTax) },
  { names: ["actualRoyalty", "actualRoyaltyStr", "税抜実額"], get: (c) => yen(c.royalty?.netExTax) },
  { names: ["agConsumedThisTime", "agConsumedThisTimeStr", "AG相殺"],
    get: (c) => yen(c.royalty?.agOffset) },
  { names: ["agConsumedBeforeStr", "消化済みAG"], get: (c) => yen(c.royalty?.agConsumedBefore) },
  { names: ["agRemainingStr", "AG残"], get: (c) => yen(c.royalty?.agRemaining) },
  { names: ["mgTopupThisTimeStr", "MG上乗せ"], get: (c) => yen(c.royalty?.mgTopup) },
  { names: ["totalPaymentStr", "差引振込額"], get: (c) => yen(c.royalty?.netTransfer) },
  { names: ["withholdingTax", "源泉税"], get: (c) => yen(c.royalty?.withholdingTax) },
  { names: ["fxRate", "為替レート"], get: (c) => c.royalty?.fxRate },
  { names: ["linesTotalSalesStr", "報告売上"], get: (c) => yen(c.royalty?.salesInput) }
];

/** 同じ条件から出ている、その種別のいちばん新しい書類の番号。 */
const relatedNo = (c: Ctx, templateKey: string): string | undefined =>
  ((c.related ?? []) as Array<Record<string, any>>)
    .find((d) => d.templateKey === templateKey)?.documentNo ?? undefined;

const contact = (c: Ctx, role: string) =>
  ((c.contacts ?? []) as Array<Record<string, any>>).find((x) => x.role === role) ?? null;

function bankLine(c: Ctx): string | null {
  return bankInfoLine(c.bank) || null;
}

const take = (entry: { names: string[]; get: (c: Ctx) => unknown }, context: Ctx): unknown => {
  const value = entry.get(context);
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") {
    // 空文字を意図して返すもの（VENDOR_IS_CORPORATION の個人）だけは通す。
    return entry.names.includes("VENDOR_IS_CORPORATION") ? value : undefined;
  }
  return value;
};

/**
 * 括弧の中と記号を落とす。「納品額 (税抜)」と「納品額」を同じものとして扱う。
 * 大文字小文字も無視する。本番のひな形は同じ意味の項目を BANK_NAME と bankName の
 * 両方の書き方で持っているため（検収書は camelCase、発注書は大文字）。
 */
const normalize = (v: string) =>
  v.replace(/[（(].*?[）)]/g, "").replace(/[\s　・:：/／-]/g, "").trim().toLowerCase();

/**
 * 変数名から値を引く。名前でもラベルでも引ける。
 *
 * まず完全一致。次に、正規化したうえでの部分一致を長い名前から試す
 * （「検収書発行日」は「発行日」、「成果物・業務内容」は「成果物」）。
 * 短い名前での部分一致は誤爆するので、3文字以上のものだけを使う。
 *
 * どれにも当たらなければ undefined。当てずっぽうでは埋めない。
 */
export function resolveLegacyVariable(name: string, context: Ctx, label?: string): unknown {
  const keys = [String(name ?? "").trim(), String(label ?? "").trim()].filter(Boolean);
  if (!keys.length) return undefined;

  for (const key of keys) {
    for (const entry of RESOLVERS) {
      if (entry.names.includes(key)) return take(entry, context);
    }
  }

  // 部分一致。長い名前を先に見る（「実納品日」より「納品日」が先に当たると困る）。
  const matches: Array<{ length: number; entry: typeof RESOLVERS[number] }> = [];
  for (const key of keys) {
    const flat = normalize(key);
    if (flat.length < 2) continue;
    for (const entry of RESOLVERS) {
      for (const candidate of entry.names) {
        const target = normalize(candidate);
        if (target.length < 3) continue;
        if (flat === target || flat.includes(target)) {
          matches.push({ length: target.length, entry });
        }
      }
    }
  }
  matches.sort((a, b) => b.length - a.length);
  for (const m of matches) {
    const value = take(m.entry, context);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 対応表が扱う変数名の総数。画面の説明に使う。 */
export const LEGACY_VARIABLE_COUNT = RESOLVERS.reduce((n, r) => n + r.names.length, 0);

/**
 * V1 の field_schema が持っていた dbField（"vendor.bank_name" のような宣言）を
 * V3 の文脈から引く。
 *
 * 移行で field_schema はそのまま variables に移っているので、この宣言は
 * 本番のひな形に残っている。読む側が無かっただけ。名前の対応表より確かな
 * 情報なので、こちらを先に見る。名前空間は V1 の FormContextSources と同じ。
 */
const DB_FIELD_SOURCES: Record<string, (c: Ctx) => Record<string, unknown>> = {
  vendor: (c) => {
    const party = c.condition?.counterparty ?? {};
    const primary = contact(c, "primary") ?? {};
    const signer = contact(c, "signer") ?? {};
    const bank = c.bank ?? {};
    return {
      vendor_name: party.name,
      name: party.name,
      name_kana: party.kana,
      address: party.address,
      phone: party.phone ?? primary.phone,
      email: party.email ?? primary.email,
      vendor_rep: signer.name ?? primary.name,
      contact_name: primary.name,
      contact_department: primary.department,
      contact_email: primary.email,
      invoice_registration_number: party.invoiceNo,
      corporate_number: party.corporateNo,
      withholding_enabled: party.withholding,
      bank_name: bank.bankName,
      branch_name: bank.branchName,
      account_type: accountTypeLabel(bank.accountType),
      account_number: bank.accountNumber,
      account_holder_kana: bank.holderKana
    };
  },
  staff: (c) => ({
    staff_name: c.owner?.name,
    name: c.owner?.name,
    department: c.owner?.department,
    email: c.owner?.email,
    phone: c.owner?.phone
  }),
  // キーは V1 の companyProfile() が返していた snake_case に合わせる。
  company: (c) => ({
    name: c.company?.name,
    name_kana: c.company?.nameKana,
    address: c.company?.address,
    rep: c.company?.rep ?? c.company?.representative,
    invoice_no: c.company?.invoiceNo,
    tel: c.company?.tel,
    fax: c.company?.fax,
    postal_code: c.company?.postalCode,
    bank_info: c.company?.bankInfo,
    seal_note: c.company?.sealNote
  }),
  matter: (c) => ({
    matter_code: c.matter?.matterNo ?? c.matter?.code,
    title: c.matter?.title,
    target_due_date: c.matter?.dueOn,
    remarks: c.matter?.remarks,
    counterparty: c.condition?.counterparty?.name
  }),
  document: (c) => ({
    document_number: c.document?.number,
    issued_on: c.document?.issuedOn
  }),
  work: (c) => ({
    code: c.condition?.work?.code,
    title: c.condition?.work?.title
  }),
  // V1 の auto.*（採番・今日の日付）。宣言されているのに読む側が無かったので、
  // 発注番号と発行日が空欄のままだった。
  auto: (c) => ({
    docNumber: c.document?.number,
    today: c.document?.issuedOn
  }),
  // V1 は Backlog の課題から引いていた。V3 では案件が同じ位置にある。
  backlog: (c) => ({
    summary: c.matter?.title,
    details: c.matter?.remarks,
    deadline: c.matter?.dueOn,
    counterparty: c.condition?.counterparty?.name
  })
};

export function resolveLegacyDbField(path: string, context: Ctx): unknown {
  const [namespace, key] = String(path ?? "").split(".", 2);
  if (!namespace || !key) return undefined;
  const source = DB_FIELD_SOURCES[namespace];
  if (!source) return undefined;
  const value = source(context)[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

/**
 * 対応表が解決できる値をまとめて返す。
 *
 * V1 のテンプレート文脈は「分かるものは全部入っている袋」で、field_schema は
 * 画面の入力欄を決めるだけだった。本文はそれに頼っていて、宣言の無い名前
 * （DOC_NO・STAFF_NAME・moneyUnit …）を平気で差す。V3 は宣言のある変数しか
 * 束縛していなかったので、宣言の無い差し込みが軒並み空欄になっていた。
 *
 * ここが返すのは既定値。宣言のある変数（手入力を含む）と計算結果が上に乗る。
 */
export function resolveAllLegacyVariables(context: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of RESOLVERS) {
    const value = take(entry, context);
    if (value === undefined) continue;
    for (const name of entry.names) {
      if (!(name in out)) out[name] = value;
    }
  }
  return out;
}
