/**
 * 入力欄に出す「候補値」。
 *
 * ひな形が供給元（from）を宣言していれば自動で埋まるが、V1 から移した
 * ひな形にその宣言は無い（V1 に無い概念なので、移行のしようがない）。
 * かといって機械的に対応させるのも危うい。検収書の「実納品日」
 * 「検収完了日」「検収書発行日」は3つとも日付で、どれに何を入れるかは
 * 人にしか決められない。
 *
 * そこで、システムが知っている値を候補として並べ、人が選ぶ形にする。
 * 選ばせるので間違いが起きにくく、移行済みのひな形すべてに今日から効く。
 */

export type CandidateKind = "date" | "amount" | "text";

export interface Candidate {
  /** 何の値か。「実績の発生日」など。 */
  label: string;
  /** 入力欄に入る文字列。 */
  value: string;
  /** どこから来たか。画面のまとまりに使う。 */
  source: string;
  kind: CandidateKind;
}

const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** 金額は桁区切りなしで入れる。書類側で整形されることが多い。 */
const amount = (v: unknown) =>
  typeof v === "number" ? String(Math.round(v)) : String(v ?? "");

/**
 * 文脈から候補を組み立てる。空の値は出さない（選べない候補は邪魔なだけ）。
 */
export function buildCandidates(context: Record<string, any>): Candidate[] {
  const out: Candidate[] = [];
  const add = (source: string, label: string, value: unknown, kind: CandidateKind) => {
    if (isBlank(value)) return;
    const text = kind === "amount" ? amount(value) : String(value);
    if (!text.trim()) return;
    // 同じ値が同じ名前で二度出ないようにする。
    if (out.some((c) => c.label === label && c.value === text)) return;
    out.push({ label, value: text, source, kind });
  };

  const today = new Date().toISOString().slice(0, 10);
  add("今日", "今日の日付", today, "date");

  const c = context.condition;
  if (c) {
    add("条件", "条件番号", c.conditionNo, "text");
    add("条件", "条件名", c.name, "text");
    add("条件", "相手先名", c.counterparty?.name, "text");
    add("条件", "相手先名（敬称つき）",
        c.counterparty?.name ? `${c.counterparty.name} ${c.counterparty.honorific ?? ""}`.trim() : null,
        "text");
    add("条件", "作品名", c.work?.title, "text");
    add("条件", "契約の開始日", c.termStart, "date");
    add("条件", "契約の終了日", c.termEnd, "date");
    add("条件", "支払条件", c.paymentTerms, "text");
    add("条件", "定額（税抜）", c.flatAmount, "amount");
    add("条件", "単価", c.unitAmount, "amount");
    add("条件", "料率（%）", c.ratePct, "text");
    add("条件", "MG 最低保証", c.mgAmount, "amount");
    add("条件", "AG 前払保証", c.agAmount, "amount");
  }

  // 取引先。宛名・インボイス番号は書類にそのまま載る。
  if (c) {
    add("取引先", "取引先カナ", c.counterparty?.kana, "text");
    add("取引先", "インボイス登録番号", c.counterparty?.invoiceNo, "text");
    add("取引先", "法人番号", c.counterparty?.corporateNo, "text");
  }
  for (const contact of (context.contacts ?? []) as Array<Record<string, any>>) {
    const role = CONTACT_ROLE[contact.role] ?? contact.role;
    add("取引先", `${role}の氏名`, contact.name, "text");
    add("取引先", `${role}の部署`, contact.department, "text");
    add("取引先", `${role}のメール`, contact.email, "text");
    add("取引先", `${role}の電話`, contact.phone, "text");
  }

  // 振込先。支払通知書・請求書はこれが無いと書類にならない。
  const bank = context.bank;
  if (bank) {
    add("振込先", "振込先銀行", bank.bankName, "text");
    add("振込先", "振込先支店", bank.branchName, "text");
    add("振込先", "口座種別", ACCOUNT_TYPE[bank.accountType] ?? bank.accountType, "text");
    add("振込先", "口座番号", bank.accountNumber, "text");
    add("振込先", "口座名義（カナ）", bank.holderKana, "text");
    // 1行にまとめたもの。多くの書類はこの形で1行に書く。
    const line = [bank.bankName, bank.branchName,
                  ACCOUNT_TYPE[bank.accountType] ?? bank.accountType,
                  bank.accountNumber, bank.holderKana]
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== "").join(" ");
    add("振込先", "振込先（1行）", line, "text");
  }

  // 案件の担当者。検収書の「検収者」はたいていこの人。
  const o = context.owner;
  if (o) {
    add("担当", "担当者名", o.name, "text");
    add("担当", "担当者の部署", o.department, "text");
    add("担当", "担当者のメール", o.email, "text");
  }

  const sc = context.schedule;
  if (sc) {
    add("予定", "支払期日", sc.payOn, "date");
    add("予定", "発生予定日", sc.dueOn, "date");
    add("予定", "対象回", sc.label, "text");
  }

  const e = context.event;
  if (e) {
    add("実績", "実績の発生日", e.occurredOn, "date");
    add("実績", "実績の金額（税抜）", e.amount, "amount");
    add("実績", "実績の総額", e.grossAmount, "amount");
    add("実績", "実績の対象期間", e.period, "text");
    add("実績", "実績の数量", e.quantity, "text");
  }

  const r = context.royalty;
  if (r) {
    add("計算", "報告売上", r.salesInput, "amount");
    add("計算", "グロス（税抜）", r.grossExTax, "amount");
    add("計算", "MG の上乗せ", r.mgTopup, "amount");
    add("計算", "AG の相殺", r.agOffset, "amount");
    add("計算", "税抜実額", r.netExTax, "amount");
    add("計算", "消費税", r.taxAmount, "amount");
    add("計算", "源泉税", r.withholdingTax, "amount");
    add("計算", "差引振込額", r.netTransfer, "amount");
  }

  const t = context.totals;
  if (t) {
    add("合計", "税抜合計", t.exTax, "amount");
    add("合計", "消費税", t.tax, "amount");
    add("合計", "税込合計", t.incTax, "amount");
  }

  const m = context.matter;
  if (m) {
    add("案件", "案件番号", m.matterNo ?? m.matter_no, "text");
    add("案件", "案件名", m.title, "text");
    add("案件", "案件の期日", m.dueOn ?? m.due_on, "date");
  }

  const a = context.agreement;
  if (a) {
    add("合意", "合意番号", a.agreementNo ?? a.agreement_no, "text");
    add("合意", "合意の件名", a.title, "text");
    add("合意", "締結日", a.executedOn ?? a.executed_on, "date");
    add("合意", "満了日", a.expiresOn ?? a.expires_on, "date");
  }

  // 会社情報は設定の JSON なので、文字列の項目だけを素直に出す。
  const company = context.company;
  if (company && typeof company === "object") {
    for (const [key, value] of Object.entries(company as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number") {
        add("自社", COMPANY_LABEL[key] ?? key, value, "text");
      }
    }
  }
  return out;
}

const ACCOUNT_TYPE: Record<string, string> = {
  ordinary: "普通", checking: "当座", savings: "貯蓄",
  futsu: "普通", touza: "当座"
};

const CONTACT_ROLE: Record<string, string> = {
  primary: "先方担当", signer: "署名者", billing: "請求先"
};

const COMPANY_LABEL: Record<string, string> = {
  name: "自社名", address: "自社住所", tel: "自社電話", representative: "代表者名",
  invoiceNo: "自社インボイス番号", department: "自社部署"
};

/**
 * 入力欄の名前から、その欄に合う候補の種類を当てる。
 * 日付の欄に金額の候補を並べても選べない。外すぶんには害が無いので、
 * 当たらなければ全部出す。
 */
export function kindForField(name: string, label: string): CandidateKind | null {
  const s = `${name} ${label}`.toLowerCase();
  if (/日|date|期日|年月日/.test(`${name} ${label}`) && !/氏名|名前/.test(label)) return "date";
  if (/額|金額|amount|価格|料金|税|price|fee/.test(`${name} ${label}`)) return "amount";
  if (/名|者|部署|内容|件名|住所|番号|name|title/.test(`${name} ${label}`)) return "text";
  return null;
}
