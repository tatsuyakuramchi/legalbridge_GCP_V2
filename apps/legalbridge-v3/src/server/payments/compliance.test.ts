import test from "node:test";
import assert from "node:assert/strict";
import { checkPaymentDue, dueLimitFrom, isFreelanceActTarget, PAYMENT_DUE_LIMIT_DAYS } from "./compliance.js";

test("上限は受領日から60日", () => {
  assert.equal(PAYMENT_DUE_LIMIT_DAYS, 60);
  assert.equal(dueLimitFrom("2026-06-20"), "2026-08-19");
  assert.equal(dueLimitFrom(null), null);
});

test("60日ちょうどは適合、61日から超過", () => {
  assert.equal(checkPaymentDue({ applicable: true, basisDate: "2026-06-20", dueOn: "2026-08-19" }).verdict, "ok");
  const over = checkPaymentDue({ applicable: true, basisDate: "2026-06-20", dueOn: "2026-08-20" });
  assert.equal(over.verdict, "over_limit");
  assert.equal(over.days, 61);
  assert.equal(over.overBy, 1);
});

test("超過は日数と上限日を添えて返す（是正の材料になる）", () => {
  const result = checkPaymentDue({ applicable: true, basisDate: "2026-06-20", dueOn: "2026-08-27" });
  assert.equal(result.days, 68);
  assert.equal(result.overBy, 8);
  assert.equal(result.limitDate, "2026-08-19");
});

test("受領日か期日が欠けていれば unset（明示不備として拾える）", () => {
  assert.equal(checkPaymentDue({ applicable: true, basisDate: "2026-06-20", dueOn: null }).verdict, "unset");
  assert.equal(checkPaymentDue({ applicable: true, basisDate: null, dueOn: "2026-08-19" }).verdict, "unset");
});

test("対象外でも上限日は返す（社内基準の参考値として使う）", () => {
  const result = checkPaymentDue({ applicable: false, basisDate: "2026-06-20", dueOn: "2026-12-01" });
  assert.equal(result.verdict, "not_applicable");
  assert.equal(result.limitDate, "2026-08-19");
});

test("対象は個人。法人は対象外として区別する", () => {
  assert.equal(isFreelanceActTarget("individual"), true);
  assert.equal(isFreelanceActTarget("corporate"), false);
  assert.equal(isFreelanceActTarget(null), false);
});

test("月をまたぐ計算がずれない", () => {
  assert.equal(dueLimitFrom("2026-12-31"), "2027-03-01");
  assert.equal(dueLimitFrom("2028-01-01"), "2028-03-01", "うるう年");
});
