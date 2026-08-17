import type { ShowWhenCondition } from "../types";

// 明細エディタ（ArrayEditor）の列定義。SpecializedDocumentForms から切り出して
// 単体テストできるようにしている。発注書テンプレートが読む列名と一対一で対応させ、
// テンプレート側に分岐があるのにフォームから入力できない列が出ないようにする。

export type FieldDefinition = {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
  // 同じ行の他の列を見て出し分ける。全列を常時並べると1明細が20項目近くになるため、
  // 支払方法に関係する列だけを選択後に出す（テンプレート項目の showWhen と同じ書式）。
  showWhen?: ShowWhenCondition | ShowWhenCondition[];
  helpText?: string;
};

// 発注明細は行ごとに支払方法を持つ（発注書テンプレートが calc_method で
// 単価欄・納期欄・支払日欄の出し方を切り替える）。方式に関係のない列まで
// 常時並べると入力しづらいので、選んだ方式の列だけを showWhen で出す。
const royaltyOnly: ShowWhenCondition = { field: "calc_method", anyOf: ["ROYALTY"] };
const subscriptionOnly: ShowWhenCondition = { field: "calc_method", anyOf: ["SUBSCRIPTION"] };
// 未選択は固定額として描画されるので、納期・支払日は未選択でも出す。
const notSubscription: ShowWhenCondition = { field: "calc_method", anyOf: ["", "FIXED", "ROYALTY"] };

export const itemFields: FieldDefinition[] = [
  { name: "item_name", label: "品目・業務名" },
  { name: "spec", label: "仕様・成果物", type: "textarea" },
  { name: "quantity", label: "数量", type: "number" },
  { name: "unit_price", label: "単価（税抜）", type: "number" },
  { name: "amount_ex_tax", label: "金額（税抜）", type: "number" },
  { name: "payment_terms", label: "契約種別・支払条件" },
  {
    name: "deliverable_ownership", label: "成果物の帰属先", type: "select",
    options: [
      { value: "発注者", label: "発注者（譲渡型）" },
      { value: "受注者", label: "受注者（利用許諾型）" }
    ],
    helpText: "業績連動のとき、受注者=利用許諾料／発注者=インセンティブ報酬として表記されます"
  },
  {
    name: "calc_method", label: "支払方法", type: "select",
    options: [
      { value: "FIXED", label: "固定額" },
      { value: "ROYALTY", label: "業績連動（利用許諾料・インセンティブ報酬）" },
      { value: "SUBSCRIPTION", label: "定期支払" }
    ],
    helpText: "未選択は固定額として出力されます"
  },
  { name: "delivery_date", label: "納期", type: "date", showWhen: notSubscription },
  { name: "payment_date", label: "支払日", type: "date", showWhen: notSubscription },
  // ── 業績連動（ROYALTY）─────────────────────────────────────────
  {
    name: "reward_label", label: "確定報酬の名称", showWhen: royaltyOnly,
    helpText: "金額（税抜）が0なら「報酬は利用許諾料に含む」と出力。未入力時は「執筆料」"
  },
  {
    name: "calc_type", label: "計算式", type: "select", showWhen: royaltyOnly,
    options: [
      { value: "BASE_QTY_RATE", label: "基準価格 × 個数 × 料率" },
      { value: "BASE_RATE", label: "基準価格 × 料率" },
      { value: "FIXED", label: "固定値" },
      { value: "SUBSCRIPTION", label: "サブスク" }
    ]
  },
  {
    name: "fixed_kind", label: "固定値の支払", type: "select",
    showWhen: [royaltyOnly, { field: "calc_type", anyOf: ["FIXED"] }],
    options: [
      { value: "LUMP", label: "一括" },
      { value: "INSTALLMENT", label: "分割" }
    ]
  },
  {
    name: "subscription_cycle", label: "サブスクの周期", type: "select",
    showWhen: [royaltyOnly, { field: "calc_type", anyOf: ["SUBSCRIPTION"] }],
    options: [
      { value: "MONTHLY", label: "月払い" },
      { value: "ANNUAL", label: "年払い" }
    ]
  },
  { name: "rate_pct", label: "料率（%）", type: "number", showWhen: royaltyOnly },
  { name: "base_price_label", label: "基準価格", showWhen: royaltyOnly },
  { name: "formula_text", label: "計算式の補足", type: "textarea", showWhen: royaltyOnly },
  {
    name: "guarantee_type", label: "最低保証", type: "select", showWhen: royaltyOnly,
    options: [
      { value: "NONE", label: "なし" },
      { value: "MG", label: "MG（ミニマムギャランティ）" },
      { value: "AG", label: "AG（アドバンスギャランティ）" }
    ]
  },
  {
    name: "mg_amount", label: "MG 金額", type: "number",
    showWhen: [royaltyOnly, { field: "guarantee_type", anyOf: ["MG"] }]
  },
  {
    name: "ag_amount", label: "AG 金額", type: "number",
    showWhen: [royaltyOnly, { field: "guarantee_type", anyOf: ["AG"] }]
  },
  // ── 定期支払（SUBSCRIPTION）───────────────────────────────────
  {
    name: "cycle", label: "周期", type: "select", showWhen: subscriptionOnly,
    options: [
      { value: "MONTHLY", label: "月次" },
      { value: "QUARTERLY", label: "四半期" },
      { value: "SEMIANNUAL", label: "半期" },
      { value: "ANNUAL", label: "年次" }
    ]
  },
  { name: "term_start", label: "役務提供期間（開始）", type: "date", showWhen: subscriptionOnly },
  {
    name: "term_end", label: "役務提供期間（終了）", type: "date", showWhen: subscriptionOnly,
    helpText: "空欄なら「継続中」と出力されます"
  },
  {
    name: "billing_day", label: "毎周期の支払日", type: "number", showWhen: subscriptionOnly,
    helpText: "0 または 31 で「末日」"
  },
  {
    name: "billing_timing", label: "支払月", type: "select", showWhen: subscriptionOnly,
    options: [
      { value: "SAME_MONTH", label: "当月" },
      { value: "NEXT_MONTH", label: "翌月" },
      { value: "MONTH_AFTER_NEXT", label: "翌々月" }
    ]
  }
];

export const expenseFields: FieldDefinition[] = [
  { name: "expense_name", label: "経費名" },
  { name: "spent_date", label: "利用日", type: "date" },
  { name: "amount_inc_tax", label: "金額（税込）", type: "number" },
  { name: "remarks", label: "備考", type: "textarea" }
];

export const feeFields: FieldDefinition[] = [
  { name: "fee_name", label: "手数料名" },
  { name: "amount", label: "金額（税抜）", type: "number" },
  { name: "remarks", label: "備考", type: "textarea" }
];

export const conditionFields: FieldDefinition[] = [
  { name: "condition_name", label: "条件名" },
  { name: "region_language_label", label: "地域・言語" },
  {
    name: "calc_method", label: "計算方式", type: "select",
    options: [
      { value: "FIXED", label: "固定額" },
      { value: "ROYALTY", label: "料率" },
      { value: "PER_UNIT", label: "単価×数量" },
      { value: "INSTALLMENT", label: "分割払い" },
      { value: "SUBSCRIPTION", label: "定期支払" },
      { value: "SUPPLY_QTY", label: "供給価格×数量×料率" }
    ]
  },
  // calc_type / guarantee_type はテンプレートの条件表が計算式列・MG/AG列を
  // 組み立てるのに使う。calc_method（上）は見出しの出し分け用で別物。
  {
    name: "calc_type", label: "計算式", type: "select",
    options: [
      { value: "BASE_QTY_RATE", label: "基準価格 × 個数 × 料率" },
      { value: "BASE_RATE", label: "基準価格 × 料率" },
      { value: "FIXED", label: "固定値" },
      { value: "SUBSCRIPTION", label: "サブスク" }
    ]
  },
  {
    name: "fixed_kind", label: "固定値の支払", type: "select",
    showWhen: { field: "calc_type", anyOf: ["FIXED"] },
    options: [
      { value: "LUMP", label: "一括" },
      { value: "INSTALLMENT", label: "分割" }
    ]
  },
  {
    name: "subscription_cycle", label: "サブスクの周期", type: "select",
    showWhen: { field: "calc_type", anyOf: ["SUBSCRIPTION"] },
    options: [
      { value: "MONTHLY", label: "月払い" },
      { value: "ANNUAL", label: "年払い" }
    ]
  },
  { name: "base_price_label", label: "基準価格" },
  { name: "rate_pct", label: "料率（%）", type: "number" },
  {
    name: "guarantee_type", label: "最低保証", type: "select",
    options: [
      { value: "NONE", label: "なし" },
      { value: "MG", label: "MG（ミニマムギャランティ）" },
      { value: "AG", label: "AG（アドバンスギャランティ）" }
    ]
  },
  { name: "mg_amount", label: "MG 金額", type: "number", showWhen: { field: "guarantee_type", anyOf: ["MG"] } },
  { name: "ag_amount", label: "AG 金額", type: "number", showWhen: { field: "guarantee_type", anyOf: ["AG"] } },
  { name: "currency", label: "通貨" },
  { name: "formula_text", label: "計算式の補足", type: "textarea" },
  { name: "applies_scope", label: "適用範囲", type: "textarea" },
  { name: "payment_terms", label: "支払条件", type: "textarea" },
  {
    name: "rights_holder", label: "権利帰属", type: "select",
    options: [
      { value: "発注者", label: "発注者・ライセンシー" },
      { value: "受注者", label: "受注者・ライセンサー" }
    ]
  }
];
