/**
 * 支払期日の検査（純関数・DB非依存）。
 *
 * フリーランス・事業者間取引適正化等法は、特定受託事業者への業務委託について
 * 「給付を受領した日から起算して60日以内の、できる限り短い期間内」に支払期日を
 * 定め、その期日までに支払うことを求める。
 *
 * ここで判定するのは日付の関係だけで、適法性の最終判断は法務が行う前提。
 * 起算日（継続的な役務の場合に何を受領日とみなすか）は運用で決める余地があるため、
 * 呼び出し側が basisDate を渡す形にしている。
 */

export const PAYMENT_DUE_LIMIT_DAYS = 60;

export type DueVerdict = "ok" | "over_limit" | "unset" | "not_applicable";

export interface DueCheck {
  verdict: DueVerdict;
  /** 受領日から支払期日までの日数。どちらか欠けると null。 */
  days: number | null;
  /** 上限の期日（受領日 + 60日）。 */
  limitDate: string | null;
  /** 上限を超えている日数。 */
  overBy: number | null;
}

// 日付は 'YYYY-MM-DD' 前提だが、DB から Date が渡ることもあるため両方受ける。
const parse = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null;
  const text = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : String(value).slice(0, 10);
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const format = (date: Date): string => date.toISOString().slice(0, 10);

const DAY = 24 * 60 * 60 * 1000;

/** 受領日 + 60日。期日の既定値にも使う。 */
export function dueLimitFrom(basisDate: string | Date | null | undefined): string | null {
  const basis = parse(basisDate);
  return basis ? format(new Date(basis.getTime() + PAYMENT_DUE_LIMIT_DAYS * DAY)) : null;
}

export function checkPaymentDue(input: {
  /** 検査の対象か。相手先が特定受託事業者でなければ社内基準としての参考値になる。 */
  applicable: boolean;
  /** 給付を受領した日。 */
  basisDate: string | Date | null | undefined;
  /** 定めた支払期日。 */
  dueOn: string | Date | null | undefined;
}): DueCheck {
  const basis = parse(input.basisDate);
  const due = parse(input.dueOn);
  const limitDate = basis ? format(new Date(basis.getTime() + PAYMENT_DUE_LIMIT_DAYS * DAY)) : null;

  if (!input.applicable) return { verdict: "not_applicable", days: null, limitDate, overBy: null };
  if (!basis || !due) return { verdict: "unset", days: null, limitDate, overBy: null };

  const days = Math.round((due.getTime() - basis.getTime()) / DAY);
  const overBy = days - PAYMENT_DUE_LIMIT_DAYS;
  return {
    verdict: overBy > 0 ? "over_limit" : "ok",
    days,
    limitDate,
    overBy: overBy > 0 ? overBy : null
  };
}

/**
 * 取適法の対象か。特定受託事業者＝従業員を使用しない個人・一人法人。
 * 取引先マスタからは「個人かどうか」までしか分からないため、個人を対象とし、
 * 法人は社内基準として同じ検査を通す（判定は not_applicable で区別する）。
 */
export const isFreelanceActTarget = (partyKind: string | null | undefined): boolean =>
  String(partyKind ?? "") === "individual";
