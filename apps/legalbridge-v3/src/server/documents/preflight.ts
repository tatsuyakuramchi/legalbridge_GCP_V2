/**
 * 発行前の点検。「本文が差しているのに空で出る名前」を拾う。
 *
 * bindVariables が見るのは、ひな形が variables で宣言した項目だけ。本文には
 * 宣言に無い名前も差してある（振込先の BANK_NAME や自社の COMPANY_TEL は
 * 文脈から自動で埋まるので宣言されていない）。そこが空でも誰も気づかず、
 * 「口座番号と名義だけの振込先」が載った検収書がそのまま発行された。
 *
 * ここは止めない。欠けたまま出すのが正しいこともある（FAX を書かない、
 * 海外送金で支店名が無い）。人が見て決められるように、名前を挙げるだけ。
 */

/** Handlebars の制御。値ではないので点検しない。 */
const HELPERS = new Set([
  "if", "unless", "each", "with", "else", "log", "lookup", "this"
]);

/**
 * 本文の中で、条件にも繰り返しにも囲まれていない差し込みだけを残す。
 *
 *   {{#if X}}…{{/if}}   … 出す出さないを本文側が決めている。空でよい
 *   {{#each xs}}…{{/each}} … 中は行ごとの項目。文脈の値とは別物
 *
 * どちらも中身を落としてから見る。落とさないと、任意項目まで警告に出て
 * 一覧が読み飛ばされる。
 */
function unconditionalBody(html: string): string {
  let out = String(html ?? "");
  // 入れ子があるので、内側から畳む。開始と終了が対応しない壊れた本文でも
  // 止まらないよう、回数で打ち切る。
  const block = /\{\{#\s*(if|unless|each|with)[^}]*\}\}(?:(?!\{\{#)[\s\S])*?\{\{\/\s*\1\s*\}\}/g;
  for (let i = 0; i < 20; i++) {
    const next = out.replace(block, " ");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 本文が差している名前（順番どおり・重複なし）。 */
export function referencedNames(html: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of unconditionalBody(html).matchAll(/\{\{\{?\s*([^}\s|]+)/g)) {
    const raw = String(m[1]);
    // 制御・ヘルパ・パス付き（this.x, @index, ../y）は値として点検しない。
    if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("@")
        || raw.startsWith("!") || raw.startsWith(">") || raw.includes(".")
        || raw.includes("/") || HELPERS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    names.push(raw);
  }
  return names;
}

const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * 空のまま出る名前。`declared` に挙がっているものは bindVariables が
 * 別に報告するので、ここでは重ねない。
 */
export function blankPlaceholders(
  html: string, values: Record<string, unknown>, declared: Iterable<string> = []
): string[] {
  const skip = new Set(declared);
  return referencedNames(html).filter((n) => !skip.has(n) && isBlank(values[n]));
}

/** 画面に出す注意書き。名前の羅列では何を直せばいいか分からないので、束ねる。 */
export interface Warning { kind: "bank" | "company" | "staff" | "other"; message: string }

const BANK_LABEL: Record<string, string> = {
  BANK_INFO: "振込先", BANK_NAME: "銀行名", BRANCH_NAME: "支店名",
  ACCOUNT_TYPE: "口座種別", ACCOUNT_NUMBER: "口座番号",
  ACCOUNT_HOLDER_KANA: "口座名義",
  bankName: "銀行名", branchName: "支店名", accountType: "口座種別",
  accountNo: "口座番号", accountNumber: "口座番号", accountHolder: "口座名義"
};

const COMPANY_LABEL: Record<string, string> = {
  COMPANY_NAME: "自社名", COMPANY_NAME_KANA: "自社名（カナ）",
  COMPANY_ADDRESS: "自社住所", COMPANY_POSTAL_CODE: "自社郵便番号",
  COMPANY_TEL: "自社電話番号", COMPANY_FAX: "自社FAX",
  COMPANY_REP: "自社代表者", COMPANY_REPRESENTATIVE: "自社代表者",
  COMPANY_INVOICE_NO: "自社の登録番号（T番号）",
  COMPANY_BANK_INFO: "自社の振込先", COMPANY_SEAL_NOTE: "捺印・備考",
  PARTY_A_NAME: "自社名", PARTY_A_ADDRESS: "自社住所", PARTY_A_REP: "自社代表者"
};

/**
 * 案件の担当者。検収書の【ご連絡先】はここから来る。
 * 本番のひな形は inspectorDept / inspectorName / inspectorEmail を差している。
 */
const STAFF_LABEL: Record<string, string> = {
  STAFF_NAME: "担当者名", inspectorName: "担当者名", 検収者氏名: "担当者名",
  STAFF_DEPARTMENT: "担当者の部署", inspectorDept: "担当者の部署",
  STAFF_EMAIL: "担当者のメール", inspectorEmail: "担当者のメール",
  STAFF_PHONE: "担当者の電話"
};

/** 空欄をひとまとまりの日本語にする。 */
export function documentWarnings(
  html: string, values: Record<string, unknown>, declared: Iterable<string> = []
): Warning[] {
  const blank = blankPlaceholders(html, values, declared);
  const out: Warning[] = [];
  const label = (map: Record<string, string>, names: string[]) =>
    [...new Set(names.map((n) => map[n] ?? n))].join("・");

  const bank = blank.filter((n) => n in BANK_LABEL);
  if (bank.length) {
    out.push({
      kind: "bank",
      message: `振込先が欠けています（${label(BANK_LABEL, bank)}）。`
        + "この書類には空欄で出ます。取引先の口座を直してから発行してください。"
    });
  }

  const company = blank.filter((n) => n in COMPANY_LABEL);
  if (company.length) {
    out.push({
      kind: "company",
      message: `自社情報が空です（${label(COMPANY_LABEL, company)}）。`
        + "運用＞設定＞自社情報 で入れてください。"
    });
  }

  const staff = blank.filter((n) => n in STAFF_LABEL);
  if (staff.length) {
    // 誰のことか書く。名前が無いと、担当者の一覧から当たりを付けて探すことに
    // なる。文書は誰の連絡先を差そうとしたのかを知っている（案件の担当者）。
    const who = [values.inspectorName, values.STAFF_NAME, values["担当者名"]]
      .map((v) => String(v ?? "").trim()).find(Boolean);
    // 名前ごと空なら、案件に担当者が付いていない。直す先は担当者マスタでは
    // なく案件のほう。ここを間違えると、担当者の一覧を見て「メールは入って
    // いる」と確かめて終わってしまう（実際そうなった）。
    const common = "検収書は【ご連絡先】にこれを差して"
      + "「5営業日以内にご連絡ください」と書くので、空欄だと宛先の無い書類になります。";
    out.push(who
      ? {
          kind: "staff",
          message: `${who} の連絡先が空です（${label(STAFF_LABEL, staff)}）。`
            + common + `取引先・担当＞担当者 の ${who} の行で入れてください。`
        }
      : {
          kind: "staff",
          message: "この案件に担当者が設定されていません。" + common
            + "案件を開いて 担当 の「変更」で決めてください。"
            + "決まると部署・氏名・メールがまとめて入ります。"
        });
  }

  const rest = blank.filter((n) =>
    !(n in BANK_LABEL) && !(n in COMPANY_LABEL) && !(n in STAFF_LABEL));
  if (rest.length) {
    out.push({ kind: "other", message: `空欄のまま出る項目: ${rest.join("・")}` });
  }
  return out;
}
