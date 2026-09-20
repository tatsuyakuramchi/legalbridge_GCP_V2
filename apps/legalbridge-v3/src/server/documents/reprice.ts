/**
 * 訂正版の下書きに引き継いだ手入力の明細を、新しい金額に引き直す。
 *
 * 発注書の明細（manual_inputs.items）は人が打った値で、条件より強い。
 * 訂正版はその手入力をそのまま引き継ぐので、条件を ¥120,000 → ¥95,000 に
 * 直しても、訂正版の紙には ¥120,000 が載ったまま出る。「直したのに直って
 * いない」がここで起きる。
 *
 * ただし機械に引き直せるのは、金額の載った行が1本だけのときに限る。
 * 2本以上あると、どの行がいくら減ったのかは書いた人にしか分からない。
 * 按分すると、打ち合わせで決めた内訳と違う紙が出る。分からないものは
 * 引き直さず、画面に「この明細は人が直してください」と出す。
 */

/** 税抜の金額が載る欄。税込（経費の amount_inc_tax）は混ぜない。 */
const EX_TAX_KEYS = ["amount_ex_tax", "inspected_amount_ex_tax", "amount"];
/** 明細の入る配列。 */
const LINE_KEYS = ["items", "delivery_line_items"];
/** 明細の外で金額を持つ配列。1本でもあれば合計が明細だけでは決まらない。 */
const OTHER_KEYS = ["expenses", "other_fees"];

type Row = Record<string, unknown>;

const rowsOf = (v: unknown): Row[] =>
  Array.isArray(v) ? v.filter((x): x is Row => Boolean(x) && typeof x === "object") : [];

/** 「120,000」「¥120,000」も数として読む。空欄は「無い」。 */
export function money(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,¥￥\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const hasMoney = (row: Row) => EX_TAX_KEYS.some((k) => money(row[k]) !== null)
  || money(row.amount_inc_tax) !== null;

export interface Reprice {
  manual: Record<string, unknown>;
  /** 画面に出す1行（「表紙イラスト ¥120,000 → ¥95,000」）。 */
  line: string;
}

/**
 * 引き直せるなら新しい manual_inputs を返す。引き直せないときは null。
 *
 * 引き直さない（＝人に任せる）のは、
 *   ・金額の載った明細が無い（条件から引くので、そもそも困らない）
 *   ・明細が2本以上ある（どの行が減ったか決められない）
 *   ・経費・手数料に金額がある（合計が明細だけでは決まらない）
 *   ・個数で割り切れない（単価と金額が食い違う紙になる）
 */
export function repriceManualAmounts(
  manual: unknown, newTotalExTax: number
): Reprice | null {
  const values = { ...((manual ?? {}) as Record<string, unknown>) };
  if (OTHER_KEYS.some((k) => rowsOf(values[k]).some(hasMoney))) return null;

  const found: Array<{ key: string; index: number; row: Row }> = [];
  for (const key of LINE_KEYS) {
    rowsOf(values[key]).forEach((row, index) => { if (hasMoney(row)) found.push({ key, index, row }); });
  }
  if (found.length !== 1) return null;

  const { key, index, row } = found[0];
  const before = EX_TAX_KEYS.map((k) => money(row[k])).find((n) => n !== null) ?? null;
  if (before === null) return null;          // 税込だけの行は土俵が違う
  if (before === newTotalExTax) return null; // 直すところが無い

  const quantity = money(row.quantity);
  const per = quantity !== null && quantity > 1 ? newTotalExTax / quantity : newTotalExTax;
  // 単価と金額の食い違う紙を出さない。割り切れないなら人に任せる。
  if (!Number.isInteger(per)) return null;

  const next: Row = { ...row };
  for (const k of EX_TAX_KEYS) if (money(row[k]) !== null) next[k] = newTotalExTax;
  if (money(row.unit_price) !== null) next.unit_price = per;

  const rows = rowsOf(values[key]).slice();
  rows[index] = next;
  values[key] = rows;

  const name = String(row.item_name ?? row.spec ?? "明細").trim() || "明細";
  return { manual: values, line: `${name} ¥${before.toLocaleString("ja-JP")} → ¥${newTotalExTax.toLocaleString("ja-JP")}` };
}
