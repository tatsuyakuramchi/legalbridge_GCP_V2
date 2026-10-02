import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { issueDocumentSet, type DocumentSetDeps } from "./document-set.js";

const conds = (over: Record<string, unknown> = {}) => [
  { id: 1, condition_no: "C-1", direction: "in", counterparty_id: 5, agreement_id: null, ...over },
  { id: 2, condition_no: "C-2", direction: "in", counterparty_id: 5, agreement_id: null, ...over }
];

const harness = (opts: { missingFor?: string; failIssueAt?: number; condRows?: Array<Record<string, unknown>> } = {}) => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions WHERE id = ANY")) return opts.condRows ?? conds();
    if (t.includes("UPDATE conditions SET agreement_id = $2")) return [{ id: 1 }, { id: 2 }];
    if (t.includes("FROM agreements WHERE id = $1")) return [{ id: 77, agreement_no: "ARC-LIC-2026-0007", counterparty_id: 5, kind: "master", direction: "in" }];
    return undefined;
  });
  const calls: string[] = [];
  let n = 0;
  const deps: DocumentSetDeps = {
    db,
    preview: async (x) => { calls.push(`preview:${x.templateKey}:${x.agreementId}`);
      return { missing: x.templateKey === opts.missingFor ? [{ name: "発行日", label: "発行日" }] : [], templateLabel: x.templateKey }; },
    createDraft: async (x) => { calls.push(`draft:${x.templateKey}:${x.agreementId}:${x.conditionIds.join(",")}`); return { id: 100 + calls.length }; },
    issue: async (id) => { n++; if (opts.failIssueAt === n) throw new Error("boom"); calls.push(`issue:${id}`); return { documentNo: `NO-${id}` }; },
    createAgreement: async (x) => { calls.push(`agreement:${x.domain}:${x.title}`); return { id: 50, agreementNo: "ARC-LIC-2026-0050" }; }
  };
  return { db, deps, calls };
};

const input = {
  domain: "license" as const, counterpartyId: 5, matterId: 9,
  master: { templateKey: "license_master", title: "利用許諾基本契約", manualInputs: {} },
  docs: [
    { templateKey: "individual_license_terms_v3", conditionIds: [1], manualInputs: { 発行日: "2026-10-02" }, role: "main" as const },
    { templateKey: "individual_license_terms_v3", conditionIds: [2], manualInputs: {}, role: "extra" as const }
  ]
};

test("基本契約を作る → 条件を載せる → 基本契約書 → 条件書・追加の条件書 の順。条件書には文書の合意を付けない", async () => {
  const { deps, calls, db } = harness();
  const r = await issueDocumentSet(deps, input, "legal@x");
  assert.deepEqual(r.agreement, { id: 50, agreementNo: "ARC-LIC-2026-0050", created: true });
  assert.deepEqual(db.find("UPDATE conditions SET agreement_id = $2")!.params, [[1, 2], 50]);
  const drafts = calls.filter((c) => c.startsWith("draft:"));
  assert.deepEqual(drafts, ["draft:license_master:50:", "draft:individual_license_terms_v3:null:1", "draft:individual_license_terms_v3:null:2"]);
  assert.ok(calls.indexOf("agreement:license:利用許諾基本契約") < calls.indexOf(drafts[0]));
  assert.deepEqual(r.documents.map((d) => d.role), ["master", "main", "extra"]);
});

test("必須の欄が空なら何も決定せず、作った基本契約と条件の載せ替えを戻す", async () => {
  const { deps, calls, db } = harness({ missingFor: "individual_license_terms_v3" });
  await assert.rejects(() => issueDocumentSet(deps, input, "x"), /何も決定していません[\s\S]*発行日/);
  assert.equal(calls.filter((c) => c.startsWith("draft:")).length, 0);
  assert.ok(db.find("UPDATE conditions SET agreement_id = NULL"));
  assert.deepEqual(db.find("DELETE FROM agreements")!.params, [50]);
});

test("既にある基本契約を使うときは基本契約書を作らず、発注書には基本契約を付ける", async () => {
  const { deps, calls } = harness();
  const r = await issueDocumentSet(deps, { ...input, domain: "service", master: { existingAgreementId: 77 },
    docs: [{ templateKey: "purchase_order", conditionIds: [1, 2], manualInputs: {}, role: "main" }] }, "x");
  assert.equal(r.agreement?.created, false);
  assert.ok(!calls.some((c) => c.startsWith("agreement:")));
  assert.deepEqual(calls.filter((c) => c.startsWith("draft:")), ["draft:purchase_order:77:1,2"]);
});

test("決定の途中で止まったら、決定できたところまでを返す", async () => {
  const { deps } = harness({ failIssueAt: 2 });
  const r = await issueDocumentSet(deps, input, "x");
  assert.equal(r.documents.length, 1);
  assert.match(r.error!, /2 枚目.*boom.*決定できた 1 枚/);
});

test("相手先の違う条件、IN と OUT の混在は断る", async () => {
  await assert.rejects(() => issueDocumentSet(harness({ condRows: [conds()[0], { ...conds()[1], counterparty_id: 6 }] }).deps, input, "x"), /相手先の違う/);
  await assert.rejects(() => issueDocumentSet(harness({ condRows: [conds()[0], { ...conds()[1], direction: "out" }] }).deps, input, "x"), /IN と OUT/);
});
