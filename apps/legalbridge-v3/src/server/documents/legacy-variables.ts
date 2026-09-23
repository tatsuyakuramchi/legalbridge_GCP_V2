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
/**
 * 基本契約の呼び方。「業務委託基本契約（AGR-2025-0011）」。
 * 紙に差し込む文字を1つだけ決めて、一括作成からも同じものを使う。
 */
/**
 * 実績の日付のうちいちばん遅いもの。実績が 1 件なら（従来どおり）その実績。
 * 日付は ISO の文字列なので文字列比較で並ぶ。
 */
function latestDate(c: Ctx, pick: (e: Ctx) => unknown, fallback?: unknown): unknown {
  const events = (Array.isArray(c.events) && c.events.length ? c.events : [c.event]).filter(Boolean) as Ctx[];
  const dates = events.map((e) => pick(e)).filter((d): d is string => typeof d === "string" && d !== "");
  if (!dates.length) return fallback ?? (c.event ? pick(c.event) : undefined) ?? undefined;
  return dates.reduce((a, b) => (b > a ? b : a));
}

/**
 * 適格請求書発行事業者の登録番号を「T＋13 桁」にそろえる。
 *
 * 台帳には「T1234567890123」「1234567890123」「T-1234…」「ＴＴ1234…」が
 * 混ざって入りうる。紙に出すのは T が 1 つの形。ひな形の側で「T{{…}}」と
 * 書いてあるとそれでも二重になるので、そちらは 145 で本文を直す。
 * 13 桁の形に読めなければ、入っている文字をそのまま返す（黙って落とさない）。
 */
export function normalizeInvoiceNo(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const compact = raw.replace(/[Ｔｔ]/g, "T").replace(/[\s\-‐‑–—－ー]/g, "").toUpperCase();
  const m = compact.match(/^T*(\d{13})$/);
  return m ? `T${m[1]}` : raw;
}

export function agreementRefText(title: unknown, no: unknown): string | undefined {
  const name = String(title ?? "").trim();
  const number = String(no ?? "").trim();
  // 名前を入れずに登録した合意は、題名が契約番号そのままになっている
  // （移行でそう入った。台帳に何件もある）。そのまま繋ぐと
  // 「ARC-PO-2026-0113（ARC-PO-2026-0113）」と二重に出る。
  if (name && number && name !== number) return `${name}（${number}）`;
  return name || number || undefined;
}

/**
 * 対応表の1行。noSuffix に挙げた名前は、名前ぜんぶが一致したときだけ当て、
 * 末尾一致では当てない。「date」で終わる名前（VENDOR_ACCEPT_DATE・
 * ACCEPT_REPLY_DUE_DATE）が軒並み発行日で埋まり、受注者が記入する承諾日まで
 * 自動で入っていた。「発行日」の末尾一致（検収書発行日）は残す。
 */
const RESOLVERS: Array<{ names: string[]; get: (c: Ctx) => unknown; noSuffix?: string[]; own?: boolean }> = [
  // ---- 文書そのもの ----
  // 「発注番号」はここにもあり、この表は先に見つかったほうが勝つ。発注書では
  // 自分の番号が正しいのでこのままにする。検収書で親の発注番号を出したいときは
  // parent_po_number（明細の行なら order_no）を使うこと。
  { names: ["CONTRACT_NO", "DOC_NO", "ORDER_NO", "documentNumber", "文書番号", "契約書番号", "発注番号"],
    get: (c) => c.document?.number },
  { names: ["SIGN_DATE", "CONTRACT_DATE", "契約締結日"],
    get: (c) => c.agreement?.executedOn ?? c.document?.issuedOn },
  // 発行日・発注日はその書類を出した日。合意の締結日ではない。
  { names: ["documentDate", "発行日", "発注日", "order_date", "ORDER_DATE", "issue_date", "date"],
    get: (c) => c.document?.issuedOn, noSuffix: ["date", "issue_date", "order_date"] },
  // 準拠する契約の番号。合意から引ける。
  { names: ["linked_contract_number", "契約番号", "基本契約番号", "parent_contract_number"],
    get: (c) => c.agreement?.no },
  // 発注書の「基本契約名 / 番号」。準拠契約の条項に差し込むので、番号だけだと
  // 紙に「AGR-2025-0011」としか出ず、何の契約か読めない。
  { names: ["MASTER_CONTRACT_REF", "基本契約名 / 番号"],
    get: (c) => agreementRefText(c.agreement?.title, c.agreement?.no) },
  { names: ["CONTRACT_TITLE_REF", "基本契約名"], get: (c) => c.agreement?.title },
  /**
   * 基本契約に基づく発注かどうか。
   *
   * 発注書の本文はここで準拠条項を出し分ける。埋まらないと、条件に基本契約を
   * 当ててあっても「別紙のスポット契約用約款による」側で紙が出る。
   * 人が外せば人が勝つ（false は空扱いにならないので手入力が残る）。
   */
  { names: ["HAS_BASE_CONTRACT", "基本契約あり"],
    get: (c) => (c.agreement?.no || c.agreement?.title ? true : undefined) },
  // 検収書の見出しの「発注番号」。同じ条件から出ている発注書を辿る。
  { names: ["parent_po_number", "PARENT_PO_NUMBER", "発注番号", "元発注番号"],
    get: (c) => relatedNo(c, "purchase_order") ?? relatedNo(c, "intl_purchase_order")
             ?? conditionOrderNos(c) },
  { names: ["issueKey", "BACKLOG_KEY", "課題キー"], get: (c) => c.backlogKey },

  // ---- 相手先（受注者・許諾者） ----
  //
  // PARTY_A_NAME はここに置かない。甲・発注元・委託者・ライセンシーはすべて
  // 自社を指す名前で、ひな形5本（nda・maintenance_spec・service_master・
  // purchase_order・license_master）のどれも自社の意味で使っている。
  // ここに置いていたので相手先のほうが先に当たり、発注書の「発注元 名称」に
  // 取引先の名前が入っていた（住所と代表者は自社なので、社名だけ相手のもの）。
  { names: ["VENDOR_NAME", "LICENSOR_NAME", "Licensor_氏名会社名", "Licensor_名称",
            "許諾者", "相手先", "取引先", "counterparty", "licensor",
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
  // 代表者（A-032）。取引先の代表者の欄が先。無ければ署名者→主担当（旧い動き）。
  { names: ["counterpartyRep", "受託者代表者名", "相手先代表者"],
    get: (c) => representativeName(c) },
  { names: ["representativeTitle", "VENDOR_REPRESENTATIVE_TITLE", "代表者肩書", "受託者代表者肩書"],
    get: (c) => c.condition?.counterparty?.representativeTitle },
  // 「代表取締役 ◯◯」の 1 行。宛名・署名欄にそのまま置く。文書で出したくなければ
  // この欄を空にする（手入力が自動値に勝つ）。
  { names: ["representativeLine", "VENDOR_REPRESENTATIVE_LINE", "代表者行", "受託者代表者行"],
    get: (c) => {
      const title = String(c.condition?.counterparty?.representativeTitle ?? "").trim();
      const name = String(c.condition?.counterparty?.representativeName ?? "").trim();
      return name ? [title, name].filter(Boolean).join(" ") : undefined;
    } },
  { names: ["VENDOR_IS_CORPORATION", "VENDOR_MASTER_ENTITY_TYPE", "取引先種別",
            "vendorEntityType", "LICENSOR_IS_CORPORATION"],
    // V2 と同じく、法人は "法人"・個人は空文字。テンプレートが
    // `eq VENDOR_IS_CORPORATION "法人"` と `or VENDOR_IS_CORPORATION ...` の
    // 両方で使うため、真偽値にすると片方が常に偽になる。
    get: (c) => (c.condition?.counterparty?.kind === "individual" ? "" : "法人") },
  { names: ["VENDOR_INVOICE_NO", "インボイス登録番号", "invoiceNo"],
    get: (c) => normalizeInvoiceNo(c.condition?.counterparty?.invoiceNo) },
  { names: ["VENDOR_CORPORATE_NO", "法人番号"],
    get: (c) => c.condition?.counterparty?.corporateNo },
  // 相手先の担当者（氏名・部署・メール・電話）は自動で入れない。
  //
  // 取引先の担当者マスタから発注書・検収書の「発注先 通知先」に入れていたが、
  // 書類ごとに宛てる人が違う（同じ社の別の担当、今回だけ上長）。マスタの
  // 1人が黙って紙に出て、直したつもりの欄が次の文書でまた戻る。
  // 欄は手入力にして、担当者マスタの人は候補（「先方担当の氏名」など）から
  // 1回で入れる。候補は candidates.ts が出す。
  // 消した名前：VENDOR_CONTACT_NAME・先方担当者名・VENDOR_CONTACT_EMAIL・
  //   先方担当者メール・VENDOR_EMAIL・Licensor_メール・担当者メール・取引先メール・
  //   VENDOR_CONTACT_DEPARTMENT・先方担当者部署・担当者部署名・VENDOR_CONTACT_PHONE・
  //   Licensor_電話・担当者電話番号・取引先電話
  { names: ["VENDOR_SIGNER_NAME", "署名者名"],
    get: (c) => contact(c, "signer")?.name },
  { names: ["VENDOR_REP", "VENDOR_REPRESENTATIVE", "Licensor_代表者名", "代表者氏名",
            "許諾者代表者", "受託者代表者", "representativeName"],
    get: (c) => representativeName(c) },
  // V1 はこの欄に「様」まで含めて持っていた（本文は敬称を付けない）。
  // 個人で代表者の欄が無いときは出さない。代表者＝本人なので、宛名の
  // 「氏名 様」の下にもう一度「氏名 様」が刷られていた。
  { names: ["VENDOR_REPRESENTATIVE_SAMA", "代表者名様"],
    get: (c) => {
      const party = c.condition?.counterparty ?? {};
      if (party.kind === "individual" && !String(party.representativeName ?? "").trim()) return undefined;
      const name = representativeName(c);
      return name ? `${name} 様` : undefined;
    } },
  { names: ["VENDOR_ADDRESS", "Licensor_住所", "許諾者住所", "取引先住所", "相手先住所"],
    get: (c) => c.condition?.counterparty?.address },
  // licensor_t_number は計算書の「T番号」。適格請求書発行事業者の登録番号で、
  // T で始まるのでこの呼び名になっている。V2 はここに Backlog の課題キーを
  // 入れていた（欄の意味と中身が違う）。V3 は登録番号を入れる。
  { names: ["INVOICE_REGISTRATION_NUMBER", "invoiceRegistrationNumber", "counterpartyTni",
            "licensor_t_number", "T番号",
            "登録番号", "適格請求書発行事業者登録番号"],
    get: (c) => normalizeInvoiceNo(c.condition?.counterparty?.invoiceNo) },
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
  // own: 自社側の欄。「先方担当者名」のような相手側の欄の末尾に「担当者名」が
  // 当たって、相手方の担当者欄に当社の担当者が刷られていた。相手側と分かる
  // 名前（先方・相手先・取引先・受託者・VENDOR …）には、この印の欄を当てない。
  { names: ["STAFF_NAME", "担当者名", "申請者名", "requester"], own: true,
    get: (c) => c.owner?.name },
  { names: ["STAFF_DEPARTMENT", "担当者部署", "申請部署"], own: true,
    get: (c) => c.owner?.department },
  // 検収者は「誰が検収したか」の記録なので、実績にあればそちらが正しい。
  // 実績に無いときだけ案件の担当者で代える（従来の動き）。
  { names: ["inspector_name", "検収者氏名"],
    get: (c) => c.event?.inspectorName ?? c.owner?.name },
  { names: ["inspector_dept", "検収者部署"],
    get: (c) => c.event?.inspectorDept ?? c.owner?.department },
  { names: ["STAFF_EMAIL", "inspectorEmail", "申請者メール", "検収者メールアドレス"], own: true,
    get: (c) => c.owner?.email },
  { names: ["STAFF_PHONE", "担当者電話"], own: true, get: (c) => c.owner?.phone },
  // 英語表記（A-049）。海外版の発注書は STAFF_NAME / STAFF_DEPARTMENT をこれで置き換える。
  { names: ["STAFF_NAME_EN", "担当者名（英語）"], own: true, get: (c) => c.owner?.nameEn },
  { names: ["STAFF_DEPARTMENT_EN", "担当者部署（英語）"], own: true, get: (c) => c.owner?.departmentEn },
  { names: ["監修者"], own: true, get: (c) => c.owner?.name },
  { names: ["inspectorName"], get: (c) => c.event?.inspectorName ?? c.owner?.name },
  { names: ["inspectorDept"], get: (c) => c.event?.inspectorDept ?? c.owner?.department },

  // ---- 自社 ----
  { names: ["COMPANY_NAME", "PARTY_A_NAME", "Licensee_名称", "Licensee_氏名会社名",
            "licensee", "自社名", "payerCompany"],
    get: (c) => c.company?.name },
  { names: ["COMPANY_ADDRESS", "PARTY_A_ADDRESS", "Licensee_住所",
            "アークライト住所", "自社住所"],
    get: (c) => c.company?.address },
  { names: ["COMPANY_REP", "COMPANY_REPRESENTATIVE", "PARTY_A_REP", "Licensee_代表者名",
            "アークライト代表者氏名", "代表者名"], own: true,
    get: (c) => c.company?.rep ?? c.company?.representative },
  { names: ["COMPANY_INVOICE_NO", "自社インボイス番号"],
    get: (c) => c.company?.invoiceNo },
  { names: ["COMPANY_TEL", "自社電話"], own: true, get: (c) => c.company?.tel },
  { names: ["COMPANY_POSTAL_CODE", "自社郵便番号"], get: (c) => c.company?.postalCode },
  // 自社プロファイルは10項目あるのに、別名を用意していたのは6項目だけだった。
  // 残りは設定に入れても書類に出ない（入れた側からは入ったように見える）。
  { names: ["COMPANY_NAME_KANA", "自社名カナ", "自社カナ"], get: (c) => c.company?.nameKana },
  { names: ["COMPANY_FAX", "自社FAX"], get: (c) => c.company?.fax },
  // 相手先の口座（BANK_NAME 系）とは別物。こちらは自社の入金先。
  { names: ["COMPANY_BANK_INFO", "自社振込先", "入金先"], get: (c) => c.company?.bankInfo },
  { names: ["COMPANY_SEAL_NOTE", "捺印備考"], get: (c) => c.company?.sealNote },
  // 英語表記（海外版）。海外版の発注書は PARTY_A_* をこれで置き換える（template-context）。
  { names: ["COMPANY_NAME_EN", "自社名（英語）"], get: (c) => c.company?.nameEn },
  { names: ["COMPANY_ADDRESS_EN", "自社住所（英語）"], get: (c) => c.company?.addressEn },
  { names: ["COMPANY_REP_EN", "自社代表者（英語）"], own: true, get: (c) => c.company?.repEn },
  { names: ["COMPANY_TEL_INTL", "自社電話（国際表記）"], own: true, get: (c) => c.company?.telIntl },

  // ---- 件名・案件 ----
  { names: ["PROJECT_TITLE", "CONTRACT_TITLE", "基本契約名", "件名", "title",
            "contractTitle", "projectTitle", "deliverable", "成果物"],
    get: (c) => c.matter?.title ?? c.condition?.name },
  // 計算書の件名「◯◯ 利用許諾料のご報告」の◯◯は原作名。イン条件が当社作品に
  // ぶら下がっていても、系譜の親の原作名を出す（無ければ作品名）。
  { names: ["originalWork", "原著作物名", "原作名"],
    get: (c) => c.condition?.work?.sourceTitle ?? c.condition?.work?.title },
  { names: ["WORK_TITLE", "作品名", "対象作品予定名", "対象製品予定名"],
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
  // 実績が複数（分納をまとめた検収書）のときは、頭書きの納品日・検収日・支払期日は
  // いちばん遅い実績のものにする。先頭の実績を使っていたので、9/6 と 9/13 の
  // 2 回分をまとめた検収書の頭書きが「9/6 に役務完了・検収」と出ていた。
  { names: ["DELIVERY_DATE", "deliveredAt", "実納品日", "納品日", "delivered_on",
            "summaryDeliveryDate"],
    get: (c) => latestDate(c, (e) => e.occurredOn) },
  { names: ["INSPECTION_DATE", "inspectionCompletedAt", "completionDate",
            "検収完了日", "検収日", "inspected_on", "完成日"],
    // 検収日は納品日と別の日になりうる。実績に入っていればそれを使う。
    get: (c) => latestDate(c, (e) => e.inspectedOn ?? e.occurredOn) },
  { names: ["PAYMENT_DATE", "paymentDueDate", "支払期日", "summaryPaymentDate"],
    get: (c) => latestDate(c, (e) => e.schedule?.payOn, c.schedule?.payOn) },
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
/**
 * 同じ条件から出ている書類の番号。条件をまたぐ検収書では発注書が複数あるので、
 * 番号を重複なく「・」で並べる（見出しの「発注番号」に全部出す）。
 */
/**
 * 条件に控えた外部の発注番号。V3 で出した発注書が無いときの控え。
 * 移行した条件は発注書が V1・V2 側にあるので、ここが見出しの発注番号になる。
 */
const conditionOrderNos = (c: Ctx): string | undefined => {
  const list = (c.conditions ?? []) as Array<Record<string, any>>;
  const nos = [...new Set(list.map((x) => String(x.orderNo ?? "").trim()).filter(Boolean))];
  return nos.length ? nos.join("・") : undefined;
};

const relatedNo = (c: Ctx, templateKey: string): string | undefined => {
  const nos = [...new Set(((c.related ?? []) as Array<Record<string, any>>)
    .filter((d) => d.templateKey === templateKey && d.documentNo)
    .map((d) => String(d.documentNo)))];
  return nos.length ? nos.join("・") : undefined;
};

/** 通知先の 1 行。空の部分は飛ばし、全部空なら undefined（欄は空のまま）。 */
export const CONTACT_LINE_SEPARATOR = " ／ ";
export const contactLine = (parts: unknown[]): string | undefined => {
  const line = parts.map((v) => (v == null ? "" : String(v).trim())).filter(Boolean).join(CONTACT_LINE_SEPARATOR);
  return line || undefined;
};

const contact = (c: Ctx, role: string) =>
  ((c.contacts ?? []) as Array<Record<string, any>>).find((x) => x.role === role) ?? null;

/** 代表者の氏名。取引先の代表者の欄 → 署名者 → 主担当 の順。個人は本人。 */
const representativeName = (c: Ctx): string | undefined => {
  const party = c.condition?.counterparty ?? {};
  const own = String(party.representativeName ?? "").trim();
  if (own) return own;
  if (party.kind === "individual") return String(party.name ?? "").trim() || undefined;
  return contact(c, "signer")?.name ?? contact(c, "primary")?.name ?? undefined;
};

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
 * 名前を、突き合わせる単位に割る。
 *
 * 「成果物・業務内容」のような並記は、どちらも同じものを指す別名なので
 * 両方を見る。割らずに繋げると「成果物業務内容」になり、末尾でしか
 * 当てられなくなる。
 */
const segments = (v: string): string[] =>
  v.replace(/[（(].*?[）)]/g, "")
   .split(/[・,、/／|｜]+/)
   .map((part) => normalize(part))
   .filter((part) => part.length >= 2);

/**
 * 変数名から値を引く。名前でもラベルでも引ける。
 *
 * まず完全一致。次に、正規化したうえでの部分一致を長い名前から試す
 * （「検収書発行日」は「発行日」、「成果物・業務内容」は「成果物」）。
 * 短い名前での部分一致は誤爆するので、3文字以上のものだけを使う。
 *
 * どれにも当たらなければ undefined。当てずっぽうでは埋めない。
 */
/** 相手側の欄と分かる語。自社側の欄（担当者名など）を末尾で当てない。 */
const COUNTERPARTY_SIDE =
  /先方|相手先|相手方|相手|取引先|受託者|許諾者|受注者|委託先|発注先|vendor|licensor|counterparty|contractor|party_b/i;

export function resolveLegacyVariable(name: string, context: Ctx, label?: string): unknown {
  const keys = [String(name ?? "").trim(), String(label ?? "").trim()].filter(Boolean);
  if (!keys.length) return undefined;

  for (const key of keys) {
    for (const entry of RESOLVERS) {
      if (entry.names.includes(key)) return take(entry, context);
    }
  }

  // 部分一致。長い名前を先に見る（「実納品日」より「納品日」が先に当たると困る）。
  //
  // 当たるのは、名前ぜんぶか**末尾**だけ。何の属性かは名前の後ろに来る。
  //   取引先住所 → 住所   実納品日 → 納品日   （後ろが属性）
  //   licensor_t_number → licensor ではない（属性は t_number のほう）
  //
  // どこでも当たってよいことにしていたので、計算書の「T番号」の欄に許諾者の
  // 氏名が出ていた。licensor_t_number が licensor を含んでいたため。
  // 同じ形で「許諾者種別」に相手先の名前が入る当たり方も止まる。
  const matches: Array<{ length: number; entry: typeof RESOLVERS[number] }> = [];
  for (const key of keys) {
    // 相手側と分かる名前には、自社側（担当者名・担当者電話・代表者名 …）の欄を
    // 末尾で当てない。「先方担当者名」に当社の担当者が入っていた。
    const partySide = COUNTERPARTY_SIDE.test(key);
    for (const flat of segments(key)) {
      for (const entry of RESOLVERS) {
        if (partySide && entry.own) continue;
        for (const candidate of entry.names) {
          if (entry.noSuffix?.includes(candidate)) continue;
          const target = normalize(candidate);
          if (target.length < 3) continue;
          if (flat === target || flat.endsWith(target)) {
            matches.push({ length: target.length, entry });
          }
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
      // 担当者の欄（phone / email / contact_*）は自動で入れない（上の対応表と同じ理由）。
      // 宣言（dbField）で指していても空のまま出し、候補から人が選ぶ。
      vendor_rep: representativeName(c) ?? signer.name ?? primary.name,
      // 通知先の 1 行（部署 ／ 氏名 ／ メール ／ 電話）。A-032 で主担当が取引先に
      // 付き、個人は本人に落ちるので、ここは自動で入れてよい。
      contact_line: contactLine([primary.department, primary.name, primary.email, primary.phone]),
      representative_title: party.representativeTitle,
      invoice_registration_number: normalizeInvoiceNo(party.invoiceNo),
      corporate_number: party.corporateNo,
      // 法人／個人。条件書の「許諾者種別」がここから決まる。
      entity_type: party.kind === "individual" ? "個人" : party.kind ? "法人" : undefined,
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
    phone: c.owner?.phone,
    contact_line: contactLine([c.owner?.department, c.owner?.name, c.owner?.email, c.owner?.phone])
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
