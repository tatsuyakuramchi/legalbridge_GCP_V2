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
  {
    name: "item_name", label: "業務区分", type: "select",
    options: [
      { value: "PMO業務", label: "PMO業務" },
      { value: "イベント企画立案運営業務", label: "イベント企画立案運営業務" },
      { value: "報告書等作成業務", label: "報告書等作成業務" },
      { value: "イベント以外の事務管理業務", label: "イベント以外の事務管理業務" },
      { value: "制作・編集業務", label: "制作・編集業務" },
      { value: "システム開発・保守", label: "システム開発・保守" },
      { value: "その他", label: "その他" }
    ]
  },
  { name: "spec", label: "DB引用された仕様・成果物（必要部分のみ修正）", type: "textarea" },
  {
    name: "engagement_type", label: "契約類型", type: "select",
    options: [
      { value: "請負", label: "請負（成果物の完成）" },
      { value: "準委任", label: "準委任（業務の遂行）" },
      { value: "レベニューシェア", label: "レベニューシェア" }
    ]
  },
  {
    name: "inspection_method", label: "検収方法", type: "select",
    options: [
      { value: "成果物検収", label: "成果物を検収" },
      { value: "月次報告確認", label: "月次報告を確認" },
      { value: "完了報告確認", label: "完了報告を確認" },
      { value: "検収なし", label: "検収なし" }
    ]
  },
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
  if (templateKey === "service_master") {
    return <ServiceOutsourcingForm formData={formData} onChange={onChange} />;
  }

  if (templateKey === "purchase_order" || templateKey === "intl_purchase_order") {
    return <SpecializedSection title="業務委託・発注明細" description="契約類型を選び、DB引用された依頼内容を確認して発注条件を確定します。">
      <ServiceOrderControls formData={formData} onChange={onChange} />
      <ArrayEditor title="発注明細" itemLabel="明細" dataKey="items" rows={rows(formData.items)}
        fields={itemFields} onChange={onChange} defaultRow={{ quantity: 1, engagement_type: formData.SERVICE_ENGAGEMENT_TYPE ?? "請負" }} />
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
      <div className="service-choice-grid">
        <ChoiceField label="確認方法" value={formData.INSPECTION_METHOD} options={[
          ["成果物検収", "成果物を検収"], ["月次報告確認", "月次報告を確認"],
          ["完了報告確認", "完了報告を確認"]
        ]} onChange={(value) => onChange("INSPECTION_METHOD", value)} />
        <ChoiceField label="判定" value={formData.INSPECTION_RESULT} options={[
          ["合格", "合格"], ["条件付き合格", "条件付き合格"], ["再納品", "再納品を依頼"]
        ]} onChange={(value) => onChange("INSPECTION_RESULT", value)} />
        <ChoiceField label="支払処理" value={formData.PAYMENT_STATUS} options={[
          ["支払手続前", "支払手続前"], ["支払申請済", "支払申請済"], ["支払済", "支払済"]
        ]} onChange={(value) => onChange("PAYMENT_STATUS", value)} />
      </div>
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

function ServiceOutsourcingForm({ formData, onChange }: Omit<Props, "templateKey">) {
  const engagementType = String(formData.SERVICE_ENGAGEMENT_TYPE ?? "");
  const chooseEngagement = (value: string) => {
    onChange("SERVICE_ENGAGEMENT_TYPE", value);
    onChange("CONTRACT_TYPE", value);
    if (value === "請負") {
      onChange("DELIVERABLE_REQUIRED", "必要");
      onChange("INSPECTION_REQUIRED", "必要");
      onChange("COMPENSATION_TYPE", "固定額");
    } else if (value === "準委任") {
      onChange("DELIVERABLE_REQUIRED", "不要（業務報告のみ）");
      onChange("INSPECTION_REQUIRED", "不要（履行確認）");
      onChange("COMPENSATION_TYPE", "月額");
    } else if (value === "レベニューシェア") {
      onChange("DELIVERABLE_REQUIRED", "案件に応じて選択");
      onChange("INSPECTION_REQUIRED", "案件に応じて選択");
      onChange("COMPENSATION_TYPE", "売上連動");
    }
  };
  return <SpecializedSection title="業務委託条件" description="DB情報を起点に、契約類型と例外条件だけを選択します。">
    <div className="service-flow-banner">
      <span>1 基本契約</span><i>→</i><span>2 発注</span><i>→</i><span>3 納品・報告</span><i>→</i><span>4 検収</span><i>→</i><span>5 支払</span>
    </div>
    <div className="service-choice-grid">
      <ChoiceField label="契約類型" value={engagementType} options={[
        ["請負", "請負（成果物の完成）"], ["準委任", "準委任（業務の遂行）"],
        ["レベニューシェア", "レベニューシェア"]
      ]} onChange={chooseEngagement} />
      <ChoiceField label="業務区分" value={formData.SERVICE_CATEGORY} options={[
        ["PMO業務", "PMO業務"], ["イベント企画立案運営業務", "イベント企画立案運営業務"],
        ["報告書等作成業務", "報告書等作成業務"], ["イベント以外の事務管理業務", "イベント以外の事務管理業務"],
        ["制作・編集業務", "制作・編集業務"], ["システム開発・保守", "システム開発・保守"], ["その他", "その他"]
      ]} onChange={(value) => onChange("SERVICE_CATEGORY", value)} />
      <ChoiceField label="報酬方式" value={formData.COMPENSATION_TYPE} options={[
        ["固定額", "固定額"], ["月額", "月額"], ["時間単価", "時間単価"], ["売上連動", "売上連動"]
      ]} onChange={(value) => onChange("COMPENSATION_TYPE", value)} />
      <ChoiceField label="成果物" value={formData.DELIVERABLE_REQUIRED} options={[
        ["必要", "成果物あり"], ["不要（業務報告のみ）", "成果物なし・業務報告のみ"], ["案件に応じて選択", "個別発注で指定"]
      ]} onChange={(value) => onChange("DELIVERABLE_REQUIRED", value)} />
      <ChoiceField label="検収" value={formData.INSPECTION_REQUIRED} options={[
        ["必要", "検収あり"], ["不要（履行確認）", "検収なし・履行確認"], ["案件に応じて選択", "個別発注で指定"]
      ]} onChange={(value) => onChange("INSPECTION_REQUIRED", value)} />
      <ChoiceField label="知的財産権" value={formData.IP_OWNERSHIP} options={[
        ["発注者帰属", "成果物の権利を発注者へ移転"], ["受注者帰属・利用許諾", "受注者帰属・発注者へ利用許諾"],
        ["既存権利を除き発注者帰属", "既存権利を除き発注者へ移転"]
      ]} onChange={(value) => onChange("IP_OWNERSHIP", value)} />
      <ChoiceField label="再委託" value={formData.SUBCONTRACTING_POLICY} options={[
        ["事前書面承諾", "事前の書面承諾が必要"], ["禁止", "再委託禁止"], ["通知", "事前通知で可"]
      ]} onChange={(value) => onChange("SUBCONTRACTING_POLICY", value)} />
      <ChoiceField label="個人情報" value={formData.PERSONAL_DATA_HANDLING} options={[
        ["取扱いなし", "個人情報の取扱いなし"], ["取扱いあり", "個人情報の取扱いあり"], ["要確認", "取扱いを確認する"]
      ]} onChange={(value) => onChange("PERSONAL_DATA_HANDLING", value)} />
      <ChoiceField label="契約更新" value={formData.RENEWAL_TYPE} options={[
        ["自動更新なし", "自動更新なし"], ["1年自動更新", "1年ごとの自動更新"], ["協議更新", "期間満了前に協議"]
      ]} onChange={(value) => onChange("RENEWAL_TYPE", value)} />
    </div>
    <div className="service-derived-summary">
      <strong>選択結果</strong>
      <p>{engagementType === "請負" ? "成果物の完成と検収を中心に発注書・検収書へ引き継ぎます。"
        : engagementType === "準委任" ? "業務遂行と報告を中心にし、成果物の完成義務を前提にしません。"
          : engagementType === "レベニューシェア" ? "売上連動条件と計算・報告方法を個別発注へ引き継ぎます。"
            : "契約類型を選択すると、成果物・検収・報酬方式の標準値を設定します。"}</p>
    </div>
    <label className="service-exception-note"><span>例外・特約（必要な場合のみ）</span>
      <textarea value={String(formData.SPECIAL_TERMS ?? "")} onChange={(event) => onChange("SPECIAL_TERMS", event.target.value)}
        placeholder="標準条件から外れる事項だけを入力してください" />
    </label>
  </SpecializedSection>;
}

function ServiceOrderControls({ formData, onChange }: Omit<Props, "templateKey">) {
  return <>
    <div className="service-choice-grid">
      <ChoiceField label="契約類型" value={formData.SERVICE_ENGAGEMENT_TYPE} options={[
        ["請負", "請負（成果物の完成）"], ["準委任", "準委任（業務の遂行）"], ["レベニューシェア", "レベニューシェア"]
      ]} onChange={(value) => onChange("SERVICE_ENGAGEMENT_TYPE", value)} />
      <ChoiceField label="成果物・報告" value={formData.DELIVERABLE_REQUIRED} options={[
        ["必要", "成果物あり"], ["不要（業務報告のみ）", "業務報告のみ"], ["案件に応じて選択", "個別指定"]
      ]} onChange={(value) => onChange("DELIVERABLE_REQUIRED", value)} />
      <ChoiceField label="知的財産権" value={formData.IP_OWNERSHIP} options={[
        ["発注者帰属", "発注者帰属"], ["受注者帰属・利用許諾", "受注者帰属・利用許諾"],
        ["既存権利を除き発注者帰属", "既存権利を除き発注者帰属"]
      ]} onChange={(value) => onChange("IP_OWNERSHIP", value)} />
      <ChoiceField label="源泉徴収" value={formData.WITHHOLDING_TAX} options={[
        ["対象外", "対象外"], ["対象", "対象"], ["要確認", "要確認"]
      ]} onChange={(value) => onChange("WITHHOLDING_TAX", value)} />
    </div>
    {formData.DETAILS && <div className="db-source-preview"><span>依頼から引用した業務内容</span><p>{String(formData.DETAILS)}</p></div>}
  </>;
}

function ChoiceField({ label, value, options, onChange }: {
  label: string; value: unknown; options: Array<[string, string]>; onChange: (value: string) => void;
}) {
  const current = String(value ?? "");
  return <label><span>{label}</span><select value={current} onChange={(event) => onChange(event.target.value)}>
    <option value="">選択してください</option>
    {current && !options.some(([value]) => value === current) && <option value={current}>{current}</option>}
    {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
  </select></label>;
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
          {inputValue && !definition.options?.some((option) => option.value === inputValue) &&
            <option value={inputValue}>{inputValue}</option>}
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
