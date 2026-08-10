import type { CloudSignRequestRepository } from "../integrations/cloudsign-request-repository.js";
import type { CloudSignAdapter } from "../integrations/cloudsign-adapter.js";
import type { ContractStatusWriter } from "../documents/contract-status-writer.js";

// CloudSign 一括ステータス同期（Phase 9-6）。未確定（terminal でない）依頼を古い順に
// 取り出し、CloudSign API へ後追い照会して締結状況を反映する。Webhook(9-5)の取りこぼし・
// 遅延に対する保険。既定 no-op（adapter が live 未構成なら何もしない）。
//   - 状態が変わったら lb_v2_cloudsign_requests.status を更新（grant 022 の UPDATE 再利用）。
//   - 締結(completed)なら契約を executed へ（9-5 と同じ contract-status-writer・grant 031 再利用・
//     42501 は forbidden で継続）。
//   - 1件の照会失敗はジョブ全体を落とさず failed に計上して次へ進む。

export interface CloudSignSyncSummary {
  configured: boolean;   // live 構成でなければ false（＝no-op）
  scanned: number;       // 照会対象に取り出した件数
  updated: number;       // status を更新した件数
  unchanged: number;     // 状態変化なし
  completed: number;     // 今回 completed が判明した件数
  contractExecuted: number;
  contractForbidden: number;
  failed: number;        // 照会/更新で例外が出た件数
}

export interface CloudSignSyncDeps {
  requests: CloudSignRequestRepository;
  adapter: CloudSignAdapter;
  contract?: ContractStatusWriter;
  limit?: number;
}

export async function runCloudSignSync(deps: CloudSignSyncDeps): Promise<CloudSignSyncSummary> {
  const summary: CloudSignSyncSummary = {
    configured: deps.adapter.configured,
    scanned: 0, updated: 0, unchanged: 0, completed: 0,
    contractExecuted: 0, contractForbidden: 0, failed: 0
  };
  if (!deps.adapter.configured) return summary; // live 未構成なら安全に no-op

  const pending = await deps.requests.listPending(deps.limit ?? 100);
  for (const record of pending) {
    summary.scanned++;
    try {
      const remote = await deps.adapter.fetchStatus(record.cloudSignDocumentId);
      if (remote.status !== record.status) {
        await deps.requests.updateStatus(record.cloudSignDocumentId, remote.status);
        summary.updated++;
      } else {
        summary.unchanged++;
      }
      if (remote.completed) {
        summary.completed++;
        if (deps.contract) {
          const res = await deps.contract.markExecuted(record.documentId);
          summary.contractExecuted += res.updated;
          if (res.forbidden) summary.contractForbidden++;
        }
      }
    } catch {
      // 個別の照会失敗はジョブ全体を止めない（次回再照会される）。
      summary.failed++;
    }
  }
  return summary;
}
