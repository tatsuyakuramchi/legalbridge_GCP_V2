import test from "node:test";
import assert from "node:assert/strict";
import { coveringIns, receiptInState, receiptState } from "./receipts.js";

test("入金に対する作者の状態：未報告 → 金額が違う → 計算書待ち → 計算書済", () => {
  assert.equal(receiptInState(1000000, []), "unreported");
  assert.equal(receiptInState(1000000, [{ grossAmount: 100000, documentId: null }]), "mismatch", "打ち間違い（桁違い）");
  assert.equal(receiptInState(1000000, [{ grossAmount: 600000, documentId: 5 }, { grossAmount: 400000, documentId: null }]), "waiting");
  assert.equal(receiptInState(1000000, [{ grossAmount: 1000000, documentId: 5 }]), "issued");
});

test("入金全体の状態は、いちばん手前の作者の状態。作者のいない入金は none", () => {
  assert.equal(receiptState([]), "none");
  assert.equal(receiptState([{ state: "issued" }, { state: "unreported" }]), "unreported");
  assert.equal(receiptState([{ state: "issued" }, { state: "waiting" }]), "waiting");
  assert.equal(receiptState([{ state: "issued" }, { state: "issued" }]), "issued");
});

test("許諾先専用の IN 条件があれば、その作者の一律の条件は外す。ほかの作者・ほかの許諾先には効かない", () => {
  const c = (conditionId: number, partyId: number, targetPartyId: number | null) => ({ conditionId, partyId, workId: 1, targetPartyId });
  const all = [c(10, 1, null), c(11, 2, null), c(12, 1, 4)];
  // 許諾先 4：作者 1 は専用の条件（12）、作者 2 は一律（11）。
  assert.deepEqual(coveringIns(all, 4).map((x) => x.conditionId), [11, 12]);
  // 許諾先 3：専用の条件は効かない。作者 1・2 とも一律。
  assert.deepEqual(coveringIns(all, 3).map((x) => x.conditionId), [10, 11]);
});
