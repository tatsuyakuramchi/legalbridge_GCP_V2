import type { DocumentFormData } from "../types";
import { isFieldVisible } from "./field-visibility";
import {
  type FieldDefinition, itemFields, expenseFields, feeFields, conditionFields
} from "./document-line-fields";

type Row = Record<string, unknown>;

type Props = {
  templateKey: string;
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
};

export function SpecializedDocumentForms({ templateKey, formData, onChange }: Props) {
  if (templateKey === "purchase_order" || templateKey === "intl_purchase_order") {
    return <SpecializedSection title="明細・金銭条件" description="発注明細と、必要な場合だけ経費・手数料・利用許諾条件を追加します。">
      <ArrayEditor title="発注明細" itemLabel="明細" dataKey="items" rows={rows(formData.items)}
        fields={itemFields} onChange={onChange} defaultRow={{ quantity: 1 }} />
      <ArrayEditor title="経費" itemLabel="経費" dataKey="expenses" rows={rows(formData.expenses)}
        fields={expenseFields} onChange={onChange} />
      <ArrayEditor title="その他手数料" itemLabel="手数料" dataKey="other_fees" rows={rows(formData.other_fees)}
        fields={feeFields} onChange={onChange} />
      <ArrayEditor title="利用許諾・業績連動条件" itemLabel="金銭条件" dataKey="financial_conditions"
        rows={rows(formData.financial_conditions)} fields={conditionFields} onChange={onChange}
        defaultRow={{ currency: "JPY" }} />
    </SpecializedSection>;
  }

  if (templateKey === "individual_license_terms") {
    return <SpecializedSection title="利用許諾の詳細条件" description="利用許諾の金銭条件と、再許諾先がある場合の情報を入力します。">
      <ArrayEditor title="金銭条件" itemLabel="条件" dataKey="financial_conditions"
        rows={rows(formData.financial_conditions)} fields={conditionFields} onChange={onChange}
        defaultRow={{ currency: "JPY" }} />
      <ArrayEditor title="サブライセンシー" itemLabel="サブライセンシー" dataKey="サブライセンシー一覧"
        rows={rows(formData["サブライセンシー一覧"])}
        fields={[
          { name: "name", label: "名称" },
          { name: "region", label: "地域" },
          { name: "language", label: "言語" },
          { name: "contract_date", label: "契約日", type: "date" },
          { name: "rate_pct", label: "料率（%）", type: "number" },
          { name: "note", label: "備考", type: "textarea" }
        ]} onChange={onChange} />
    </SpecializedSection>;
  }

  if (templateKey === "royalty_statement") {
    return <SpecializedSection title="利用許諾料明細" description="計算対象ごとに売上額・料率・利用許諾料を入力します。合計額は自動計算されます。">
      <ArrayEditor title="計算明細" itemLabel="計算明細" dataKey="lines" rows={rows(formData.lines)}
        fields={[
          { name: "productName", label: "対象商品・契約" },
          { name: "sales_amount", label: "基準売上額", type: "number" },
          { name: "rate_pct", label: "料率（%）", type: "number" },
          { name: "royalty_amount", label: "利用許諾料", type: "number" },
          { name: "basisNote", label: "計算根拠・控除", type: "textarea" }
        ]} onChange={onChange} />
    </SpecializedSection>;
  }

  if (templateKey === "inspection_certificate") {
    return <SpecializedSection title="検収・支払明細" description="検収した成果物を入力し、必要な場合だけ手数料・経費・変更履歴を追加します。">
      <InspectionLinesTable formData={formData} onChange={onChange} />
      {rows(formData.po_expenses).length || rows(formData.po_other_fees).length
        ? <InspectionSettlement formData={formData} onChange={onChange} />
        : <>
          <ArrayEditor title="その他手数料" itemLabel="手数料" dataKey="other_fees"
            rows={rows(formData.other_fees)} fields={feeFields} onChange={onChange} />
          <ArrayEditor title="経費" itemLabel="経費" dataKey="expenses" rows={rows(formData.expenses)}
            fields={expenseFields} onChange={onChange} />
        </>}
      <ArrayEditor title="変更履歴" itemLabel="変更" dataKey="changeLogs" rows={rows(formData.changeLogs)}
        fields={[
          { name: "changedAt", label: "変更日", type: "date" },
          { name: "fieldLabel", label: "変更項目" },
          { name: "beforeValue", label: "変更前" },
          { name: "afterValue", label: "変更後" },
          { name: "reason", label: "変更理由", type: "textarea" }
        ]} onChange={onChange} />
    </SpecializedSection>;
  }

  return null;
}

function SpecializedSection({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return <section id="specialized-fields" className="specialized-editor">
    <div className="specialized-heading">
      <div><span>追加項目</span><h2>{title}</h2><p>{description}</p></div>
    </div>
    {children}
  </section>;
}

function ArrayEditor({
  title,
  itemLabel,
  dataKey,
  rows: currentRows,
  fields,
  onChange,
  defaultRow = {}
}: {
  title: string;
  itemLabel: string;
  dataKey: string;
  rows: Row[];
  fields: FieldDefinition[];
  onChange: (name: string, value: unknown) => void;
  defaultRow?: Row;
}) {
  const replace = (index: number, patch: Row) =>
    onChange(dataKey, currentRows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const remove = (index: number) =>
    onChange(dataKey, currentRows.filter((_, rowIndex) => rowIndex !== index));
  return <div className="array-editor">
    <div className="repeater-title">
      <div><h3>{title}</h3><small>{currentRows.length}件</small></div>
      <button type="button" onClick={() => onChange(dataKey, [...currentRows, { ...defaultRow }])}>＋ {itemLabel}を追加</button>
    </div>
    {!currentRows.length && <p className="inline-empty">必要な場合は「＋ {itemLabel}を追加」を押してください。</p>}
    {currentRows.map((row, index) => <article className="repeater-card" key={index}>
      <div className="repeater-card-head">
        <strong>{itemLabel} {index + 1}</strong>
        <div className="row-actions">
          <button type="button" disabled={index === 0} onClick={() => moveRow(dataKey, currentRows, index, -1, onChange)}>↑</button>
          <button type="button" disabled={index === currentRows.length - 1} onClick={() => moveRow(dataKey, currentRows, index, 1, onChange)}>↓</button>
          <button type="button" onClick={() => remove(index)}>削除</button>
        </div>
      </div>
      <div className="field-grid">
        {/* 出し分けは行ごと。判定対象は同じ行の値なので、明細1でROYALTYを選んでも
            明細2の列は変わらない。 */}
        {fields.filter((field) => isFieldVisible(field, row)).map((field) =>
          <DynamicField key={field.name} definition={field}
            value={row[field.name]} onChange={(value) => replace(index, { [field.name]: value })} />)}
      </div>
    </article>)}
  </div>;
}

function DynamicField({
  definition,
  value,
  onChange
}: {
  definition: FieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const inputValue = String(value ?? "");
  return <label>
    <span>
      {definition.label}
      {/* 長文欄は定型文からの貼り付けが多いので、別タブで開く導線を見出し横に置く。 */}
      {definition.type === "textarea" &&
        <a className="field-snippets" href="/?view=snippets" target="_blank" rel="noreferrer"
          title="定型文を別タブで開く">定型文</a>}
    </span>
    {definition.type === "textarea"
      ? <textarea value={inputValue} onChange={(event) => onChange(event.target.value)} />
      : definition.type === "select"
        ? <select value={inputValue} onChange={(event) => onChange(event.target.value)}>
          <option value="">選択してください</option>
          {definition.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        : <input type={definition.type === "number" ? "number" : definition.type === "date" ? "date" : "text"}
          value={inputValue}
          onChange={(event) => onChange(definition.type === "number" && event.target.value !== ""
            ? Number(event.target.value)
            : event.target.value)} />}
    {definition.helpText && <small>{definition.helpText}</small>}
  </label>;
}

function moveRow(
  dataKey: string,
  currentRows: Row[],
  index: number,
  direction: -1 | 1,
  onChange: (name: string, value: unknown) => void
) {
  const target = index + direction;
  if (target < 0 || target >= currentRows.length) return;
  const reordered = [...currentRows];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  onChange(dataKey, reordered);
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}


// ── 検収明細テーブル（再設計：1行=1明細の表形式）─────────────────────
// カード型（1行=1カード）だと分納で「発注数量に対して今回いくつ検収したか」が
// 見えない。V1 と同じ表形式で「発注」「今回検収」を並べ、業績連動行は金額入力の
// 代わりに出し分けの注記（発注者帰属=別途算定 / 受注者帰属=利用許諾料に含む）を出す。
// PDF の表記と同じ判定（calc_method × deliverable_ownership × 金額0）。
function InspectionLinesTable({ formData, onChange }: {
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
}) {
  const lines = rows(formData.delivery_line_items);
  const replace = (index: number, patch: Row) =>
    onChange("delivery_line_items", lines.map((row, i) => i === index ? { ...row, ...patch } : row));
  const remove = (index: number) =>
    onChange("delivery_line_items", lines.filter((_, i) => i !== index));
  const add = () => onChange("delivery_line_items",
    [...lines, { item_name: "", inspected_quantity: 1, acceptance_ratio: 1, calc_method: "FIXED" }]);
  const numberOr = (value: unknown): number | "" => {
    if (value === "" || value == null) return "";
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : "";
  };
  return <div className="inspection-lines">
    <div className="repeater-title">
      <div><h3>検収明細</h3><small>{lines.length}件</small></div>
      <button type="button" onClick={add}>＋ 明細を追加</button>
    </div>
    {!lines.length && <p className="inline-empty">
      親の発注書から引用するか、「＋ 明細を追加」で入力してください（明細を使わない場合は下の単票入力に金額を直接入力します）。
    </p>}
    {lines.length > 0 && <>
      <p className="partial-hint">分納の場合は数量・金額を実際に検収した分へ減らしてください（残りは同じ親POから第2回以降の検収書として作れます）。</p>
      <div className="table-scroll"><table className="inspection-lines-table">
        <thead><tr>
          <th>品目・成果物</th>
          <th className="right" title="親の発注書の数量">発注</th>
          <th className="right">今回検収</th>
          <th>納品日</th>
          <th className="right">金額（税抜）</th>
          <th aria-label="操作"></th>
        </tr></thead>
        <tbody>
          {lines.map((row, index) => {
            const isRoyalty = String(row.calc_method ?? "") === "ROYALTY";
            const amount = numberOr(row.inspected_amount_ex_tax);
            const ordered = numberOr(row.ordered_quantity);
            const rateNote = [String(row.royalty_calc_basis ?? "").trim(), row.rate_pct !== "" && row.rate_pct != null ? `${row.rate_pct}%` : ""]
              .filter(Boolean).join(" × ");
            return <tr key={index}>
              <td className="line-main">
                <input value={String(row.item_name ?? "")} placeholder="品目・成果物"
                  onChange={(event) => replace(index, { item_name: event.target.value })} />
                <input className="line-spec" value={String(row.spec ?? "")} placeholder="仕様（PDFに補足として印字）"
                  onChange={(event) => replace(index, { spec: event.target.value })} />
                <label className="line-method"><span>報酬方式</span>
                  <select value={String(row.calc_method ?? "FIXED")}
                    onChange={(event) => replace(index, { calc_method: event.target.value })}>
                    <option value="FIXED">固定額</option>
                    <option value="ROYALTY">業績連動</option>
                  </select>
                </label>
              </td>
              <td className="right ordered">{ordered === "" ? "—" : ordered.toLocaleString("ja-JP")}</td>
              <td className="right"><input type="number" value={String(row.inspected_quantity ?? "")}
                onChange={(event) => replace(index, { inspected_quantity: event.target.value === "" ? "" : Number(event.target.value) })} /></td>
              <td><input type="date" value={String(row.delivery_date ?? "")}
                onChange={(event) => replace(index, { delivery_date: event.target.value })} /></td>
              <td className="right">
                {isRoyalty && !amount
                  ? <span className="line-royalty"><span className="tag-royalty">業績連動</span>
                    {String(row.deliverable_ownership ?? "") === "発注者" ? "別途算定" : "利用許諾料に含む"}
                    {rateNote && <small>{rateNote}</small>}
                    <small>支払額に含めない</small></span>
                  : <input type="number" value={String(row.inspected_amount_ex_tax ?? "")}
                    onChange={(event) => replace(index, { inspected_amount_ex_tax: event.target.value === "" ? "" : Number(event.target.value) })} />}
              </td>
              <td><button type="button" className="line-remove" onClick={() => remove(index)}>削除</button></td>
            </tr>;
          })}
        </tbody>
      </table></div>
    </>}
  </div>;
}

// ── 経費・手数料の精算（V1 ステップ2-b/2-c の移植）──────────────────────
// 親POから引用した経費・手数料の一覧から「今回の支払に含める」行をチェックで選ぶ。
// 「最終検収」を ON にすると全行を一括で含める（V1 の isFinalInspection と同じ）。
// 選んだ行だけを expenses / other_fees に書く＝PDF と総支払額はそこから計算される。
function InspectionSettlement({ formData, onChange }: {
  formData: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const poExpenses = Array.isArray(formData.po_expenses) ? formData.po_expenses as Array<Record<string, unknown>> : [];
  const poFees = Array.isArray(formData.po_other_fees) ? formData.po_other_fees as Array<Record<string, unknown>> : [];
  const isFinal = Boolean(formData.isFinalInspection);
  const selectedExpenses = new Set((Array.isArray(formData.selectedExpenseLineNos) ? formData.selectedExpenseLineNos : []) as number[]);
  const selectedFees = new Set((Array.isArray(formData.selectedOtherFeeLineNos) ? formData.selectedOtherFeeLineNos : []) as number[]);

  const apply = (nextExpenseNos: number[], nextFeeNos: number[], nextFinal: boolean) => {
    onChange("isFinalInspection", nextFinal);
    onChange("selectedExpenseLineNos", nextExpenseNos);
    onChange("selectedOtherFeeLineNos", nextFeeNos);
    const expenseSet = new Set(nextExpenseNos);
    const feeSet = new Set(nextFeeNos);
    onChange("expenses", poExpenses.filter((row) => expenseSet.has(Number(row.line_no))));
    onChange("other_fees", poFees.filter((row) => feeSet.has(Number(row.line_no))));
  };
  const toggleFinal = () => {
    const next = !isFinal;
    apply(next ? poExpenses.map((row) => Number(row.line_no)) : [...selectedExpenses],
      next ? poFees.map((row) => Number(row.line_no)) : [...selectedFees], next);
  };
  const toggleRow = (kind: "expense" | "fee", lineNo: number) => {
    if (isFinal) return;
    const set = new Set(kind === "expense" ? selectedExpenses : selectedFees);
    if (set.has(lineNo)) set.delete(lineNo); else set.add(lineNo);
    apply(kind === "expense" ? [...set] : [...selectedExpenses],
      kind === "fee" ? [...set] : [...selectedFees], isFinal);
  };
  const amountOf = (row: Record<string, unknown>) =>
    Number(String(row.amount_inc_tax ?? row.amount_ex_tax ?? row.amount ?? 0).replace(/,/g, "")) || 0;

  return <div className="inspection-settlement">
    <div className="inspection-settlement-head">
      <h4>経費・手数料の精算（親PO連動）</h4>
      <button type="button" className={`matter-chip ${isFinal ? "active" : ""}`} onClick={toggleFinal}
        title="ON にすると全行を「今回含める」にします">
        {isFinal ? "✓ 最終検収（全行を含む）" : "最終検収にする"}
      </button>
    </div>
    <p className="hub-note">チェックした行だけが今回の総支払額に加算され PDF に載ります。チェックしない行は今回の検収では精算しません（後続の検収書で精算できます）。</p>
    {poExpenses.length > 0 && <table className="settlement-table"><thead>
      <tr><th></th><th>経費</th><th className="right">金額（税込）</th></tr></thead><tbody>
      {poExpenses.map((row) => {
        const lineNo = Number(row.line_no);
        return <tr key={`e${lineNo}`}>
          <td><input type="checkbox" checked={isFinal || selectedExpenses.has(lineNo)}
            disabled={isFinal} onChange={() => toggleRow("expense", lineNo)} /></td>
          <td>{String(row.expense_name ?? row.item_name ?? row.name ?? `経費 ${lineNo}`)}</td>
          <td className="right">¥{amountOf(row).toLocaleString("ja-JP")}</td>
        </tr>;
      })}
    </tbody></table>}
    {poFees.length > 0 && <table className="settlement-table"><thead>
      <tr><th></th><th>その他手数料</th><th className="right">金額（税抜）</th></tr></thead><tbody>
      {poFees.map((row) => {
        const lineNo = Number(row.line_no);
        return <tr key={`f${lineNo}`}>
          <td><input type="checkbox" checked={isFinal || selectedFees.has(lineNo)}
            disabled={isFinal} onChange={() => toggleRow("fee", lineNo)} /></td>
          <td>{String(row.fee_name ?? row.item_name ?? row.name ?? `手数料 ${lineNo}`)}</td>
          <td className="right">¥{amountOf(row).toLocaleString("ja-JP")}</td>
        </tr>;
      })}
    </tbody></table>}
  </div>;
}
