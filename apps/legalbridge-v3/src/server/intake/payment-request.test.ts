import test from "node:test";
import assert from "node:assert/strict";
import { firedKeys, milestoneText, normalizeDocNo, progressOf, type ProgressFacts } from "./payment-request.js";
import { assertInspectionMatter } from "./request-service.js";

const facts = (over: Partial<ProgressFacts> = {}): ProgressFacts => ({
  purpose: "royalty", acceptedAt: "2026-09-28T00:00:00.000Z", doneAt: null,
  documents: [], sentAt: null, payments: [], ...over
});

test("依頼者が打った番号を揃える（全角・長音・空白・小文字）", () => {
  assert.equal(normalizeDocNo(" ａｒｃ－ＰＯ－2026ー0001 "), "ARC-PO-2026-0001");
  assert.equal(normalizeDocNo(""), null);
});

test("工程は 受付 → 作成 → 送付 → 支払予定 → 支払 を事実から導く", () => {
  assert.equal(progressOf(facts()).current?.key, "created");
  const draft = progressOf(facts({ documents: [{ id: 1, documentNo: null, status: "draft", pinned: false }] }));
  assert.equal(draft.current?.key, "created");
  assert.match(draft.current!.detail, /下書きあり/);
  const issued = facts({ documents: [{ id: 1, documentNo: "ARC-RS-1", status: "issued", pinned: false }] });
  assert.equal(progressOf(issued).current?.key, "sent");
  const scheduled = { ...issued, sentAt: "2026-09-29T00:00:00.000Z",
    payments: [{ id: 5, paymentNo: "PAY-5", status: "planned", dueOn: "2026-10-31", paidOn: null }] };
  assert.equal(progressOf(scheduled).current?.key, "paid");
  assert.match(milestoneText("scheduled", "royalty", progressOf(scheduled)), /支払予定日 2026-10-31/);
  const paid = { ...scheduled, payments: [{ ...scheduled.payments[0]!, status: "paid", paidOn: "2026-10-30" }] };
  assert.equal(progressOf(paid).complete, true);
  assert.equal(progressOf(paid).current, null);
  assert.deepEqual(firedKeys(progressOf(paid), null), ["created", "sent", "scheduled", "paid"]);
});

test("取り消した支払は数えない。人が完了にしたら完了の知らせ", () => {
  const p = progressOf(facts({ doneAt: "2026-10-01T00:00:00.000Z",
    payments: [{ id: 1, paymentNo: null, status: "canceled", dueOn: null, paidOn: null }] }));
  assert.equal(p.complete, true);
  assert.equal(p.stages.find((s) => s.key === "scheduled")?.done, false);
  assert.deepEqual(firedKeys(p, "2026-10-01T00:00:00.000Z"), ["done"]);
  assert.match(milestoneText("created", "inspection", p), /^検収書を作りました/);
});

test("発注書が案件に入っている検収書は、その案件へ繋ぐほかは受けない", () => {
  const target = { docNo: "ARC-PO-1", documentId: 1, documentNo: "ARC-PO-1", agreementId: null, agreementNo: null,
    counterpartyId: null, counterpartyName: null, conditions: [],
    matter: { id: 9, matterNo: "MTR-2026-00009", title: "発注", status: "open" } };
  assert.throws(() => assertInspectionMatter("inspection", target, { mode: "direct" }), /MTR-2026-00009/);
  assert.throws(() => assertInspectionMatter("inspection", target, { mode: "new" }), /この案件へ接続/);
  assert.throws(() => assertInspectionMatter("inspection", target, { mode: "existing", matterId: 3 }));
  assertInspectionMatter("inspection", target, { mode: "existing", matterId: 9 });
  // 計算書・案件に入っていない発注書は止めない
  assertInspectionMatter("royalty", target, { mode: "direct" });
  assertInspectionMatter("inspection", { ...target, matter: null }, { mode: "direct" });
});
