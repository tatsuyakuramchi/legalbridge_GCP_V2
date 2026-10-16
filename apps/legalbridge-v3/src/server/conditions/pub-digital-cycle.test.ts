import test from "node:test";
import assert from "node:assert/strict";
import { DIGITAL_CYCLE_DEFAULTS, digitalPaymentTerms, periodsOf, readDigitalCycle } from "./pub-digital-cycle.js";
import { PUB_DIGITAL_PAYMENT_TERMS } from "./write-service.js";
import { payDateFromTerms } from "./payment-terms.js";

test("年 1 回の既定は従来の文と同じ", () => {
  assert.equal(digitalPaymentTerms(DIGITAL_CYCLE_DEFAULTS.year), PUB_DIGITAL_PAYMENT_TERMS);
  assert.deepEqual(readDigitalCycle(PUB_DIGITAL_PAYMENT_TERMS), DIGITAL_CYCLE_DEFAULTS.year);
});

test("年 2 回・年 4 回の文と、読み戻し", () => {
  const half = digitalPaymentTerms(DIGITAL_CYCLE_DEFAULTS.half_year);
  assert.equal(half, "毎年1月1日〜6月30日及び7月1日〜12月31日を集計期間とし、各集計期間の末日の翌々月末日までに支払う。");
  assert.deepEqual(readDigitalCycle(half), DIGITAL_CYCLE_DEFAULTS.half_year);
  const quarter = digitalPaymentTerms({ cycle: "quarter", startMonth: 4, payMonthsAfter: 1 });
  assert.equal(quarter, "毎年4月1日〜6月30日、7月1日〜9月30日、10月1日〜12月31日及び1月1日〜3月31日を集計期間とし、各集計期間の末日の翌月末日までに支払う。");
  assert.deepEqual(readDigitalCycle(quarter), { cycle: "quarter", startMonth: 4, payMonthsAfter: 1 });
  assert.deepEqual(periodsOf({ cycle: "half_year", startMonth: 4, payMonthsAfter: 2 }), [[4, 9], [10, 3]]);
  assert.equal(readDigitalCycle("年2回払い"), null);
});

test("年 2 回の文から回ごとの支払期日が出る（締め日の翌々月末日）", () => {
  const half = digitalPaymentTerms(DIGITAL_CYCLE_DEFAULTS.half_year);
  assert.equal(payDateFromTerms("2026-06-30", half), "2026-08-31");
  assert.equal(payDateFromTerms("2026-12-31", half), "2027-02-28");
  assert.equal(payDateFromTerms("2026-06-30", PUB_DIGITAL_PAYMENT_TERMS), "2026-10-31", "年 1 回は従来どおり");
});
