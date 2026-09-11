/**
 * 明細の行を直す欄。発注書の品目、検収書の納品明細、手数料、経費。
 *
 * 行は条件・予定・実績から自動で組まれる（サーバの seedLines）。ここでは
 * それを初期値にして、行ごとに 成果物の帰属先・支払方法・納期・支払日 のように
 * 「条件明細には無いが書類には要る」項目を入れる。V2 の ArrayEditor と同じ列
 * （document-line-fields.ts）を持ってきてある。ひな形が読む列名と一対一。
 *
 * 直した行は manualInputs の同じ名前（items など）で保存され、以後はそれが
 * 本文になる。「自動に戻す」で種の行に戻る。
 */
import { SnippetPicker } from "./SnippetPicker.js";
import { roundAmount } from "../server/core/rounding.js";

export type Row = Record<string, unknown>;

interface ShowWhen { field: string; anyOf?: string[]; truthy?: boolean }
export interface Column {
  name: string; label: string;
  type?: "text" | "number" | "date" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
  showWhen?: ShowWhen | ShowWhen[];
  helpText?: string;
  /** 数量×単価から自動で入る列。手で直せば手の値が勝つ。 */
  computed?: boolean;
}

const matches = (c: ShowWhen, row: Row) => {
  const v = row[c.field];
  if (Array.isArray(c.anyOf)) return c.anyOf.includes(String(v ?? ""));
  if (typeof c.truthy === "boolean") return Boolean(v) === c.truthy;
  return true;
};
export const visible = (col: Column, row: Row) =>
  !col.showWhen || (Array.isArray(col.showWhen) ? col.showWhen.every((c) => matches(c, row)) : matches(col.showWhen, row));

const royaltyOnly: ShowWhen = { field: "calc_method", anyOf: ["ROYALTY"] };
const subscriptionOnly: ShowWhen = { field: "calc_method", anyOf: ["SUBSCRIPTION"] };
const notSubscription: ShowWhen = { field: "calc_method", anyOf: ["", "FIXED", "ROYALTY"] };

/** 発注書の品目。発注書の本文が calc_method で単価・納期・支払日の出し方を切り替える。 */
export const ITEM_COLUMNS: Column[] = [
  { name: "item_name", label: "品目・業務名" },
  { name: "spec", label: "仕様・成果物", type: "textarea" },
  { name: "quantity", label: "数量", type: "number" },
  { name: "unit_price", label: "単価（税抜）", type: "number" },
  { name: "amount_ex_tax", label: "金額（税抜）", type: "number", computed: true,
    helpText: "数量×単価で入る。直せば手の値が勝つ" },
  { name: "payment_terms", label: "契約種別・支払条件" },
  { name: "deliverable_ownership", label: "成果物の帰属先", type: "select",
    options: [{ value: "発注者", label: "発注者（譲渡型）" }, { value: "受注者", label: "受注者（利用許諾型）" }],
    helpText: "業績連動のとき、受注者=利用許諾料／発注者=インセンティブ報酬として表記される" },
  { name: "calc_method", label: "支払方法", type: "select",
    options: [{ value: "FIXED", label: "固定額" },
              { value: "ROYALTY", label: "業績連動（利用許諾料・インセンティブ報酬）" },
              { value: "SUBSCRIPTION", label: "定期支払" }],
    helpText: "未選択は固定額として出る" },
  { name: "delivery_date", label: "納期", type: "date", showWhen: notSubscription },
  { name: "payment_date", label: "支払日", type: "date", showWhen: notSubscription },
  { name: "reward_label", label: "確定報酬の名称", showWhen: royaltyOnly,
    helpText: "金額（税抜）が0なら「報酬は利用許諾料に含む」と出る。未入力時は「執筆料」" },
  { name: "calc_type", label: "計算式", type: "select", showWhen: royaltyOnly,
    options: [{ value: "BASE_QTY_RATE", label: "基準価格 × 個数 × 料率" }, { value: "BASE_RATE", label: "基準価格 × 料率" },
              { value: "FIXED", label: "固定値" }, { value: "SUBSCRIPTION", label: "サブスク" }] },
  { name: "fixed_kind", label: "固定値の支払", type: "select",
    showWhen: [royaltyOnly, { field: "calc_type", anyOf: ["FIXED"] }],
    options: [{ value: "LUMP", label: "一括" }, { value: "INSTALLMENT", label: "分割" }] },
  { name: "subscription_cycle", label: "サブスクの周期", type: "select",
    showWhen: [royaltyOnly, { field: "calc_type", anyOf: ["SUBSCRIPTION"] }],
    options: [{ value: "MONTHLY", label: "月払い" }, { value: "ANNUAL", label: "年払い" }] },
  { name: "rate_pct", label: "料率（%）", type: "number", showWhen: royaltyOnly },
  { name: "base_price_label", label: "基準価格", showWhen: royaltyOnly },
  { name: "formula_text", label: "計算式の補足", type: "textarea", showWhen: royaltyOnly },
  { name: "guarantee_type", label: "最低保証", type: "select", showWhen: royaltyOnly,
    options: [{ value: "NONE", label: "なし" }, { value: "MG", label: "MG（ミニマムギャランティ）" }, { value: "AG", label: "AG（アドバンスギャランティ）" }] },
  { name: "mg_amount", label: "MG 金額", type: "number", showWhen: [royaltyOnly, { field: "guarantee_type", anyOf: ["MG"] }] },
  { name: "ag_amount", label: "AG 金額", type: "number", showWhen: [royaltyOnly, { field: "guarantee_type", anyOf: ["AG"] }] },
  { name: "cycle", label: "周期", type: "select", showWhen: subscriptionOnly,
    options: [{ value: "MONTHLY", label: "月次" }, { value: "QUARTERLY", label: "四半期" },
              { value: "SEMIANNUAL", label: "半期" }, { value: "ANNUAL", label: "年次" }] },
  { name: "term_start", label: "役務提供期間（開始）", type: "date", showWhen: subscriptionOnly },
  { name: "term_end", label: "役務提供期間（終了）", type: "date", showWhen: subscriptionOnly, helpText: "空欄なら「継続中」と出る" },
  { name: "billing_day", label: "毎周期の支払日", type: "number", showWhen: subscriptionOnly, helpText: "0 または 31 で「末日」" },
  { name: "billing_timing", label: "支払月", type: "select", showWhen: subscriptionOnly,
    options: [{ value: "SAME_MONTH", label: "当月" }, { value: "NEXT_MONTH", label: "翌月" }, { value: "MONTH_AFTER_NEXT", label: "翌々月" }] }
];

/** 海外発注書だけ。サブスクの支払日を英文でそのまま印字する。 */
export const INTL_ITEM_COLUMNS: Column[] = ITEM_COLUMNS.flatMap((c) => c.name === "billing_timing"
  ? [c, { name: "billing_note", label: "支払日の任意設定（英文・そのまま印字）", showWhen: subscriptionOnly,
          helpText: "例: within 30 days after receipt of invoice" } satisfies Column]
  : [c]);

export const EXPENSE_COLUMNS: Column[] = [
  { name: "expense_name", label: "経費名" },
  { name: "spent_date", label: "利用日", type: "date" },
  { name: "amount_inc_tax", label: "金額（税込）", type: "number" },
  { name: "remarks", label: "備考", type: "textarea" }
];

export const FEE_COLUMNS: Column[] = [
  { name: "fee_name", label: "手数料名" },
  { name: "amount", label: "金額（税抜）", type: "number" },
  { name: "remarks", label: "備考", type: "textarea" }
];

/** 検収書の納品明細。実績1件が1行。 */
export const INSPECTION_COLUMNS: Column[] = [
  { name: "item_name", label: "品目・成果物" },
  { name: "spec", label: "仕様", type: "textarea", helpText: "PDF に補足として印字" },
  { name: "quantity", label: "数量", type: "number" },
  { name: "inspected_quantity", label: "検収数量", type: "number" },
  { name: "ordered_amount_ex_tax", label: "予定額（税抜）", type: "number", helpText: "発注時の金額。検収金額と違えば変更履歴に出る" },
  { name: "inspected_amount_ex_tax", label: "検収金額（税抜）", type: "number" },
  { name: "delivery_date", label: "納品日", type: "date" },
  { name: "paid_date", label: "支払日", type: "date" },
  { name: "inspection_status", label: "扱い", type: "select",
    options: [{ value: "now", label: "今回検収する" }, { value: "paid", label: "支払済み（前回まで）" }, { value: "skip", label: "対象外" }] },
  { name: "changeNote", label: "金額変更の理由", showWhen: { field: "hasChange", truthy: true } },
  /*
   * 業績連動のぶん。報酬計算書という書類は作らず、検収書の明細にこの行を
   * 載せて済ませる。金額（検収金額）は別で計算した結果を人が入れる。
   * ここに置くのは「その金額が何なのか」を紙に書くための欄。
   */
  { name: "deliverable_ownership", label: "成果物の帰属先", type: "select",
    options: [{ value: "発注者", label: "発注者（譲渡型）" }, { value: "受注者", label: "受注者（利用許諾型）" }],
    helpText: "条件明細から入る。業績連動のとき 受注者=利用許諾料／発注者=インセンティブ報酬" },
  { name: "calc_method", label: "支払方法", type: "select",
    options: [{ value: "FIXED", label: "固定額" },
              { value: "ROYALTY", label: "業績連動（利用許諾料・インセンティブ報酬）" },
              { value: "SUBSCRIPTION", label: "定期支払" }],
    helpText: "条件明細の計算方式から入る。未選択は固定額として出る" },
  { name: "reward_label", label: "確定報酬の名称", showWhen: royaltyOnly,
    helpText: "帰属先から入る（利用許諾料／インセンティブ報酬）。別の言い方なら直す" },
  { name: "rate_pct", label: "料率（%）", type: "number", showWhen: royaltyOnly },
  { name: "base_price_label", label: "基準価格", showWhen: royaltyOnly,
    helpText: "何に料率を掛けたか（上代×数量、売上高など）" },
  { name: "formula_text", label: "計算の根拠", type: "textarea", showWhen: royaltyOnly,
    helpText: "検収金額をどう出したか。計算は別で行い、結果と根拠をここに書く" }
];

export const LINE_SECTIONS: Record<string, { title: string; columns: Column[]; intl?: Column[]; hint: string }> = {
  items: { title: "発注明細", columns: ITEM_COLUMNS, intl: INTL_ITEM_COLUMNS,
           hint: "予定明細（無ければ条件の総額）から組んだ行。帰属先・支払方法・納期・支払日はここで入れる" },
  delivery_line_items: { title: "納品明細", columns: INSPECTION_COLUMNS,
           hint: "選んだ実績が1行ずつ。検収金額が予定額と違えば変更履歴に出る。"
               + "業績連動の行は、別で計算した金額と根拠をここに入れる" },
  other_fees: { title: "その他手数料", columns: FEE_COLUMNS, hint: "無ければ空のまま" },
  expenses: { title: "経費", columns: EXPENSE_COLUMNS, hint: "税込で入れる。無ければ空のまま" }
};

const show = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : null; };

export function LineItemsEditor(
  { name, seed, rows, intl, onChange }: {
    name: string;
    /** サーバが組んだ行。編集していないときはこれが本文になる。 */
    seed: Row[];
    /** 人が直した行。null なら未編集（種のまま）。 */
    rows: Row[] | null;
    intl?: boolean;
    onChange: (rows: Row[] | null) => void;
  }
) {
  const section = LINE_SECTIONS[name];
  if (!section) return null;
  const columns = intl && section.intl ? section.intl : section.columns;
  const edited = rows !== null;
  const current = rows ?? seed;

  const update = (i: number, col: Column, value: string) => {
    const next = current.map((r, j) => {
      if (j !== i) return r;
      const row: Row = { ...r, [col.name]: value === "" ? null : col.type === "number" ? num(value) : value };
      // 数量×単価 → 金額。金額を手で直したときは触らない。
      if ((col.name === "quantity" || col.name === "unit_price") && name === "items") {
        const q = num(row.quantity); const u = num(row.unit_price);
        // 数量が小数だと端数が出る。金額は円の整数なので行ごとに四捨五入する。
        if (q !== null && u !== null) row.amount_ex_tax = roundAmount(q * u);
      }
      return row;
    });
    onChange(next);
  };

  return (
    <div className="panel fsec">
      <div className="panel-hd">
        <h2>{section.title}</h2>
        <span className={`src ${edited ? "manual" : "auto"}`}>{edited ? "手入力" : "自動"}</span>
        <span className="faint">{current.length} 行</span>
        <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
          {edited && seed.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>自動に戻す</button>
          )}
          <button type="button" className="btn btn-sm"
                  onClick={() => onChange([...current, {}])}>行を足す</button>
        </span>
      </div>
      <div className="panel-bd stack" style={{ gap: 10 }}>
        <div className="faint">{section.hint}</div>
        {current.length === 0 && <div className="faint">行がありません</div>}
        {current.map((row, i) => (
          <div key={i} className="line-card">
            <div className="row" style={{ marginBottom: 6 }}>
              <b>{i + 1}. {show(row.item_name ?? row.expense_name ?? row.fee_name) || "（名前なし）"}</b>
              <button type="button" className="linky" style={{ marginLeft: "auto" }}
                      onClick={() => onChange(current.filter((_, j) => j !== i))}>この行を外す</button>
            </div>
            <div className="line-grid">
              {columns.filter((c) => visible(c, row)).map((c) => (
                <label key={c.name} className={`field${c.type === "textarea" ? " wide" : ""}`}>
                  <span>{c.label}</span>
                  {c.type === "select" ? (
                    <select value={show(row[c.name])} onChange={(e) => update(i, c, e.target.value)}>
                      <option value="">—</option>
                      {c.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : c.type === "textarea" ? (
                    <>
                      <textarea rows={2} value={show(row[c.name])}
                                onChange={(e) => update(i, c, e.target.value)} />
                      {/* 仕様・備考も決めた言い回しを貼る欄。定型文から入れられる。 */}
                      <SnippetPicker value={show(row[c.name])}
                                     onInsert={(v) => update(i, c, v)} />
                    </>
                  ) : (
                    <input type={c.type === "date" ? "date" : "text"}
                           inputMode={c.type === "number" ? "numeric" : undefined}
                           value={show(row[c.name])} onChange={(e) => update(i, c, e.target.value)} />
                  )}
                  {c.helpText && <small className="faint">{c.helpText}</small>}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
