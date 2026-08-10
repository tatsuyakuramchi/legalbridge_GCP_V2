// /法務依頼 モーダル（Phase 16-3a・純粋モジュール）。V1 slackGateway の getLegalRequestModal を
// 第1スライス範囲（共通4項目＋相手方3項目）で移植する。明細行（最大5行）・既存課題への紐付け・
// 納期変更・署名URLアップロードリンクは後続スライス（16-3b〜）。

export const LEGAL_REQUEST_CALLBACK_ID = "legal_request_modal";

// 依頼種別（V1 と同一の値・表示名）。deadline_change は別モーダルのため 16-3a では除外。
export const REQUEST_TYPES: Array<{ value: string; label: string; backlogIssueType: string }> = [
  { value: "legal_consult", label: "法務相談", backlogIssueType: "法務相談" },
  { value: "nda", label: "NDA（秘密保持契約）", backlogIssueType: "NDA" },
  { value: "outsourcing", label: "業務委託基本契約", backlogIssueType: "業務委託基本契約" },
  { value: "license_master", label: "ライセンス契約", backlogIssueType: "ライセンス契約" },
  { value: "lic_individual", label: "個別利用許諾条件", backlogIssueType: "個別利用許諾条件" },
  { value: "sales_master", label: "売買契約（当社買手）", backlogIssueType: "売買契約（当社買手）" },
  { value: "purchase_order", label: "発注書", backlogIssueType: "発注書" },
  { value: "delivery_inspec", label: "納品・検収", backlogIssueType: "納品リクエスト" },
  { value: "license_calc", label: "利用許諾料計算（売上報告）", backlogIssueType: "売上報告案件" }
];

export function backlogIssueTypeFor(requestType: string): string {
  return REQUEST_TYPES.find((t) => t.value === requestType)?.backlogIssueType ?? "法務相談";
}

function plusDaysYmd(days: number, now: Date): string {
  const d = new Date(now.getTime() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

// Slack Block Kit のモーダル定義（views.open へそのまま渡す）。
export function buildLegalRequestModal(now = new Date()): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: LEGAL_REQUEST_CALLBACK_ID,
    title: { type: "plain_text", text: "法務依頼" },
    submit: { type: "plain_text", text: "送信" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input", block_id: "request_type_block",
        label: { type: "plain_text", text: "依頼種別" },
        element: {
          type: "static_select", action_id: "request_type_input",
          placeholder: { type: "plain_text", text: "種別を選択" },
          options: REQUEST_TYPES.map((t) => ({
            text: { type: "plain_text", text: t.label }, value: t.value
          }))
        }
      },
      {
        type: "input", block_id: "summary_block",
        label: { type: "plain_text", text: "件名" },
        element: { type: "plain_text_input", action_id: "summary_input", max_length: 200 }
      },
      {
        type: "input", block_id: "deadline_block",
        label: { type: "plain_text", text: "希望納期（文書作成等）" },
        element: {
          type: "datepicker", action_id: "deadline_input",
          initial_date: plusDaysYmd(7, now)
        }
      },
      {
        type: "input", block_id: "details_block",
        label: { type: "plain_text", text: "相談・依頼詳細" },
        element: { type: "plain_text_input", action_id: "details_input", multiline: true, max_length: 3000 }
      },
      {
        type: "input", block_id: "counterparty_block", optional: true,
        label: { type: "plain_text", text: "相手方名称" },
        element: { type: "plain_text_input", action_id: "counterparty_input", max_length: 200 }
      },
      {
        type: "input", block_id: "entity_type_block", optional: true,
        label: { type: "plain_text", text: "相手方区分" },
        element: {
          type: "radio_buttons", action_id: "entity_type_input",
          initial_option: { text: { type: "plain_text", text: "法人" }, value: "corporate" },
          options: [
            { text: { type: "plain_text", text: "法人" }, value: "corporate" },
            { text: { type: "plain_text", text: "個人" }, value: "individual" }
          ]
        }
      },
      {
        type: "input", block_id: "entity_id_block", optional: true,
        label: { type: "plain_text", text: "法人番号／社内個人コード" },
        element: { type: "plain_text_input", action_id: "entity_id_input", max_length: 50 }
      }
    ]
  };
}

export interface LegalRequestSubmission {
  requestType: string;
  summary: string;
  deadline: string;          // YYYY-MM-DD
  details: string;
  counterparty: string;      // 空可
  entityType: string;        // corporate | individual | ""
  entityId: string;          // 空可
}

type ViewStateValues = Record<string, Record<string, {
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value?: string } | null;
}>>;

function pick(values: ViewStateValues, block: string, action: string): string {
  const el = values?.[block]?.[action];
  if (!el) return "";
  if (typeof el.value === "string") return el.value.trim();
  if (typeof el.selected_date === "string") return el.selected_date;
  if (el.selected_option?.value) return String(el.selected_option.value);
  return "";
}

// view_submission の state.values から入力を取り出す。バリデーションは
// { blockId: メッセージ } を返す（Slack の response_action:"errors" 形式に対応）。
export function parseLegalRequestSubmission(stateValues: unknown): {
  submission: LegalRequestSubmission; errors: Record<string, string>;
} {
  const values = (stateValues ?? {}) as ViewStateValues;
  const submission: LegalRequestSubmission = {
    requestType: pick(values, "request_type_block", "request_type_input"),
    summary: pick(values, "summary_block", "summary_input"),
    deadline: pick(values, "deadline_block", "deadline_input"),
    details: pick(values, "details_block", "details_input"),
    counterparty: pick(values, "counterparty_block", "counterparty_input"),
    entityType: pick(values, "entity_type_block", "entity_type_input"),
    entityId: pick(values, "entity_id_block", "entity_id_input")
  };
  const errors: Record<string, string> = {};
  if (!REQUEST_TYPES.some((t) => t.value === submission.requestType)) {
    errors.request_type_block = "依頼種別を選択してください";
  }
  if (!submission.summary) errors.summary_block = "件名を入力してください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(submission.deadline)) errors.deadline_block = "希望納期を選択してください";
  if (!submission.details) errors.details_block = "相談・依頼詳細を入力してください";
  return { submission, errors };
}

// 受付完了ビュー（response_action:"update" で差し替える）。
export function buildCompletionView(input: {
  issueKey: string | null; requestTypeLabel: string; summary: string; dryRun: boolean;
}): Record<string, unknown> {
  const lines = [
    input.issueKey ? `*課題番号:* ${input.issueKey}` : "*課題番号:* （Backlog未接続のため採番なし）",
    `*依頼種別:* ${input.requestTypeLabel}`,
    `*件名:* ${input.summary}`
  ];
  return {
    type: "modal",
    title: { type: "plain_text", text: "法務依頼" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "✅ *依頼を受け付けました*" } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ...(input.dryRun
        ? [{ type: "context", elements: [{ type: "mrkdwn", text: "※検証モード（dry-run）：記録のみ行い、課題起票は行っていません。" }] }]
        : [])
    ]
  };
}

export function buildErrorView(message: string): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: "法務依頼" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `⚠️ 依頼を受け付けられませんでした。\n${message}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "お手数ですが、時間をおいて再度お試しください。解決しない場合は法務部までご連絡ください。" }] }
    ]
  };
}

export function requestTypeLabel(value: string): string {
  return REQUEST_TYPES.find((t) => t.value === value)?.label ?? value;
}
