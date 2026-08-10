import type { SlackWebApiClient } from "../integrations/slack-web-api-adapter.js";
import type { BacklogWriteClient } from "../integrations/backlog-web-api.js";
import type { SlackIntakeRepository } from "./intake-repository.js";
import type { ContractCheckRepository, VendorCandidate } from "../contract-check/repository.js";
import {
  findPurpose, buildMasterContractSummary, buildLicenseConditions, buildPublicationConditions,
  buildPurposeResult, buildSuggestedAction, notFoundResult
} from "../contract-check/engine.js";
import {
  LEGAL_SEARCH_CALLBACK_ID, SEARCH_AGAIN_ACTION_ID, buildLegalSearchModal, parseSearchKeyword,
  buildSearchResultsModal, backlogSearchUrl, type SearchOutcome
} from "./search-modal.js";
import {
  LEGAL_REQUEST_CALLBACK_ID, buildLegalRequestModal, parseLegalRequestSubmission,
  buildCompletionView, buildErrorView, backlogIssueTypeFor, requestTypeLabel,
  type LegalRequestSubmission
} from "./modal.js";

// /法務依頼 の受付処理（Phase 16-3a）。V1 slackGateway + worker processLegalRequestSubmission の
// 第1スライス移植。Backlog 起票＋DB 書込は view_submission 応答前に同期実行（Slack の 3 秒以内・
// min-instances 前提は V1 と同じ）。通知はベストエフォート（応答後・失敗しても受付は成立）。
// Backlog 未接続（adapter 無し）は dry-run＝隔離台帳のみ記録し、共有表・起票は行わない。

export interface SlackIntakeHandlerOptions {
  repository: SlackIntakeRepository;
  slack: SlackWebApiClient;
  backlog?: BacklogWriteClient | null;
  backlogHost?: string | null;
  backlogProjectKey?: string | null;
  // /法務検索（16-3b）。未注入なら検索コマンドは「利用不可」応答。
  contractCheck?: ContractCheckRepository | null;
  log?: (message: string) => void;
}

export interface SlackIntakeResult { status: number; body: unknown; }

export const LEGAL_REQUEST_COMMANDS = new Set(["/法務依頼", "/legal-request"]);
export const LEGAL_SEARCH_COMMANDS = new Set(["/法務検索", "/legal-search"]);

function issueUrl(host: string | null | undefined, issueKey: string): string | null {
  const h = String(host ?? "").trim();
  return h ? `https://${h}/view/${issueKey}` : null;
}

// V1 worker（server.ts:2427）に準拠した課題説明文。
export function buildIssueDescription(s: LegalRequestSubmission, requesterEmail: string | null): string {
  const lines = [
    `■ 依頼種別: ${requestTypeLabel(s.requestType)}`,
    `■ 件名: ${s.summary}`,
    `■ 希望納期: ${s.deadline}`,
    s.counterparty ? `■ 相手方: ${s.counterparty}${s.entityType === "individual" ? "（個人）" : ""}` : null,
    s.entityId ? `■ 法人番号/個人コード: ${s.entityId}` : null,
    requesterEmail ? `■ 依頼者: ${requesterEmail}` : null,
    "",
    "■ 相談・依頼詳細:",
    s.details,
    "",
    "（Slack /法務依頼 から自動起票・LegalBridge V2）"
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export function createSlackIntakeHandler(options: SlackIntakeHandlerOptions) {
  const log = options.log ?? (() => undefined);

  async function openModal(triggerId: string): Promise<void> {
    await options.slack.post("views.open", { trigger_id: triggerId, view: buildLegalRequestModal() });
  }

  // 依頼者DM＋部署チャンネル通知（ベストエフォート）。
  async function notify(slackUserId: string, issueKey: string | null, s: LegalRequestSubmission): Promise<void> {
    const link = issueKey ? issueUrl(options.backlogHost, issueKey) : null;
    const keyText = issueKey ? (link ? `<${link}|${issueKey}>` : issueKey) : "（採番なし）";
    const text = [
      "🆕 *新規依頼を受け付けました*",
      `*課題:* ${keyText}`,
      `*種別:* ${requestTypeLabel(s.requestType)}`,
      s.counterparty ? `*相手方:* ${s.counterparty}` : null,
      `*概要:* ${s.summary}`
    ].filter(Boolean).join("\n");
    try {
      const opened = await options.slack.post("conversations.open", { users: slackUserId }) as
        { ok?: boolean; channel?: { id?: string } };
      if (opened?.ok && opened.channel?.id) {
        await options.slack.post("chat.postMessage", { channel: opened.channel.id, text });
      }
    } catch (error) {
      log(`slack-intake: requester DM failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const staff = await options.repository.staffBySlackId(slackUserId);
      const channel = await options.repository.departmentChannel(staff?.department ?? null);
      if (channel) {
        await options.slack.post("chat.postMessage", {
          channel, text: `<@${slackUserId}> さんの依頼の通知です\n${text}`
        });
      }
    } catch (error) {
      log(`slack-intake: department channel post failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleCommand(body: Record<string, string | undefined>): Promise<SlackIntakeResult> {
    const command = String(body.command ?? "").trim();
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { status: 200, body: { response_type: "ephemeral", text: "リクエストが不正です（trigger_id なし）。" } };
    if (LEGAL_SEARCH_COMMANDS.has(command)) {
      if (!options.contractCheck) {
        return { status: 200, body: { response_type: "ephemeral", text: "法務検索は現在利用できません。" } };
      }
      try {
        await options.slack.post("views.open", {
          trigger_id: triggerId, view: buildLegalSearchModal(String(body.text ?? ""))
        });
        return { status: 200, body: "" };
      } catch (error) {
        log(`slack-intake: search views.open failed: ${error instanceof Error ? error.message : String(error)}`);
        return { status: 200, body: { response_type: "ephemeral", text: "検索フォームを開けませんでした。時間をおいて再度お試しください。" } };
      }
    }
    if (!LEGAL_REQUEST_COMMANDS.has(command)) {
      return { status: 200, body: { response_type: "ephemeral", text: `未対応のコマンドです: ${command}` } };
    }
    try {
      await openModal(triggerId);
      return { status: 200, body: "" };
    } catch (error) {
      log(`slack-intake: views.open failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 200, body: { response_type: "ephemeral", text: "依頼フォームを開けませんでした。時間をおいて再度お試しください。" } };
    }
  }

  // 契約チェックエンジンで1候補分の表示データを組む（用途未選択＝契約状況のみ表示）。
  async function searchOne(repo: ContractCheckRepository, vendor: VendorCandidate) {
    const docs = await repo.findVendorDocuments(vendor.id);
    const masterContracts = buildMasterContractSummary(docs);
    const purposeResult = buildPurposeResult({}, masterContracts, findPurpose(""));
    return {
      counterparty: {
        vendorId: vendor.id, vendorCode: vendor.vendorCode ?? "",
        vendorName: vendor.vendorName ?? "", entityType: vendor.entityType ?? ""
      },
      masterContracts,
      licenseConditions: buildLicenseConditions(docs),
      publicationConditions: buildPublicationConditions(docs),
      purposeResult,
      suggestedAction: buildSuggestedAction(purposeResult)
    };
  }

  async function handleSearchSubmission(keyword: string): Promise<SlackIntakeResult> {
    const repo = options.contractCheck;
    if (!repo) {
      return { status: 200, body: { response_action: "update", view: buildErrorView("法務検索は現在利用できません。") } };
    }
    if (!keyword) {
      return { status: 200, body: { response_action: "errors", errors: { keyword_block: "キーワードを入力してください" } } };
    }
    try {
      const candidates = await repo.searchVendors(keyword, 10);
      const outcome: SearchOutcome = { keyword };
      if (candidates.length === 0) {
        outcome.notFound = notFoundResult(null) as unknown as NonNullable<SearchOutcome["notFound"]>;
      } else if (candidates.length === 1) {
        outcome.single = await searchOne(repo, candidates[0]);
      } else {
        outcome.multiple = {
          count: candidates.length,
          results: await Promise.all(candidates.slice(0, 5).map((c) => searchOne(repo, c)))
        };
      }
      const url = backlogSearchUrl(options.backlogHost, options.backlogProjectKey, keyword);
      return { status: 200, body: { response_action: "update", view: buildSearchResultsModal(outcome, url) } };
    } catch (error) {
      log(`slack-intake: search failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 200, body: { response_action: "update", view: buildErrorView("検索処理中にエラーが発生しました。") } };
    }
  }

  async function handleInteractivity(payload: unknown): Promise<SlackIntakeResult> {
    const p = (payload ?? {}) as {
      type?: string;
      user?: { id?: string };
      view?: { id?: string; callback_id?: string; state?: { values?: unknown } };
      actions?: Array<{ action_id?: string }>;
    };
    // 検索結果モーダルの「検索し直す」→ 入力モーダルへ views.update（16-3b）。
    if (p.type === "block_actions") {
      if (p.actions?.some((a) => a.action_id === SEARCH_AGAIN_ACTION_ID) && p.view?.id) {
        try {
          await options.slack.post("views.update", { view_id: p.view.id, view: buildLegalSearchModal() });
        } catch (error) {
          log(`slack-intake: views.update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { status: 200, body: "" };   // リンクボタン等その他の block_actions は無視
    }
    if (p.type === "view_submission" && p.view?.callback_id === LEGAL_SEARCH_CALLBACK_ID) {
      return handleSearchSubmission(parseSearchKeyword(p.view?.state?.values));
    }
    if (p.type !== "view_submission" || p.view?.callback_id !== LEGAL_REQUEST_CALLBACK_ID) {
      return { status: 200, body: "" };
    }
    const slackUserId = String(p.user?.id ?? "");
    const { submission, errors } = parseLegalRequestSubmission(p.view?.state?.values);
    if (Object.keys(errors).length > 0) {
      return { status: 200, body: { response_action: "errors", errors } };
    }

    const notesBody = JSON.stringify({
      deadline: submission.deadline, details: submission.details,
      entityType: submission.entityType || null, entityId: submission.entityId || null
    });

    // dry-run（Backlog 未接続）：隔離台帳のみ・共有表は触らない。
    if (!options.backlog) {
      try {
        await options.repository.ledger({
          slackUserId, requestType: submission.requestType, summary: submission.summary,
          backlogIssueKey: null, mode: "dry-run", payload: submission
        });
      } catch (error) {
        log(`slack-intake: dry-run ledger failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: null, requestTypeLabel: requestTypeLabel(submission.requestType),
            summary: submission.summary, dryRun: true
          })
        }
      };
    }

    try {
      const staff = await options.repository.staffBySlackId(slackUserId);
      const created = await options.backlog.createIssue({
        summary: `【${requestTypeLabel(submission.requestType)}】${submission.summary}`,
        description: buildIssueDescription(submission, staff?.email ?? null),
        issueTypeName: backlogIssueTypeFor(submission.requestType)
      });
      await options.repository.recordRequest({
        backlogIssueKey: created.issueKey,
        slackUserId,
        requestType: submission.requestType,
        counterparty: submission.counterparty || null,
        summary: submission.summary,
        notes: notesBody
      });
      await options.repository.ledger({
        slackUserId, requestType: submission.requestType, summary: submission.summary,
        backlogIssueKey: created.issueKey, mode: "live", payload: submission
      });
      // 通知は応答後のベストエフォート（CPU スロットリングで遅延しうるが受付は成立済み）。
      void notify(slackUserId, created.issueKey, submission);
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: created.issueKey, requestTypeLabel: requestTypeLabel(submission.requestType),
            summary: submission.summary, dryRun: false
          })
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`slack-intake: submission failed: ${message}`);
      const friendly = (error as { code?: string })?.code === "42501"
        ? "書込権限が未設定です（管理者にお問い合わせください）。"
        : "処理中にエラーが発生しました。";
      return { status: 200, body: { response_action: "update", view: buildErrorView(friendly) } };
    }
  }

  return { handleCommand, handleInteractivity };
}
