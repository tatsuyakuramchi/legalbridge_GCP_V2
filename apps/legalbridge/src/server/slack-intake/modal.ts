// /法務依頼 モーダル（Phase 16-3a → 16-3c で動的化・純粋モジュール）。V1 slackGateway の
// getLegalRequestModal を移植。依頼種別の dispatch_action で views.update による再構築を行い、
// 明細行（最大5行）・既存課題への紐付け候補・納期変更フォームを種別に応じて出し分ける。
// 署名URLアップロードリンク（ポータル）は非移植（廃止判断待ち）。

import {
  LINE_ITEM_FIELDS, LINE_ITEM_MAX, buildLineItemSectionBlocks, parseLineItems,
  type LineItem
} from "./line-items.js";

export const LEGAL_REQUEST_CALLBACK_ID = "legal_request_modal";
export const REQUEST_TYPE_ACTION_ID = "request_type_input";
export const DEADLINE_CHANGE_TYPE = "deadline_change";
// 候補セレクタの「新規作成」値（V1 と同一）。
export const NEW_ISSUE_VALUE = "__NEW__";

// 依頼種別（V1 と同一の値・表示名）。deadline_change は新規課題を起こさない別フォーム。
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

// セレクタに出す選択肢（依頼種別＋納期変更依頼）。
const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  ...REQUEST_TYPES.map((t) => ({ value: t.value, label: t.label })),
  { value: DEADLINE_CHANGE_TYPE, label: "納期変更依頼" }
];

export function backlogIssueTypeFor(requestType: string): string {
  return REQUEST_TYPES.find((t) => t.value === requestType)?.backlogIssueType ?? "法務相談";
}

export function requestTypeLabel(value: string): string {
  return TYPE_OPTIONS.find((t) => t.value === value)?.label ?? value;
}

// 紐付け・納期変更の候補（申請者の未完了依頼）。
export interface IntakeCandidate {
  issueKey: string;
  summary: string | null;
  counterparty: string | null;
}

function plusDaysYmd(days: number, now: Date): string {
  const d = new Date(now.getTime() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

function candidateOption(c: IntakeCandidate): Record<string, unknown> {
  let label = `[${c.issueKey}] ${(c.summary ?? "").slice(0, 60)}`;
  if (c.counterparty) label += ` / ${c.counterparty.slice(0, 20)}`;
  return { text: { type: "plain_text", text: label.slice(0, 75) }, value: c.issueKey };
}

export interface LegalRequestModalOptions {
  selectedType?: string;
  candidates?: IntakeCandidate[];
  liCount?: number;
  now?: Date;
}

// Slack Block Kit のモーダル定義（views.open / views.update へそのまま渡す）。
export function buildLegalRequestModal(options: LegalRequestModalOptions = {}): Record<string, unknown> {
  const now = options.now ?? new Date();
  const selectedType = TYPE_OPTIONS.some((t) => t.value === options.selectedType)
    ? String(options.selectedType) : "legal_consult";
  const candidates = options.candidates ?? [];
  const liCount = Math.max(1, Math.min(Number(options.liCount) || 1, LINE_ITEM_MAX));

  const typeBlock = {
    type: "input", block_id: "request_type_block",
    label: { type: "plain_text", text: "依頼種別" },
    // 種別変更で block_actions を飛ばし、views.update でフォームを組み替える（16-3c）。
    dispatch_action: true,
    element: {
      type: "static_select", action_id: REQUEST_TYPE_ACTION_ID,
      placeholder: { type: "plain_text", text: "種別を選択" },
      initial_option: {
        text: { type: "plain_text", text: requestTypeLabel(selectedType) }, value: selectedType
      },
      options: TYPE_OPTIONS.map((t) => ({
        text: { type: "plain_text", text: t.label }, value: t.value
      }))
    }
  };

  // ── 納期変更依頼（新規課題を起こさない別フォーム・V1 同様） ──
  if (selectedType === DEADLINE_CHANGE_TYPE) {
    const blocks: Array<Record<string, unknown>> = [
      typeBlock,
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text:
            "⚠️ *この依頼は新規の作業課題を作成しません。* 指定した課題の納期変更を法務へ申請します。" +
            "法務担当者が内容を確認・承認した後に変更が実行されます。"
        }]
      }
    ];
    if (candidates.length > 0) {
      blocks.push({
        type: "input", block_id: "target_issue_key_select_block", optional: true,
        label: { type: "plain_text", text: "対象 Backlog 課題 (候補から選択)" },
        element: {
          type: "static_select", action_id: "target_issue_key_select_input",
          placeholder: { type: "plain_text", text: "未完了の依頼から選択…" },
          options: candidates.slice(0, 25).map(candidateOption)
        }
      });
    }
    blocks.push(
      {
        type: "input", block_id: "target_issue_key_block", optional: candidates.length > 0,
        label: { type: "plain_text", text: "対象 Backlog 課題キー (候補にない場合のみ入力)" },
        element: {
          type: "plain_text_input", action_id: "target_issue_key_input",
          placeholder: { type: "plain_text", text: "LEGAL-123" }
        }
      },
      {
        type: "input", block_id: "new_delivery_date_block",
        label: { type: "plain_text", text: "新しい納期" },
        element: {
          type: "datepicker", action_id: "new_delivery_date_input",
          initial_date: plusDaysYmd(1, now)
        }
      },
      {
        type: "input", block_id: "change_reason_block",
        label: { type: "plain_text", text: "変更理由" },
        element: {
          type: "plain_text_input", action_id: "change_reason_input", multiline: true,
          placeholder: { type: "plain_text", text: "例: 仕様変更により制作期間が必要なため" }
        }
      }
    );
    return {
      type: "modal", callback_id: LEGAL_REQUEST_CALLBACK_ID,
      title: { type: "plain_text", text: "納期変更依頼" },
      submit: { type: "plain_text", text: "送信" },
      close: { type: "plain_text", text: "キャンセル" },
      private_metadata: JSON.stringify({ li_count: 0 }),
      blocks
    };
  }

  // ── 通常（新規依頼）フォーム ──
  const blocks: Array<Record<string, unknown>> = [typeBlock];

  // 検収書・計算書は既存の未完了依頼へ紐付けられる（候補があるときのみセレクタを出す・V1 同様）。
  const linkable = selectedType === "delivery_inspec" || selectedType === "license_calc";
  if (linkable && candidates.length > 0) {
    blocks.push(
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text:
            "💡 *候補が見つかりました*。下のセレクタで該当する課題を選択すると、" +
            "新規課題は作成されず、既存の課題に紐付けて受け付けます。" +
            "該当課題が見つからない場合は「新規作成」を選択してください。"
        }]
      },
      {
        type: "input", block_id: "target_issue_key_select_block",
        label: { type: "plain_text", text: "対象課題 (候補から選択)" },
        element: {
          type: "static_select", action_id: "target_issue_key_select_input",
          placeholder: { type: "plain_text", text: "選択してください" },
          options: [
            { text: { type: "plain_text", text: "🆕 新規作成 (該当課題なし)" }, value: NEW_ISSUE_VALUE },
            ...candidates.slice(0, 24).map(candidateOption)
          ]
        }
      }
    );
  }

  blocks.push(
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
    }
  );

  if (linkable) {
    // 検収書・計算書は取引先手入力の代わりに契約番号で特定する（V1 同様）。
    blocks.push(
      { type: "divider" },
      {
        type: "input", block_id: "target_doc_number_block", optional: true,
        label: { type: "plain_text", text: "対象の発注書番号 / 契約書番号" },
        element: {
          type: "plain_text_input", action_id: "target_doc_number_input",
          placeholder: { type: "plain_text", text: "例: ARC-PO-2026-0001" }
        }
      },
      {
        type: "context", block_id: "target_doc_number_help_block",
        elements: [{
          type: "mrkdwn",
          text:
            "🔎 取引先は契約から自動で特定されます。上の候補から選択した場合、番号の入力は不要です。" +
            (selectedType === "delivery_inspec"
              ? " 明細ごとに契約が異なる場合は、各明細の「対象契約番号」に入力してください（空欄の明細はこの共通番号を使用）。"
              : "")
        }]
      }
    );
  } else {
    blocks.push(
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
    );
  }

  blocks.push({
    type: "input", block_id: "details_block",
    label: { type: "plain_text", text: "相談・依頼詳細" },
    element: { type: "plain_text_input", action_id: "details_input", multiline: true, max_length: 3000 }
  });

  const hasLineItems = Boolean(LINE_ITEM_FIELDS[selectedType]);
  const finalBlocks = hasLineItems
    ? blocks.concat(buildLineItemSectionBlocks(selectedType, liCount, now))
    : blocks;

  return {
    type: "modal",
    callback_id: LEGAL_REQUEST_CALLBACK_ID,
    title: { type: "plain_text", text: "法務依頼" },
    submit: { type: "plain_text", text: "送信" },
    close: { type: "plain_text", text: "キャンセル" },
    private_metadata: JSON.stringify({ li_count: hasLineItems ? liCount : 0 }),
    blocks: finalBlocks
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
  // 16-3c 追加分
  lineItems: LineItem[];
  targetIssueKeySelect: string;   // 候補セレクタの値（__NEW__ / 課題キー / ""）
  targetDocNumber: string;        // 検収書・計算書の共通契約番号
  targetIssueKey: string;         // 納期変更の対象課題キー（自由入力）
  newDeliveryDate: string;        // 納期変更の新日付
  changeReason: string;           // 納期変更の理由
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

function liCountFrom(privateMetadata: string | undefined): number {
  try {
    const meta = JSON.parse(privateMetadata || "{}") as { li_count?: unknown };
    return Math.min(Number(meta.li_count) || 0, LINE_ITEM_MAX);
  } catch { return 0; }
}

// view_submission の state.values から入力を取り出す。バリデーションは
// { blockId: メッセージ } を返す（Slack の response_action:"errors" 形式に対応）。
export function parseLegalRequestSubmission(stateValues: unknown, privateMetadata?: string): {
  submission: LegalRequestSubmission; errors: Record<string, string>;
} {
  const values = (stateValues ?? {}) as ViewStateValues;
  const requestType = pick(values, "request_type_block", "request_type_input");
  const submission: LegalRequestSubmission = {
    requestType,
    summary: pick(values, "summary_block", "summary_input"),
    deadline: pick(values, "deadline_block", "deadline_input"),
    details: pick(values, "details_block", "details_input"),
    counterparty: pick(values, "counterparty_block", "counterparty_input"),
    entityType: pick(values, "entity_type_block", "entity_type_input"),
    entityId: pick(values, "entity_id_block", "entity_id_input"),
    lineItems: parseLineItems(values, requestType, liCountFrom(privateMetadata)),
    targetIssueKeySelect: pick(values, "target_issue_key_select_block", "target_issue_key_select_input"),
    targetDocNumber: pick(values, "target_doc_number_block", "target_doc_number_input"),
    targetIssueKey: pick(values, "target_issue_key_block", "target_issue_key_input"),
    newDeliveryDate: pick(values, "new_delivery_date_block", "new_delivery_date_input"),
    changeReason: pick(values, "change_reason_block", "change_reason_input")
  };
  const errors: Record<string, string> = {};

  // ── 納期変更依頼（別フォーム・V1 同様の検証） ──
  if (requestType === DEADLINE_CHANGE_TYPE) {
    if (submission.targetIssueKeySelect && submission.targetIssueKeySelect !== NEW_ISSUE_VALUE) {
      submission.targetIssueKey = submission.targetIssueKeySelect;
    }
    const key = submission.targetIssueKey.trim().toUpperCase();
    submission.targetIssueKey = key;
    if (!key) {
      errors.target_issue_key_block = "対象 Backlog 課題キーを入力するか、上の候補から選択してください。";
    } else if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
      errors.target_issue_key_block = "課題キーの形式が不正です (例: LEGAL-123)。";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(submission.newDeliveryDate)) {
      errors.new_delivery_date_block = "新しい納期を指定してください。";
    }
    if (!submission.changeReason) {
      errors.change_reason_block = "変更理由を入力してください。";
    }
    return { submission, errors };
  }

  if (!REQUEST_TYPES.some((t) => t.value === requestType)) {
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
  heading?: string; noteLines?: string[];
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
      { type: "section", text: { type: "mrkdwn", text: `✅ *${input.heading ?? "依頼を受け付けました"}*` } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ...(input.noteLines?.length
        ? [{ type: "context", elements: input.noteLines.map((text) => ({ type: "mrkdwn", text })) }]
        : []),
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
