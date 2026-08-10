import type { WebhookHandler } from "../internal/webhooks-routes.js";
import type { WebhookReceiptsRepository } from "../internal/webhook-receipts-repository.js";
import {
  parseCloudSignEvent, parseBacklogIssueCreated, parseBacklogStatusChanged,
  BACKLOG_ISSUE_TYPE_TO_REQUEST_TYPE, extractSlackMention
} from "../internal/webhook-parsers.js";
import type { CloudSignRequestRepository } from "./cloudsign-request-repository.js";
import type { ContractStatusWriter } from "../documents/contract-status-writer.js";
import type { SlackIntakeRepository } from "../slack-intake/intake-repository.js";

// 外部 Webhook ハンドラ（Phase 9-5 CloudSign / 9-7 Backlog）。共通方針：
//   - untrusted ペイロードは純関数パーサで型安全に抽出。判別不能は 200 skip（再送を誘発しない）。
//   - (source, external_id) でべき等化。既出は 200 skip。
//   - 副作用は初回のみ。権限未整備の本番更新は forbidden で返し受信自体は成功扱い。

export function createCloudSignWebhookHandler(deps: {
  receipts: WebhookReceiptsRepository;
  requests: CloudSignRequestRepository;
  contract: ContractStatusWriter;
}): WebhookHandler {
  return async (payload) => {
    const ev = parseCloudSignEvent(payload);
    if (!ev) return { status: 200, body: { ok: true, skipped: "unparseable" } };
    const first = await deps.receipts.recordIfFirst("cloudsign", `${ev.cloudSignDocumentId}:${ev.status}`, { status: ev.status });
    if (!first) return { status: 200, body: { ok: true, skipped: "duplicate" } };
    const normalized = ev.status === "completed" ? "completed"
      : ev.status === "declined" ? "canceled"
      : ev.status === "sent" ? "sent" : "other";
    const record = await deps.requests.updateStatus(ev.cloudSignDocumentId, normalized);
    if (!record) return { status: 200, body: { ok: true, skipped: "unknown document", status: normalized } };
    let contractExecuted = 0;
    let contractForbidden = false;
    if (ev.status === "completed") {
      const res = await deps.contract.markExecuted(record.documentId);
      contractExecuted = res.updated;
      contractForbidden = res.forbidden;
    }
    return { status: 200, body: { ok: true, status: normalized, documentId: record.documentId, contractExecuted, contractForbidden } };
  };
}

// 9-7 完成形：受信記録＋通知に加え、intake リポジトリ注入時は自動起票／状態同期を行う。
//   - 課題追加(type=1)：legal_requests が既にあれば（Slack 経由の起票）ワークフローを「受付済み」へ。
//     無ければ Backlog 直接起票とみなし legal_requests＋issue_workflows を INSERT
//     （V1 0103 トリガで matters が自動生成＝V2 案件モデルに接続）。
//   - ステータス変更(type=2)：issue_workflows.current_status_name を同期（UPDATE 自体がべき等の
//     ため受信台帳では重複排除しない）。
//   V1 の文書自動生成パイプライン・納期変更の完了時実行（U7）はここでは行わない（後続）。
export function createBacklogWebhookHandler(deps: {
  receipts: WebhookReceiptsRepository;
  notify?: (text: string) => Promise<boolean>;
  intake?: SlackIntakeRepository | null;
  log?: (message: string) => void;
}): WebhookHandler {
  const log = deps.log ?? (() => undefined);
  return async (payload) => {
    const status = parseBacklogStatusChanged(payload);
    if (status) {
      if (!deps.intake) return { status: 200, body: { ok: true, skipped: "intake disabled" } };
      try {
        await deps.intake.setWorkflowStatus(status.issueKey, status.status);
        return { status: 200, body: { ok: true, issueKey: status.issueKey, statusSynced: status.status } };
      } catch (error) {
        // 権限未整備（grant 046 未適用）等でも受信自体は成功扱い（再送を誘発しない）。
        log(`backlog-webhook: status sync failed for ${status.issueKey}: ${error instanceof Error ? error.message : String(error)}`);
        const forbidden = (error as { code?: string })?.code === "42501";
        return { status: 200, body: { ok: true, issueKey: status.issueKey, statusSynced: null, forbidden } };
      }
    }

    const ev = parseBacklogIssueCreated(payload);
    if (!ev) return { status: 200, body: { ok: true, skipped: "ignored" } };
    const first = await deps.receipts.recordIfFirst("backlog", `${ev.issueKey}:created`, { summary: ev.summary });
    if (!first) return { status: 200, body: { ok: true, skipped: "duplicate" } };

    let accepted = false;        // Slack 経由の既存依頼 → 受付済み
    let intakeCreated = false;   // Backlog 直接起票 → 自動取込
    let forbidden = false;
    if (deps.intake) {
      try {
        if (await deps.intake.requestExists(ev.issueKey)) {
          await deps.intake.setWorkflowStatus(ev.issueKey, "受付済み");
          accepted = true;
        } else {
          const requestType = BACKLOG_ISSUE_TYPE_TO_REQUEST_TYPE[ev.issueTypeName] ?? "legal_consult";
          await deps.intake.recordRequest({
            backlogIssueKey: ev.issueKey,
            slackUserId: extractSlackMention(ev.description),
            requestType,
            counterparty: null,
            summary: ev.summary,
            notes: JSON.stringify({
              details: ev.description.slice(0, 5000) || null,
              issueTypeName: ev.issueTypeName || null,
              source: "backlog-webhook"
            })
          });
          intakeCreated = true;
        }
      } catch (error) {
        log(`backlog-webhook: auto intake failed for ${ev.issueKey}: ${error instanceof Error ? error.message : String(error)}`);
        forbidden = (error as { code?: string })?.code === "42501";
      }
    }

    let notified = false;
    if (deps.notify) {
      notified = await deps.notify(`:inbox_tray: 新規の法務依頼（Backlog ${ev.issueKey}）${ev.summary ? `｜${ev.summary}` : ""}`);
    }
    return { status: 200, body: { ok: true, issueKey: ev.issueKey, accepted, intakeCreated, forbidden, notified } };
  };
}
