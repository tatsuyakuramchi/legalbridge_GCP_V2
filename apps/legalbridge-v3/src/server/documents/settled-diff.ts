import { SETTLED_COLUMNS } from "./settled-columns.js";

/**
 * 書き出した現物と、直した CSV の差を取る。
 *
 * 決済済みの作り直しは、押すと番号を振って紙を作ってしまう。試算（preview）は
 * 「何ができるか」は出すが、「もとと何が違うか」は出さない。金額を直すために
 * 上げ直しているのに、どこを直したのかが画面に出ないまま押すことになる。
 * 直した覚えのない列が動いていても気づけない。
 *
 * 行は「条件名＋品目名」で合わせる。行の並びで合わせると、1行足しただけで
 * 以降が全部「変わった」に見える。
 */

/**
 * 突き合わせの鍵。同じ条件の同じ品目は1行のはず。
 *
 * 条件番号があればそれを使う。名前で合わせると、条件名を直しただけの行が
 * 「1行消えて1行増えた」に見え、金額を見比べられなくなる。
 */
export const rowKey = (row: Record<string, unknown>): string => {
  const no = text(row.conditionNo);
  return `${no || text(row.conditionName)}\u0000${text(row.item_name)}`;
};

export type ChangeKind = "added" | "removed" | "changed" | "same";

export interface FieldChange { key: string; label: string; before: string; after: string }

export interface RowDiff {
  key: string;
  kind: ChangeKind;
  conditionName: string;
  itemName: string;
  partyName: string;
  /** 変わった列だけ。同じ行では空。 */
  fields: FieldChange[];
  /** 税抜の合計（数量 × 単価。検収数量があればそちら）。 */
  beforeAmount: number | null;
  afterAmount: number | null;
}

export interface SettledDiff {
  rows: RowDiff[];
  summary: {
    added: number; removed: number; changed: number; same: number;
    beforeTotal: number; afterTotal: number; delta: number;
  };
  /** 同じ鍵の行が2つ以上あって、どれと比べたのか決められなかったもの。 */
  ambiguous: string[];
}

const LABEL = new Map(SETTLED_COLUMNS.map((c) => [c.key, c.label]));


export function diffSettled(
  before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>
): SettledDiff {
  const ambiguous: string[] = [];
  const beforeBy = indexBy(before, ambiguous);
  const afterBy = indexBy(after, ambiguous);

  const keys = [...new Set([...beforeBy.keys(), ...afterBy.keys()])];
  const rows: RowDiff[] = keys.map((key) => {
    const a = beforeBy.get(key) ?? null;
    const b = afterBy.get(key) ?? null;
    const head = b ?? a!;
    const fields = a && b ? changesBetween(a, b) : [];
    return {
      key,
      kind: !a ? "added" : !b ? "removed" : fields.length ? "changed" : "same",
      conditionName: text(head.conditionName),
      itemName: text(head.item_name),
      partyName: text(head.partyName),
      fields,
      beforeAmount: a ? amountOf(a) : null,
      afterAmount: b ? amountOf(b) : null
    };
  });

  // 変わったものを上に出す。同じ行は下に畳む。
  const order: Record<ChangeKind, number> = { changed: 0, added: 1, removed: 2, same: 3 };
  rows.sort((x, y) => order[x.kind] - order[y.kind]
    || x.conditionName.localeCompare(y.conditionName, "ja")
    || x.itemName.localeCompare(y.itemName, "ja"));

  // 分からない行（単価が空）は足さない。0 として混ぜると差額が嘘になる。
  const sum = (list: RowDiff[], pick: (r: RowDiff) => number | null) =>
    list.reduce((a, r) => a + (pick(r) ?? 0), 0);
  const beforeTotal = sum(rows, (r) => r.beforeAmount);
  const afterTotal = sum(rows, (r) => r.afterAmount);

  return {
    rows,
    summary: {
      added: rows.filter((r) => r.kind === "added").length,
      removed: rows.filter((r) => r.kind === "removed").length,
      changed: rows.filter((r) => r.kind === "changed").length,
      same: rows.filter((r) => r.kind === "same").length,
      beforeTotal, afterTotal, delta: afterTotal - beforeTotal
    },
    ambiguous
  };
}

/** 列ごとの違い。CSV は全部文字なので、数値の列だけ数として比べる。 */
export function changesBetween(
  a: Record<string, unknown>, b: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const column of SETTLED_COLUMNS) {
    const before = text(a[column.key]), after = text(b[column.key]);
    if (same(column.key, before, after)) continue;
    out.push({ key: column.key, label: column.label, before, after });
  }
  return out;
}

/** 数量・単価は「12」と「12.0」を同じものとして扱う。日付と文字はそのまま。 */
const NUMERIC = new Set(["quantity", "unit_price", "inspectedQuantity"]);

function same(key: string, before: string, after: string): boolean {
  if (before === after) return true;
  if (!NUMERIC.has(key)) return false;
  const x = Number(before), y = Number(after);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/** その行の税抜。検収数量が入っていればそちらで計算する（減額検収）。 */
export function amountOf(row: Record<string, unknown>): number | null {
  // Number("") は 0。空欄をそのまま数にすると、単価未入力の行が 0 円として
  // 合計に混ざり、「いくら変わるか」を静かに狂わせる。空は「分からない」。
  const unit = numOf(text(row.unit_price));
  if (unit === null) return null;
  const inspected = numOf(text(row.inspectedQuantity));
  const quantity = inspected ?? numOf(text(row.quantity)) ?? 1;
  return Math.round(unit * quantity);
}

const numOf = (s: string): number | null => {
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function indexBy(rows: Array<Record<string, unknown>>, ambiguous: string[]) {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = rowKey(row);
    if (map.has(key)) {
      // 同じ条件に同じ品目名が2行。どちらと比べるべきか機械には決められない。
      const seen = `${text(row.conditionName)}／${text(row.item_name)}`;
      if (!ambiguous.includes(seen)) ambiguous.push(seen);
      continue;
    }
    map.set(key, row);
  }
  return map;
}

const text = (v: unknown): string => String(v ?? "").trim();

export { LABEL as SETTLED_LABELS };
