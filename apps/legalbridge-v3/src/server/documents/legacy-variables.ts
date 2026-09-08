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
  { names: ["SIGN_DATE", "CONTRACT_DATE", "発行日", "契約締結日", "date", "order_date", "issue_date"],
    get: (c) => c.agreement?.executedOn ?? c.document?.issuedOn },

  // ---- 相手先（受注者・許諾者） ----
  { names: ["VENDOR_NAME", "LICENSOR_NAME", "Licensor_氏名会社名", "Licensor_名称",
            "許諾者", "相手先", "取引先", "counterparty", "licensor", "PARTY_A_NAME",
            "contractor_name", "受託者名"],
    get: (c) => c.condition?.counterparty?.name },
  { names: ["VENDOR_KANA", "取引先カナ", "LICENSOR_KANA"],
    get: (c) => c.condition?.counterparty?.kana },
  { names: ["VENDOR_SUFFIX", "LICENSOR_SUFFIX", "取引先敬称", "許諾者敬称"],
    get: (c) => honorific(c.condition?.counterparty?.kind) },
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
  { names: ["VENDOR_SIGNER_NAME", "署名者名", "VENDOR_REP", "VENDOR_REPRESENTATIVE"],
    get: (c) => contact(c, "signer")?.name },

  // ---- 振込先 ----
  { names: ["BANK_INFO", "振込先", "bank_line", "bankInfo"],
    get: (c) => bankLine(c) },
  { names: ["BANK_NAME", "振込先銀行"], get: (c) => c.bank?.bankName },
  { names: ["BANK_BRANCH", "振込先支店"], get: (c) => c.bank?.branchName },
  { names: ["BANK_ACCOUNT_NO", "口座番号"], get: (c) => c.bank?.accountNumber },
  { names: ["BANK_ACCOUNT_HOLDER", "口座名義"], get: (c) => c.bank?.holderKana },

  // ---- 自社の担当者 ----
  { names: ["STAFF_NAME", "担当者名", "申請者名", "requester", "inspector_name", "検収者氏名"],
    get: (c) => c.owner?.name },
  { names: ["STAFF_DEPARTMENT", "担当者部署", "申請部署", "inspector_dept", "検収者部署"],
    get: (c) => c.owner?.department },
  { names: ["STAFF_EMAIL", "担当者メール", "申請者メール"], get: (c) => c.owner?.email },

  // ---- 自社 ----
  { names: ["COMPANY_NAME", "自社名", "payerCompany"], get: (c) => c.company?.name },
  { names: ["COMPANY_ADDRESS", "自社住所"], get: (c) => c.company?.address },
  { names: ["COMPANY_REP", "代表者名"], get: (c) => c.company?.representative },
  { names: ["COMPANY_INVOICE_NO", "自社インボイス番号"], get: (c) => c.company?.invoiceNo },

  // ---- 件名・案件 ----
  { names: ["PROJECT_TITLE", "CONTRACT_TITLE", "基本契約名", "件名", "title",
            "contractTitle", "projectTitle", "deliverable", "成果物"],
    get: (c) => c.matter?.title ?? c.condition?.name },
  { names: ["WORK_TITLE", "作品名"], get: (c) => c.condition?.work?.title },

  // ---- 期間・支払条件 ----
  { names: ["TERM_START", "契約開始日", "開始日"], get: (c) => c.condition?.termStart },
  { names: ["TERM_END", "契約終了日", "終了日"], get: (c) => c.condition?.termEnd },
  { names: ["PAYMENT_TERMS", "支払条件"], get: (c) => c.condition?.paymentTerms },

  // ---- 金額 ----
  { names: ["AMOUNT_EX_TAX", "税抜金額", "itemsSubtotalExTax", "amount_ex_tax", "納品額"],
    get: (c) => yen(c.event?.amount ?? c.totals?.exTax) },
  { names: ["TAX_AMOUNT", "消費税", "taxAmount"], get: (c) => yen(c.totals?.tax) },
  { names: ["AMOUNT_INC_TAX", "税込金額"], get: (c) => yen(c.totals?.incTax) },

  // ---- 実績（検収書・納品書） ----
  { names: ["DELIVERY_DATE", "実納品日", "納品日", "delivered_on", "summaryDeliveryDate"],
    get: (c) => c.event?.occurredOn },
  { names: ["INSPECTION_DATE", "検収完了日", "検収日", "inspected_on"],
    get: (c) => c.event?.occurredOn },
  { names: ["PAYMENT_DATE", "支払期日", "summaryPaymentDate"],
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

const contact = (c: Ctx, role: string) =>
  ((c.contacts ?? []) as Array<Record<string, any>>).find((x) => x.role === role) ?? null;

function bankLine(c: Ctx): string | null {
  const b = c.bank;
  if (!b) return null;
  const type = ({ ordinary: "普通", checking: "当座", savings: "貯蓄",
                  futsu: "普通", touza: "当座" } as Record<string, string>)[b.accountType]
    ?? b.accountType;
  const line = [b.bankName, b.branchName, type, b.accountNumber, b.holderKana]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "").join(" ");
  return line || null;
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

/** 括弧の中と記号を落とす。「納品額 (税抜)」と「納品額」を同じものとして扱う。 */
const normalize = (v: string) =>
  v.replace(/[（(].*?[）)]/g, "").replace(/[\s　・:：/／-]/g, "").trim();

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
