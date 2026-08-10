import type { SlackWebApiClient } from "../integrations/slack-web-api-adapter.js";
import type { BacklogWriteClient } from "../integrations/backlog-web-api.js";
import type { SlackIntakeRepository } from "./intake-repository.js";
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
  log?: (message: string) => void;
}

export interface SlackIntakeResult { status: number; body: unknown; }

export const LEGAL_REQUEST_COMMANDS = new Set(["/法務依頼", "/legal-request"]);

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
    if (!LEGAL_REQUEST_COMMANDS.has(command)) {
      return { status: 200, body: { response_type: "ephemeral", text: `未対応のコマンドです: ${command}` } };
    }
    if (!triggerId) return { status: 200, body: { response_type: "ephemeral", text: "リクエストが不正です（trigger_id なし）。" } };
    try {
      await openModal(triggerId);
      return { status: 200, body: "" };
    } catch (error) {
      log(`slack-intake: views.open failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 200, body: { response_type: "ephemeral", text: "依頼フォームを開けませんでした。時間をおいて再度お試しください。" } };
    }
  }

  async function handleInteractivity(payload: unknown): Promise<SlackIntakeResult> {
    const p = (payload ?? {}) as {
      type?: string;
      user?: { id?: string };
      view?: { callback_id?: string; state?: { values?: unknown } };
    };
    if (p.type !== "view_submission" || p.view?.callback_id !== LEGAL_REQUEST_CALLBACK_ID) {
      return { status: 200, body: "" };   // block_actions 等は 16-3a では無視（静的モーダル）
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
