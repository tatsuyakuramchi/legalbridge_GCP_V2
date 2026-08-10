// /法務検索 モーダル（Phase 16-3b・純粋モジュール）。V1 slackGateway の legal_search_modal を移植し、
// 検索本体は 16-2 の契約チェックエンジンを同プロセスで呼ぶ（V1 現行世代と同じ構成・REST ホップなし）。
// 非移植：チャンネル許可リスト（後続で opt-in）・署名URL「Webで詳細」リンク（ポータル廃止判断待ち）。

import type { MasterContracts, PurposeResult } from "../contract-check/engine.js";

export const LEGAL_SEARCH_CALLBACK_ID = "legal_search_modal";
export const SEARCH_AGAIN_ACTION_ID = "legal_search_again";

export function buildLegalSearchModal(prefill = ""): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: LEGAL_SEARCH_CALLBACK_ID,
    title: { type: "plain_text", text: "法務検索" },
    submit: { type: "plain_text", text: "検索" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input", block_id: "keyword_block",
        label: { type: "plain_text", text: "取引先名・キーワード" },
        element: {
          type: "plain_text_input", action_id: "keyword_input", max_length: 200,
          ...(prefill.trim() ? { initial_value: prefill.trim() } : {}),
          placeholder: { type: "plain_text", text: "例: アークライト" }
        }
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "取引先名（正式名称・通称・ペンネーム）で契約締結状況を検索します。" }]
      }
    ]
  };
}

export function parseSearchKeyword(stateValues: unknown): string {
  const values = (stateValues ?? {}) as Record<string, Record<string, { value?: string | null }>>;
  return String(values?.keyword_block?.keyword_input?.value ?? "").trim();
}

// 業務委託／ライセンス／出版 の締結ピル（V1 の候補表示と同じ語彙）。
export function masterPills(master: MasterContracts): string {
  const pill = (label: string, s: { exists: boolean; label: string }) =>
    `${label} ${s.exists ? `✅${s.label}` : "—未締結"}`;
  return [pill("業務委託", master.service), pill("ライセンス", master.license), pill("出版", master.publication)].join(" ／ ");
}

interface SingleResult {
  counterparty: { vendorId: number; vendorCode: string; vendorName: string; entityType: string } | null;
  masterContracts: MasterContracts | null;
  licenseConditions: unknown[];
  publicationConditions: unknown[];
  purposeResult: PurposeResult;
  suggestedAction: { message: string };
}
export interface SearchOutcome {
  keyword: string;
  single?: SingleResult;
  multiple?: { count: number; results: SingleResult[] };
  notFound?: SingleResult;
}

function vendorSection(r: SingleResult): Array<Record<string, unknown>> {
  if (!r.counterparty || !r.masterContracts) return [];
  const name = `*${r.counterparty.vendorName}*${r.counterparty.vendorCode ? `（${r.counterparty.vendorCode}）` : ""}`;
  const counts = `個別許諾 ${r.licenseConditions.length}件 ／ 出版条件 ${r.publicationConditions.length}件`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `${name}\n${masterPills(r.masterContracts)}\n${counts}` } }
  ];
}

export function buildSearchResultsModal(outcome: SearchOutcome, backlogSearchUrl: string | null): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [];
  if (outcome.notFound) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `「${outcome.keyword}」に該当する取引先が見つかりませんでした。` } },
      { type: "context", elements: [{ type: "mrkdwn", text: outcome.notFound.suggestedAction.message }] }
    );
  } else if (outcome.multiple) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `複数の取引先候補が見つかりました（${outcome.multiple.count}件）。` }
    });
    for (const r of outcome.multiple.results) blocks.push(...vendorSection(r));
  } else if (outcome.single) {
    blocks.push(...vendorSection(outcome.single));
    if (outcome.single.purposeResult.selected) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*判定:* ${outcome.single.purposeResult.judgmentLabel}\n${outcome.single.purposeResult.reasonSummary}` }
      });
    }
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: outcome.single.suggestedAction.message }] });
  }

  const actionElements: Array<Record<string, unknown>> = [{
    type: "button", action_id: SEARCH_AGAIN_ACTION_ID,
    text: { type: "plain_text", text: "🔎 検索し直す" }
  }];
  if (backlogSearchUrl) {
    actionElements.push({
      type: "button", action_id: "legal_search_backlog",
      text: { type: "plain_text", text: "🔗 Backlogで関連課題を検索" }, url: backlogSearchUrl
    });
  }
  blocks.push({ type: "actions", block_id: "legal_search_actions", elements: actionElements });

  return {
    type: "modal",
    callback_id: LEGAL_SEARCH_CALLBACK_ID,   // 再検索の view_submission も同じ受け口で処理
    title: { type: "plain_text", text: "法務検索 結果" },
    close: { type: "plain_text", text: "閉じる" },
    blocks
  };
}

export function backlogSearchUrl(host: string | null | undefined, projectKey: string | null | undefined, keyword: string): string | null {
  const h = String(host ?? "").trim();
  const k = String(projectKey ?? "").trim();
  if (!h || !k) return null;
  return `https://${h}/find/${encodeURIComponent(k)}?simpleSearch=true&keyword=${encodeURIComponent(keyword)}`;
}
