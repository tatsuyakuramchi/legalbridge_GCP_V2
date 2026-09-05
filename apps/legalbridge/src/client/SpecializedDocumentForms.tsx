import type { DocumentFormData } from "../types";

type Row = Record<string, unknown>;
type FieldDefinition = {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
};

type Props = {
  templateKey: string;
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
};

const itemFields: FieldDefinition[] = [
  { name: "item_name", label: "品目・業務名" },
  { name: "spec", label: "仕様・成果物", type: "textarea" },
  { name: "quantity", label: "数量", type: "number" },
  { name: "unit_price", label: "単価（税抜）", type: "number" },
  { name: "amount_ex_tax", label: "金額（税抜）", type: "number" },
  { name: "delivery_date", label: "納期", type: "date" },
  { name: "payment_date", label: "支払日", type: "date" },
  { name: "payment_terms", label: "支払条件" }
];

const expenseFields: FieldDefinition[] = [
  { name: "expense_name", label: "経費名" },
  { name: "spent_date", label: "利用日", type: "date" },
  { name: "amount_inc_tax", label: "金額（税込）", type: "number" },
  { name: "remarks", label: "備考", type: "textarea" }
];

const feeFields: FieldDefinition[] = [
  { name: "fee_name", label: "手数料名" },
  { name: "amount", label: "金額（税抜）", type: "number" },
  { name: "remarks", label: "備考", type: "textarea" }
];

const conditionFields: FieldDefinition[] = [
  { name: "condition_name", label: "条件名" },
  { name: "region_language_label", label: "地域・言語" },
  {
    name: "calc_method", label: "計算方式", type: "select",
    options: [
      { value: "FIXED", label: "固定額" },
      { value: "ROYALTY", label: "料率" },
      { value: "SUBSCRIPTION", label: "定期支払" },
      { value: "SUPPLY_QTY", label: "供給価格×数量×料率" }
    ]
  },
  { name: "base_price_label", label: "基準価格" },
  { name: "rate_pct", label: "料率（%）", type: "number" },
  { name: "mg_amount", label: "MG", type: "number" },
  { name: "ag_amount", label: "AG", type: "number" },
  { name: "currency", label: "通貨" },
  { name: "formula_text", label: "計算式", type: "textarea" },
  { name: "payment_terms", label: "支払条件", type: "textarea" },
  {
    name: "rights_holder", label: "権利帰属", type: "select",
    options: [
      { value: "発注者", label: "発注者・ライセンシー" },
      { value: "受注者", label: "受注者・ライセンサー" }
    ]
  }
];

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
    if (formData.settlement_trigger) {
      const trigger = String(formData.settlement_trigger);
      const label = trigger === "manufacturing"
        ? "製造"
        : trigger === "sale" ? "販売" : "サブライセンス料入金";
      const money = (value: unknown) =>
        `${String(formData.currency ?? "JPY")} ${Number(value ?? 0).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}`;
      return <SpecializedSection title="利用許諾料計算書・確認"
        description="契約条件と発生イベントから自動計算した内容です。計算値は文書画面では変更せず、誤りがある場合は精算画面へ戻って再計算します。">
        <div className="settlement-review-grid">
          <article><span>精算トリガー</span><strong>{label}</strong></article>
          <article><span>発生日</span><strong>{String(formData.settlement_occurred_at ?? "").slice(0, 10) || "—"}</strong></article>
          <article><span>作品</span><strong>{String(formData.originalWork ?? "—")}</strong></article>
          <article><span>相手方</span><strong>{String(formData.licensor ?? "—")}</strong></article>
          <article><span>根拠契約</span><strong>{String(formData.linked_contract_number ?? "—")}</strong></article>
          <article><span>起点OUT条件</span><strong>#{String(formData.source_out_condition_line_id ?? "—")}</strong></article>
          <article><span>支払根拠IN条件</span><strong>#{String(formData.source_condition_line_id ?? "—")}</strong></article>
          <article><span>算定基礎</span><strong>{money(formData.settlement_basis_amount)}</strong></article>
          <article><span>料率</span><strong>{String(formData.royaltyRatePct ?? "—")}%</strong></article>
          <article className="settlement-review-total"><span>利用許諾料（税抜）</span><strong>{money(formData.actualRoyalty)}</strong></article>
        </div>
        {Array.isArray(formData.settlement_warnings) && formData.settlement_warnings.length > 0 &&
          <div className="settlement-review-warnings">
            {(formData.settlement_warnings as unknown[]).map((warning, index) =>
              <p key={index}>{String(warning)}</p>)}
          </div>}
        <div className="settlement-review-note">
          <strong>計算根拠</strong>
          <pre>{String(formData.notes ?? "")}</pre>
        </div>
      </SpecializedSection>;
    }
    return <SpecializedSection title="利用許諾料計算書（Legacy入力）"
      description="旧下書き互換モードです。新規作成は「利用許諾料精算」画面から行ってください。">
      <ArrayEditor title="計算明細" itemLabel="計算明細" dataKey="lines" rows={rows(formData.lines)}
        fields={[
          { name: "productName", label: "対象商品・契約" },
          { name: "sales_amount", label: "算定基礎額", type: "number" },
          { name: "rate_pct", label: "料率（%）", type: "number" },
          { name: "royalty_amount", label: "利用許諾料", type: "number" },
          { name: "basisNote", label: "計算根拠・控除", type: "textarea" }
        ]} onChange={onChange} />
    </SpecializedSection>;
  }

  if (templateKey === "inspection_certificate") {
    return <SpecializedSection title="検収・支払明細" description="検収した成果物を入力し、必要な場合だけ手数料・経費・変更履歴を追加します。">
      <ArrayEditor title="検収明細" itemLabel="検収明細" dataKey="delivery_line_items"
        rows={rows(formData.delivery_line_items)}
        fields={[
          { name: "item_name", label: "品目・成果物" },
          { name: "spec", label: "仕様", type: "textarea" },
          { name: "delivery_date", label: "納品日", type: "date" },
          { name: "inspected_quantity", label: "検収数量", type: "number" },
          { name: "inspected_amount_ex_tax", label: "検収金額（税抜）", type: "number" },
          {
            name: "calc_method", label: "報酬方式", type: "select",
            options: [
              { value: "FIXED", label: "固定額" },
              { value: "ROYALTY", label: "業績連動" }
            ]
          }
        ]} onChange={onChange} />
      <ArrayEditor title="その他手数料" itemLabel="手数料" dataKey="other_fees"
        rows={rows(formData.other_fees)} fields={feeFields} onChange={onChange} />
      <ArrayEditor title="経費" itemLabel="経費" dataKey="expenses" rows={rows(formData.expenses)}
        fields={expenseFields} onChange={onChange} />
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
        {fields.map((field) => <DynamicField key={field.name} definition={field}
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
    <span>{definition.label}</span>
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
