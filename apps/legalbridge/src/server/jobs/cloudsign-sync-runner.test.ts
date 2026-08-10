import assert from "node:assert/strict";
import test from "node:test";
import { runCloudSignSync } from "./cloudsign-sync-runner.js";
import {
  MemoryCloudSignRequestRepository,
  type CloudSignRequestRecord
} from "../integrations/cloudsign-request-repository.js";
import { MemoryContractStatusWriter } from "../documents/contract-status-writer.js";
import type { CloudSignAdapter, CloudSignStatus } from "../integrations/cloudsign-adapter.js";

function rec(over: Partial<CloudSignRequestRecord> = {}): CloudSignRequestRecord {
  return {
    idempotencyKey: over.cloudSignDocumentId ?? "k", documentId: 1, cloudSignDocumentId: "cs1",
    status: "sent", participantCount: 1, recordedAt: "2026-08-01T00:00:00Z", recordedBy: "sys", ...over
  };
}

// fetchStatus を documentId → status で差し替えるスタブ adapter。
class StubAdapter implements CloudSignAdapter {
  readonly configured: boolean;
  constructor(private readonly statuses: Record<string, string>, configured = true, private readonly throwFor: string[] = []) {
    this.configured = configured;
  }
  async requestSignature(): Promise<never> { throw new Error("not used"); }
  async fetchStatus(id: string): Promise<CloudSignStatus> {
    if (this.throwFor.includes(id)) throw new Error("api error");
    const status = this.statuses[id] ?? "sent";
    return { cloudSignDocumentId: id, status, completed: status === "completed", participants: [] };
  }
}

test("cloudsign-sync: live 未構成なら no-op", async () => {
  const requests = new MemoryCloudSignRequestRepository([rec()]);
  const s = await runCloudSignSync({ requests, adapter: new StubAdapter({}, false) });
  assert.equal(s.configured, false);
  assert.equal(s.scanned, 0);
});

test("cloudsign-sync: 締結で status 更新＋契約 executed", async () => {
  const requests = new MemoryCloudSignRequestRepository([
    rec({ cloudSignDocumentId: "cs1", documentId: 100, status: "sent" })
  ]);
  const contract = new MemoryContractStatusWriter();
  const s = await runCloudSignSync({
    requests, adapter: new StubAdapter({ cs1: "completed" }), contract
  });
  assert.equal(s.scanned, 1);
  assert.equal(s.updated, 1);
  assert.equal(s.completed, 1);
  assert.equal(s.contractExecuted, 1);
  assert.deepEqual(contract.executed, [100]);
  assert.equal((await requests.findByKey("cs1"))?.status, "completed");
});

test("cloudsign-sync: 状態変化なしは unchanged・契約更新なし", async () => {
  const requests = new MemoryCloudSignRequestRepository([rec({ cloudSignDocumentId: "cs1", status: "sent" })]);
  const contract = new MemoryContractStatusWriter();
  const s = await runCloudSignSync({ requests, adapter: new StubAdapter({ cs1: "sent" }), contract });
  assert.equal(s.unchanged, 1);
  assert.equal(s.updated, 0);
  assert.equal(s.completed, 0);
  assert.deepEqual(contract.executed, []);
});

test("cloudsign-sync: terminal は listPending から除外され照会されない", async () => {
  const requests = new MemoryCloudSignRequestRepository([
    rec({ cloudSignDocumentId: "done", status: "completed" }),
    rec({ cloudSignDocumentId: "cancel", status: "canceled" }),
    rec({ cloudSignDocumentId: "cs1", status: "sent" })
  ]);
  const s = await runCloudSignSync({ requests, adapter: new StubAdapter({ cs1: "sent" }) });
  assert.equal(s.scanned, 1); // sent のみ
});

test("cloudsign-sync: 個別照会失敗はジョブを止めず failed に計上", async () => {
  const requests = new MemoryCloudSignRequestRepository([
    rec({ cloudSignDocumentId: "bad", status: "sent" }),
    rec({ cloudSignDocumentId: "cs2", status: "sent" })
  ]);
  const s = await runCloudSignSync({
    requests, adapter: new StubAdapter({ cs2: "completed" }, true, ["bad"])
  });
  assert.equal(s.scanned, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.completed, 1);
});

test("cloudsign-sync: 権限未整備の契約更新は forbidden で継続", async () => {
  const requests = new MemoryCloudSignRequestRepository([rec({ cloudSignDocumentId: "cs1", status: "sent" })]);
  const s = await runCloudSignSync({
    requests, adapter: new StubAdapter({ cs1: "completed" }),
    contract: new MemoryContractStatusWriter(true /* forbidden */)
  });
  assert.equal(s.completed, 1);
  assert.equal(s.contractExecuted, 0);
  assert.equal(s.contractForbidden, 1);
});
