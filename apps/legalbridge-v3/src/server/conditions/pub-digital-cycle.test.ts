import test from "node:test";
import assert from "node:assert/strict";
import { DIGITAL_CYCLE_DEFAULTS, digitalPaymentTerms, payScheduleText, periodsOf, readDigitalCycle } from "./pub-digital-cycle.js";
import { PUB_DIGITAL_PAYMENT_TERMS } from "./write-service.js";
import { payDateFromTerms } from "./payment-terms.js";

test("年 1 回の既定は従来の文と同じ", () => {
  assert.equal(digitalPaymentTerms(DIGITAL_CYCLE_DEFAULTS.year), PUB_DIGITAL_PAYMENT_TERMS);
  assert.deepEqual(readDigitalCycle(PUB_DIGITAL_PAYMENT_TERMS), DIGITAL_CYCLE_DEFAULTS.year);
});

test("年 2 回・年 4 回の文と、読み戻し（支払月・支払日）", () => {
  const half = digitalPaymentTerms(DIGITAL_CYCLE_DEFAULTS.half_year);
  assert.equal(half, "毎年1月1日〜6月30日及び7月1日〜12月31日を集計期間とし、各集計期間の末日の翌々月末日までに支払う。");
  assert.deepEqual(readDigitalCycle(half), DIGITAL_CYCLE_DEFAULTS.half_year);
  assert.equal(payScheduleText(DIGITAL_CYCLE_DEFAULTS.half_year), "1〜6月分は8月末日、7〜12月分は翌年2月末日");

  const q = { cycle: "quarter" as const, startMonth: 4, payMonth: 9, payDay: 20 };
  const quarter = digitalPaymentTerms(q);
  assert.equal(quarter, "毎年4月1日〜6月30日、7月1日〜9月30日、10月1日〜12月31日及び1月1日〜3月31日を集計期間とし、各集計期間の末日の3か月後の月の20日までに支払う。");
  assert.deepEqual(readDigitalCycle(quarter), q);
  assert.deepEqual(periodsOf({ cycle: "half_year", startMonth: 4 }), [[4, 9], [10, 3]]);

  const y = { cycle: "year" as const, startMonth: 4, payMonth: 6, payDay: 25 };
  assert.equal(digitalPaymentTerms(y), "毎年4月1日〜翌年3月31日を集計期間とし、6月25日までに支払う。");
  assert.deepEqual(readDigitalCycle(digitalPaymentTerms(y)), y);
  assert.equal(readDigitalCycle("年2回払い"), null);
});

test("回ごとの支払期日（支払月・支払日どおり）", () => {
  const half = digitalPaymentTerms(DIGITAL_CYCLE_DEFAULTS.half_year);
  assert.equal(payDateFromTerms("2026-06-30", half), "2026-08-31");
  assert.equal(payDateFromTerms("2026-12-31", half), "2027-02-28");
  const q = digitalPaymentTerms({ cycle: "quarter", startMonth: 4, payMonth: 9, payDay: 20 });
  assert.equal(payDateFromTerms("2026-06-30", q), "2026-09-20");
  assert.equal(payDateFromTerms("2026-12-31", q), "2027-03-20");
  assert.equal(payDateFromTerms("2027-03-31", digitalPaymentTerms({ cycle: "year", startMonth: 4, payMonth: 6, payDay: 25 })), "2027-06-25");
  assert.equal(payDateFromTerms("2026-06-30", PUB_DIGITAL_PAYMENT_TERMS), "2026-10-31", "年 1 回は従来どおり");
});
