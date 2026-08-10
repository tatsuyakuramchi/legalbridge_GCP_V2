// 明細行（Phase 16-3c・純粋モジュール）。V1 slackGateway の LINE_ITEM_FIELDS／
// buildLineItemBlocks／getLineItemSectionBlocks／formatLineItemsText を移植。
// 種別ごとの明細定義は V1 と同一（ラベル・placeholder・選択肢も一字一句合わせる）。

export const LINE_ITEM_MAX = 5;
export const LINE_ITEM_ADD_ACTION_ID = "li_add";
export const LINE_ITEM_REMOVE_ACTION_ID = "li_remove";

export interface LineItemField {
  key: string;
  label: string;
  kind: "text" | "multiline" | "date" | "select" | "radio";
  optional?: boolean;
  placeholder?: string;
  initialValue?: string;
  initialDays?: number;
  options?: Array<{ value: string; text: string }>;
}

export const LINE_ITEM_FIELDS: Record<string, { label: string; fields: LineItemField[] }> = {
  purchase_order: {
    label: "発注明細",
    fields: [
      { key: "name", label: "発注の概要名称", kind: "text", placeholder: "例: 〇〇制作業務" },
      {
        key: "ip_ownership", label: "IP帰属", kind: "radio",
        options: [
          { value: "transfer", text: "当社へ譲渡（譲渡型）" },
          { value: "license", text: "利用許諾（ロイヤリティ有）" }
        ]
      },
      { key: "work_spec", label: "業務内容・仕様（できるだけ具体的に）", kind: "multiline", placeholder: "箇条書きで記入してください" },
      { key: "work_deadline", label: "業務納期", kind: "date", initialDays: 30 },
      {
        key: "payment_method", label: "支払方法", kind: "select",
        options: [
          { value: "lump_sum", text: "一括" },
          { value: "installments", text: "分割" },
          { value: "royalty", text: "ロイヤリティ歩合" },
          { value: "monthly", text: "月払い" },
          { value: "quarterly", text: "四半期払い" },
          { value: "yearly", text: "年払い" }
        ]
      },
      { key: "payment_due", label: "支払期日", kind: "date", initialDays: 60 },
      { key: "amount", label: "金額（税抜）", kind: "text", placeholder: "例: 100000（分割・歩合の場合は算定方法を記載）" },
      { key: "royalty_terms", label: "料率・基準価格・MG/AG〔利用許諾ありのときのみ〕", kind: "text", optional: true, placeholder: "例: 料率5% / 基準価格1,650円 / MG 100,000円" },
      { key: "remarks", label: "特約・備考", kind: "text", optional: true, placeholder: "無ければ「無し」" }
    ]
  },
  lic_individual: {
    label: "許諾明細",
    fields: [
      { key: "original_work", label: "原著作物名（対象作品）", kind: "text", placeholder: "例: 『〇〇』（原作および派生作品を含む 等の補記も可）" },
      {
        key: "usage_type", label: "展開区分（条件書の種類）", kind: "radio",
        options: [
          { value: "boardgame", text: "ボードゲーム（個別利用許諾条件書）" },
          { value: "publication", text: "出版（出版等利用許諾条件書）" },
          { value: "other", text: "その他" }
        ]
      },
      { key: "product_name", label: "対象製品（予定）名", kind: "text", placeholder: "例: ボードゲーム「〇〇」/ 書籍『〇〇』" },
      {
        key: "exclusivity", label: "独占性", kind: "radio",
        options: [
          { value: "exclusive", text: "独占" },
          { value: "non_exclusive", text: "非独占" }
        ]
      },
      { key: "license_start", label: "許諾開始日", kind: "date", initialDays: 30 },
      { key: "license_term", label: "許諾期間", kind: "text", placeholder: "例: 基本契約の満了日まで / 発売日から3年間" },
      {
        key: "money_own", label: "金銭条件① 自社製造・自社販売", kind: "multiline", optional: true,
        placeholder: "例: 国内・日本語 / ロイヤリティ5% × 上代(MSRP) / MG 100,000円 / 四半期締め翌月末払い"
      },
      {
        key: "money_sublicense", label: "金銭条件② サブライセンス（ライセンスアウト）", kind: "multiline", optional: true,
        placeholder: "例: 北米・英語 / サブライセンス収入の50% / 半期締め翌月末払い"
      },
      {
        key: "money_product_out", label: "金銭条件③ 自社製造・他社販売（プロダクトアウト）", kind: "multiline", optional: true,
        placeholder: "例: 国内・日本語 / 卸価格 × 5% × 出荷数 / 四半期締め翌月末払い"
      },
      { key: "supervision_credit", label: "監修・クレジット表示", kind: "text", optional: true, placeholder: "例: 要監修（発売前確認） / © 表記「〇〇」" },
      { key: "remarks", label: "特記事項", kind: "text", optional: true, placeholder: "無ければ「無し」" }
    ]
  },
  delivery_inspec: {
    label: "納品明細",
    fields: [
      {
        key: "target_doc_number",
        label: "対象契約番号（この明細の発注書番号。空欄なら共通の番号を使用）",
        kind: "text", optional: true, placeholder: "例: ARC-PO-2026-0002"
      },
      { key: "item_name", label: "品名・業務内容", kind: "text", placeholder: "例: 〇〇イラスト制作 一式" },
      { key: "delivery_no", label: "納品回数 (第 n 回納品)", kind: "text", placeholder: "1", initialValue: "1" },
      { key: "order_amount", label: "金額（税抜）", kind: "text", placeholder: "100000" },
      { key: "delivery_date", label: "納品日 (YYYY-MM-DD)", kind: "date", initialDays: 0 },
      { key: "inspection_deadline", label: "検収期限 (YYYY-MM-DD)", kind: "date", initialDays: 14 }
    ]
  },
  license_calc: {
    label: "計算明細",
    // V1 同様、すべて任意で送信可能（必須ゲートなし）。
    fields: [
      { key: "product_name", label: "対象製品・作品", kind: "text", placeholder: "例: ボードゲーム「〇〇」", optional: true },
      { key: "period", label: "対象期間", kind: "text", placeholder: "例: 2026年4月〜2026年6月", optional: true },
      { key: "sales", label: "販売数・売上高", kind: "text", placeholder: "例: 1,200個 / ¥1,980,000", optional: true },
      { key: "royalty_terms", label: "料率・単価", kind: "text", placeholder: "例: 料率5% / 単価100円", optional: true },
      { key: "remarks", label: "備考", kind: "text", optional: true }
    ]
  }
};

function plusDaysYmd(days: number, now: Date): string {
  return new Date(now.getTime() + days * 86400_000).toISOString().slice(0, 10);
}

function buildLineItemBlocks(type: string, index: number, now: Date): Array<Record<string, unknown>> {
  const conf = LINE_ITEM_FIELDS[type];
  if (!conf) return [];
  const blocks: Array<Record<string, unknown>> = [
    { type: "divider" },
    {
      type: "section", block_id: `li_${index}_head_block`,
      text: { type: "mrkdwn", text: `*📄 ${conf.label} ${index}*` }
    }
  ];
  for (const f of conf.fields) {
    const actionId = `li_${index}_${f.key}_input`;
    let element: Record<string, unknown>;
    if (f.kind === "date") {
      element = { type: "datepicker", action_id: actionId };
      if (typeof f.initialDays === "number") element.initial_date = plusDaysYmd(f.initialDays, now);
    } else if (f.kind === "select") {
      element = {
        type: "static_select", action_id: actionId,
        placeholder: { type: "plain_text", text: "選択してください" },
        options: (f.options ?? []).map((o) => ({
          text: { type: "plain_text", text: o.text }, value: o.value
        }))
      };
    } else if (f.kind === "radio") {
      element = {
        type: "radio_buttons", action_id: actionId,
        options: (f.options ?? []).map((o) => ({
          text: { type: "plain_text", text: o.text }, value: o.value
        }))
      };
    } else {
      element = { type: "plain_text_input", action_id: actionId };
      if (f.kind === "multiline") element.multiline = true;
      if (f.placeholder) element.placeholder = { type: "plain_text", text: f.placeholder };
      if (f.initialValue) element.initial_value = f.initialValue;
    }
    blocks.push({
      type: "input", block_id: `li_${index}_${f.key}_block`,
      optional: Boolean(f.optional),
      label: { type: "plain_text", text: f.label },
      element
    });
  }
  return blocks;
}

// 明細セクション全体（n 行分＋増減ボタン＋件数の注記）。
export function buildLineItemSectionBlocks(type: string, count: number, now = new Date()): Array<Record<string, unknown>> {
  const conf = LINE_ITEM_FIELDS[type];
  if (!conf) return [];
  const n = Math.max(1, Math.min(Number(count) || 1, LINE_ITEM_MAX));
  let blocks: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= n; i++) blocks = blocks.concat(buildLineItemBlocks(type, i, now));
  const buttons: Array<Record<string, unknown>> = [];
  if (n < LINE_ITEM_MAX) {
    buttons.push({ type: "button", action_id: LINE_ITEM_ADD_ACTION_ID, text: { type: "plain_text", text: "➕ 明細を追加" } });
  }
  if (n > 1) {
    buttons.push({ type: "button", action_id: LINE_ITEM_REMOVE_ACTION_ID, text: { type: "plain_text", text: "➖ 最後の明細を削除" } });
  }
  if (buttons.length > 0) blocks.push({ type: "actions", block_id: "li_actions_block", elements: buttons });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `明細は最大 ${LINE_ITEM_MAX} 件まで追加できます (現在 ${n} 件)。` }]
  });
  return blocks;
}

export type LineItem = Record<string, string>;

type ViewStateValues = Record<string, Record<string, {
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value?: string } | null;
}>>;

// view_submission の state.values から明細行を取り出す（空行はスキップ・V1 同様）。
export function parseLineItems(stateValues: unknown, type: string, liCount: number): LineItem[] {
  const conf = LINE_ITEM_FIELDS[type];
  if (!conf) return [];
  const values = (stateValues ?? {}) as ViewStateValues;
  const items: LineItem[] = [];
  const n = Math.min(Number(liCount) || 0, LINE_ITEM_MAX);
  for (let i = 1; i <= n; i++) {
    const item: LineItem = {};
    let hasValue = false;
    for (const f of conf.fields) {
      const el = values[`li_${i}_${f.key}_block`]?.[`li_${i}_${f.key}_input`];
      let value = "";
      if (el) {
        if (f.kind === "date") value = typeof el.selected_date === "string" ? el.selected_date : "";
        else if (f.kind === "select" || f.kind === "radio") value = el.selected_option?.value ? String(el.selected_option.value) : "";
        else value = typeof el.value === "string" ? el.value.trim() : "";
      }
      item[f.key] = value;
      if (value) hasValue = true;
    }
    if (hasValue) items.push(item);
  }
  return items;
}

// Backlog 説明文・コメント用の明細テキスト（V1 formatLineItemsText と同一書式）。
export function formatLineItemsText(type: string, items: LineItem[]): string {
  const conf = LINE_ITEM_FIELDS[type];
  if (!conf || items.length === 0) return "";
  const out: string[] = [`【${conf.label}】(${items.length} 件)`];
  items.forEach((item, idx) => {
    out.push(`■ ${conf.label} ${idx + 1}`);
    for (const f of conf.fields) {
      const raw = item[f.key];
      if (raw === null || raw === undefined || raw === "") continue;
      let display = raw;
      if ((f.kind === "radio" || f.kind === "select") && f.options) {
        for (const o of f.options) if (o.value === raw) display = o.text;
      }
      if (f.kind === "multiline") {
        out.push(`${f.label}:`);
        out.push(String(display));
      } else {
        out.push(`${f.label}: ${display}`);
      }
    }
    out.push("");
  });
  return out.join("\n");
}
