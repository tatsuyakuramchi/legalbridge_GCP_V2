import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MERGE_REASON, StatementMergeService } from "./statement-merge.js";

/**
 * 脇屋（#2534）宛ての 2 枚：
 *   1049-R4（受取人として）条件 1460・1500 の取り分 990 + 1,938
 *   1060    （本人の作品）  条件 1600 で 5,000
 * 麻生（#626）は受取人の紙 1 枚だけ → まとめる組にしない。
 */
const head = (over: Record<string, unknown>) => ({
  manual_inputs: { notes: "備考", rs_bundle_lines: [], statementMode: "bundle" }, matter_id: null, agreement_id: null,
  template_key: "royalty_statement_pub", issued_on: "2026-06-30", period_label: "2025年7月〜2026年6月", has_draft: false,
  currency: "JPY", ...over
});
const HEAD = [
  head({ id: 949, document_no: "ARC-ROY-2026-1049-R4", statement_id: 1, condition_id: 1460, payee_party_id: 2534, net_amount: 990, party_id: 2534, party_name: "脇屋彰太", period: "P" }),
  head({ id: 949, document_no: "ARC-ROY-2026-1049-R4", statement_id: 2, condition_id: 1500, payee_party_id: 2534, net_amount: 1938, party_id: 2534, party_name: "脇屋彰太", period: "P" }),
  head({ id: 960, document_no: "ARC-ROY-2026-1060", statement_id: 3, condition_id: 1600, payee_party_id: null, net_amount: 5000, party_id: 2534, party_name: "脇屋彰太", period: "P",
         manual_inputs: { notes: "本人の備考", _ownerStaffId: 172, rs_bundle_lines: [] }, agreement_id: 55, issued_on: "2026-07-01" }),
  head({ id: 948, document_no: "ARC-ROY-2026-1048-R4", statement_id: 4, condition_id: 1460, payee_party_id: 626, net_amount: 3960, party_id: 626, party_name: "麻生涼介", period: "P" })
];
const db = (paidStatus = "planned") => new FakeDatabase((text) => {
  if (text.includes("JOIN statements s ON s.document_id = d.id")) return HEAD;
  if (text.includes("FROM statements s") && text.includes("condition_events e")) return [
    { statement_id: 1, event_id: 61 }, { statement_id: 2, event_id: 62 }, { statement_id: 3, event_id: 71 }];
  if (text.includes("FROM payments p JOIN payment_allocations")) return [
    { id: 801, payment_no: "PAY-0801", status: "planned", due_on: "2026-10-20", amount: 2928 },
    { id: 802, payment_no: "PAY-0802", status: paidStatus, due_on: "2026-10-31", amount: 5000 }];
  return undefined;
});
const issuerOf = (net = 7928) => {
  const issued: any[] = [];
  return { issued,
    previewBundle: async (entries: unknown[]) => [{ amounts: { netMinor: net } }] as any,
    issue: async (input: any) => { issued.push(input); return { document: { id: 990, documentNo: "ARC-ROY-2026-1060-R2" } } as any; } };
};
const paymentsOf = () => {
  const calls: unknown[][] = [];
  return { calls,
    cancel: async (id: number, reason: string) => { calls.push(["cancel", id, reason]); },
    createFromStatementDocument: async (id: number, _a: string, o?: { dueOn?: string | null }) => { calls.push(["create", id, o?.dueOn]); return { paymentNo: "PAY-0900" }; } };
};

test("試算：同じ人・同じ期間で、受取人の紙と本人の紙が混ざった組だけ。合計と立て直す支払を出す", async () => {
  const r = await new StatementMergeService(db(), issuerOf()).preview();
  assert.equal(r.groups.length, 1, "麻生は 1 枚だけなので組にしない");
  const g = r.groups[0]!;
  assert.equal(g.partyName, "脇屋彰太");
  assert.deepEqual(g.documents.map((d) => [d.documentNo, d.payee, d.netAmount]),
    [["ARC-ROY-2026-1049-R4", true, 2928], ["ARC-ROY-2026-1060", false, 5000]]);
  assert.equal(g.netAmount, 7928);
  assert.equal(g.status, "ready");
});

test("まとめる：両方を退かせる訂正版を 1 枚出し、未払いの支払 2 本を取り消して 1 本立て直す", async () => {
  const issuer = issuerOf(); const payments = paymentsOf();
  const svc = new StatementMergeService(db(), issuer, payments);
  const key = (await svc.preview()).groups[0]!.key;
  const r = await svc.run([key], "tester");
  assert.equal(r.merged, 1, JSON.stringify(r.results));
  const input = issuer.issued[0];
  assert.deepEqual(input.supersedes, [949, 960]);
  assert.equal(input.reason, MERGE_REASON);
  assert.equal(input.issuedOn, "2026-07-01", "元の決定日の遅いほう");
  assert.deepEqual(input.entries.map((e: any) => [e.conditionId, e.payeePartyId, e.eventIds]),
    [[1460, 2534, [61]], [1500, 2534, [62]], [1600, null, [71]]]);
  assert.deepEqual(input.manualInputs, { notes: "本人の備考", _ownerStaffId: 172 }, "本人の紙の手入力。焼き付けた行は組み直す");
  assert.equal(input.agreementId, 55);
  assert.deepEqual(payments.calls, [["cancel", 801, MERGE_REASON], ["cancel", 802, MERGE_REASON], ["create", 990, "2026-10-31"]]);
  assert.equal(r.results[0]!.paymentNo, "PAY-0900");
});

test("まとめない：支払済みがある・いま計算し直すと合計が違う", async () => {
  const paid = await new StatementMergeService(db("paid"), issuerOf()).preview();
  assert.equal(paid.groups[0]!.status, "paid");
  const amount = await new StatementMergeService(db(), issuerOf(8000)).preview();
  assert.equal(amount.groups[0]!.status, "amount");
  const issuer = issuerOf(8000); const payments = paymentsOf();
  const svc = new StatementMergeService(db(), issuer, payments);
  const r = await svc.run([(await svc.preview()).groups[0]!.key], "tester");
  assert.equal(r.results[0]!.status, "skipped");
  assert.equal(issuer.issued.length, 0);
  assert.equal(payments.calls.length, 0);
});
