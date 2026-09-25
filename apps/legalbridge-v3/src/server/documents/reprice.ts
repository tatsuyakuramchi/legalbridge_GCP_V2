/**
 * 訂正版の下書きに引き継いだ手入力の明細を、新しい金額・日付に引き直す。
 *
 * 発注書の明細（manual_inputs.items）は人が打った値で、条件や予定明細より
 * 強い。訂正版はその手入力をそのまま引き継ぐので、条件を ¥120,000 → ¥95,000
 * に直しても、納品日を 11/30 → 12/15 に延ばしても、訂正版の紙には古い値が
 * 載ったまま出る。「直したのに直っていない」がここで起きる。
 *
 * ただし機械に引き直せるのは、どの行を直せばよいか一つに決まるときだけ。
 *   金額 … 金額の載った行が1本のとき（2本以上あると、どの行がいくら減った
 *          のかは書いた人にしか分からない。按分すると、打ち合わせで決めた
 *          内訳と違う紙が出る）
 *   日付 … 入っている日付がぜんぶ同じとき（回ごとにずらしてあるなら、
 *          それは人が意図して並べたもの）
 * 分からないものは引き直さず、画面に「この明細は人が直してください」と出す。
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

const dateOf = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

const hasMoney = (row: Row) => EX_TAX_KEYS.some((k) => money(row[k]) !== null)
  || money(row.amount_inc_tax) !== null;

/** 引き直す先。渡した欄だけを見る。 */
export interface RedraftTarget {
  amountExTax?: number | null;
  /** 明細の納品日（delivery_date）。 */
  deliveryOn?: string | null;
  /** 明細の支払日（payment_date）。 */
  paymentOn?: string | null;
}

export interface Redraft {
  manual: Record<string, unknown>;
  /** 引き直した1行ずつ（「表紙イラスト ¥120,000 → ¥95,000」）。画面に出す。 */
  lines: string[];
  /** 引き直せなかった欄と、その理由。画面に出して人に渡す。 */
  pending: string[];
}

/**
 * 引き直せるなら新しい manual_inputs を返す。触るところが何も無ければ null。
 *
 * 元の manual は書き換えない（呼ぶ側が持ったまま比べられるように）。
 */
export function redraftManualInputs(manual: unknown, target: RedraftTarget): Redraft | null {
  const values = { ...((manual ?? {}) as Record<string, unknown>) };
  const lines: string[] = [];
  const pending: string[] = [];
  // 触った配列だけを差し替える。差し替えないものは元の参照のまま置く。
  const next = new Map<string, Row[]>();
  const linesOf = (key: string) => next.get(key) ?? rowsOf(values[key]);
  const put = (key: string, index: number, patch: Row) => {
    const rows = linesOf(key).slice();
    rows[index] = { ...rows[index], ...patch };
    next.set(key, rows);
  };
  const nameOf = (row: Row) => String(row.item_name ?? row.spec ?? "明細").trim() || "明細";

  // ---- 金額。行が一つに決まるときだけ。
  if (target.amountExTax !== undefined && target.amountExTax !== null) {
    const total = target.amountExTax;
    if (OTHER_KEYS.some((k) => rowsOf(values[k]).some(hasMoney))) {
      pending.push("金額（経費・手数料にも金額があるので、明細だけでは合計が決まりません）");
    } else {
      const found: Array<{ key: string; index: number; row: Row }> = [];
      for (const key of LINE_KEYS) {
        rowsOf(values[key]).forEach((row, index) => { if (hasMoney(row)) found.push({ key, index, row }); });
      }
      if (found.length > 1) {
        pending.push(`金額（明細が ${found.length} 行あり、どの行が変わったか決められません）`);
      } else if (found.length === 1) {
        const { key, index, row } = found[0];
        const before = EX_TAX_KEYS.map((k) => money(row[k])).find((n) => n !== null) ?? null;
        const quantity = money(row.quantity);
        const per = quantity !== null && quantity > 1 ? total / quantity : total;
        if (before === null) {
          // 税込だけの行は土俵が違う（税率を当てないと引き直せない）。
          pending.push("金額（税込だけの明細なので引き直せません）");
        } else if (!Number.isInteger(per)) {
          // 単価と金額の食い違う紙を出さない。
          pending.push(`金額（個数 ${quantity} で割り切れません）`);
        } else if (before !== total) {
          const patch: Row = {};
          for (const k of EX_TAX_KEYS) if (money(row[k]) !== null) patch[k] = total;
          if (money(row.unit_price) !== null) patch.unit_price = per;
          put(key, index, patch);
          lines.push(`${nameOf(row)} ¥${before.toLocaleString("ja-JP")} → ¥${total.toLocaleString("ja-JP")}`);
        }
      }
    }
  }

  // ---- 日付。入っている日付がぜんぶ同じときだけ、まとめて差し替える。
  for (const [field, to, label] of [
    ["delivery_date", target.deliveryOn, "納品日"],
    ["payment_date", target.paymentOn, "支払期日"]
  ] as const) {
    if (to === undefined || to === null) continue;
    const found: Array<{ key: string; index: number; row: Row; was: string }> = [];
    for (const key of LINE_KEYS) {
      linesOf(key).forEach((row, index) => {
        const was = dateOf(row[field]);
        if (was) found.push({ key, index, row, was });
      });
    }
    if (!found.length) continue;
    const distinct = [...new Set(found.map((f) => f.was))];
    if (distinct.length > 1) {
      // 回ごとにずらしてあるなら、それは人が意図して並べたもの。
      pending.push(`${label}（明細ごとに違う日が入っているので、まとめては直せません）`);
      continue;
    }
    if (distinct[0] === to) continue;
    for (const f of found) put(f.key, f.index, { [field]: to });
    lines.push(`${label} ${distinct[0]} → ${to}`);
  }

  if (!lines.length && !pending.length) return null;
  for (const [key, rows] of next) values[key] = rows;
  return { manual: values, lines, pending };
}
