import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MasterMergeService, MERGE_REASON } from "./master-merge.js";

const db = (over: Partial<{ fromKind: string; sameParty: boolean; intoStatus: string }> = {}) => new FakeDatabase((t, p) => {
  if (t.includes("FROM agreements a JOIN v_party_resolved r") && t.includes("ANY($1::bigint[])")) return [
    { id: 1, agreement_no: "ARC-LIC-2026-1001", title: "基本A", kind: over.fromKind ?? "master", status: "executed", direction: "in", resolved_id: 5 },
    { id: 2, agreement_no: "ARC-LIC-2026-1002", title: "基本B", kind: "master", status: over.intoStatus ?? "executed", direction: "in", resolved_id: over.sameParty === false ? 6 : 5 }
  ];
  if (t.includes("AS supplements")) return [{ supplements: 2, conditions: 0, documents: 1, matters: 1 }];
  if (t.includes("WHERE d.status = 'issued' AND d.template_version_id IS NOT NULL")) return [
    { id: 50, document_no: "ARC-PUBT-2026-1019-R2", issued_at: "2026-10-08T00:00:00Z", title: "条件書", agreement_no: "ARC-PUBT-2026-1019" }];
  if (t.includes("SELECT document_no, issued_at, status FROM documents")) return [{ document_no: "ARC-PUBT-2026-1019-R2", issued_at: "2026-10-08T00:00:00Z", status: "issued" }];
  if (t.includes("supersedes_id = $1 AND status = 'draft'")) return [];
  return undefined;
});

test("試算：寄せる側の個別契約・条件・文書・案件の数と、出し直す文書", async () => {
  const p = await new MasterMergeService(db()).preview(1, 2);
  assert.deepEqual(p.moves, { supplements: 2, conditions: 0, documents: 1, matters: 1 });
  assert.deepEqual(p.reissue.map((d) => d.documentNo), ["ARC-PUBT-2026-1019-R2"]);
  assert.deepEqual(p.blockers, []);
});

test("止める：基本契約でない・相手先が違う・残す側が解除済み・同じもの", async () => {
  assert.match((await new MasterMergeService(db({ fromKind: "standalone" })).preview(1, 2)).blockers.join("/"), /基本契約ではありません/);
  assert.match((await new MasterMergeService(db({ sameParty: false })).preview(1, 2)).blockers.join("/"), /相手先の違う/);
  assert.match((await new MasterMergeService(db({ intoStatus: "terminated" })).preview(1, 2)).blockers.join("/"), /解除済み/);
  await assert.rejects(new MasterMergeService(db()).preview(1, 1), /同じ基本契約/);
});

test("統合：個別契約・条件・文書・案件を残す側へ付け替え、寄せた側は解除扱いで番号を残す", async () => {
  const d = db();
  await new MasterMergeService(d).merge(1, 2, "me");
  assert.deepEqual(d.find("UPDATE agreements SET parent_id = $2")!.params, [1, 2]);
  assert.deepEqual(d.find("UPDATE conditions SET agreement_id = $2")!.params, [1, 2]);
  assert.deepEqual(d.find("UPDATE documents SET agreement_id = $2 WHERE agreement_id = $1")!.params, [1, 2]);
  assert.ok(d.find("UPDATE matter_links SET target_ref = $2::text"));
  const t = d.find("SET status = 'terminated'")!;
  assert.deepEqual(t.params, [1, 2, "ARC-LIC-2026-1002"]);
  assert.equal(d.find("INSERT INTO audit_events")!.params[1], "agreement.merge_master");
});

test("出し直し：訂正版を元の決定日で決定する。決定済みでなければ飛ばす", async () => {
  const calls: string[] = [];
  const svc = new MasterMergeService(db(), {
    reissue: async (id, reason) => { calls.push(`reissue:${id}:${reason === MERGE_REASON}`); return { id: 900 }; },
    issue: async (id, _who, extra) => { calls.push(`issue:${id}:${extra?.issuedOn}`); return { documentNo: "ARC-PUBT-2026-1019-R3" }; }
  });
  const r = await svc.reissue([50], "me");
  assert.deepEqual(calls, ["reissue:50:true", "issue:900:2026-10-08"]);
  assert.equal(r.results[0]!.newDocumentNo, "ARC-PUBT-2026-1019-R3");
});
