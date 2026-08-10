import type { WebhookHandler } from "../internal/webhooks-routes.js";
import type { WebhookReceiptsRepository } from "../internal/webhook-receipts-repository.js";
import { parseCloudSignEvent, parseBacklogIssueCreated } from "../internal/webhook-parsers.js";
import type { CloudSignRequestRepository } from "./cloudsign-request-repository.js";
import type { ContractStatusWriter } from "../documents/contract-status-writer.js";

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

export function createBacklogWebhookHandler(deps: {
  receipts: WebhookReceiptsRepository;
  notify?: (text: string) => Promise<boolean>;
}): WebhookHandler {
  return async (payload) => {
    const ev = parseBacklogIssueCreated(payload);
    if (!ev) return { status: 200, body: { ok: true, skipped: "ignored" } };
    const first = await deps.receipts.recordIfFirst("backlog", `${ev.issueKey}:created`, { summary: ev.summary });
    if (!first) return { status: 200, body: { ok: true, skipped: "duplicate" } };
    let notified = false;
    if (deps.notify) {
      notified = await deps.notify(`:inbox_tray: 新規の法務依頼（Backlog ${ev.issueKey}）${ev.summary ? `｜${ev.summary}` : ""}`);
    }
    return { status: 200, body: { ok: true, issueKey: ev.issueKey, notified } };
  };
}
