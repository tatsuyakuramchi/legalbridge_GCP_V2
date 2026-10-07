import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { AnnualCloseService, annualLines, periodLabel } from "./annual-closes.js";
import type { ScheduleRow } from "../conditions/schedule-service.js";

const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
  id: 1, seq: 1, label: null, triggerKind: "periodic", plannedAmount: 0, dueOn: null, payOn: null,
  contractForm: null, serviceFrom: null, serviceTo: null, eventId: null, eventOn: null, eventAmount: null, paidAmount: 0, status: "planned", ...over
});

test("年 1 回の回：7/1〜翌 6/30、締めは期末、支払期日は条件の支払条件（読めなければ出版の既定）", () => {
  const lines = annualLines({ from: "2025-07-01", count: 2, paymentTerms: null, usageType: "pub_digital" }, []);
  assert.deepEqual(lines.map((l) => [l.seq, l.label, l.serviceFrom, l.serviceTo, l.dueOn, l.payOn]), [
    [1, "2025年7月〜2026年6月", "2025-07-01", "2026-06-30", "2026-06-30", "2026-10-31"],
    [2, "2026年7月〜2027年6月", "2026-07-01", "2027-06-30", "2027-06-30", "2027-10-31"]
  ]);
  // 条件の支払条件が読めればそれ。
  assert.equal(annualLines({ from: "2025-07-01", count: 1, paymentTerms: "翌々月末払い", usageType: "pub_digital" }, [])[0].payOn, "2026-08-31");
  // 紙は翌月末。
  assert.equal(annualLines({ from: "2025-07-01", count: 1, paymentTerms: null, usageType: "pub_print" }, [])[0].payOn, "2026-07-31");
  assert.equal(periodLabel("2026-01-01", "2026-12-31"), "2026年1〜12月");
});

test("既に同じ期間の回があれば飛ばし、既存の回の後ろに足す", () => {
  const existing = [row({ id: 10, seq: 3, serviceFrom: "2025-07-01", serviceTo: "2026-06-30", dueOn: "2026-06-30" })];
  const lines = annualLines({ from: "2025-07-01", count: 2, paymentTerms: null, usageType: "pub_digital" }, existing);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].seq, lines[0].label], [4, "2026年7月〜2027年6月"]);
  // 期間の無い回（締め日だけ）とも重ねない。
  const closeOnly = [row({ id: 11, seq: 1, dueOn: "2026-06-30" })];
  assert.equal(annualLines({ from: "2025-07-01", count: 1, paymentTerms: null, usageType: "pub_digital" }, closeOnly).length, 0);
});

test("一括：電子出版の有効な料率条件を拾い、試算は書かず、立てるときは既存の回に足して入れ替える", async () => {
  const db = new FakeDatabase((text) => {
    if (text.includes("c.usage_type = $1")) {
      return [{ id: 5, condition_no: "CL-5", name: "A｜電子出版", payment_terms: null, work_title: "作品A", party_name: "作家A" },
              { id: 6, condition_no: "CL-6", name: "B｜電子出版", payment_terms: "翌月末払い", work_title: "作品B", party_name: "作家B" }];
    }
    return undefined;
  });
  const calls: Array<{ id: number; lines: unknown[] }> = [];
  const deps = {
    schedules: {
      list: async (id: number) => ({ lines: id === 6 ? [row({ id: 60, seq: 1, label: "2025年7月〜2026年6月", serviceFrom: "2025-07-01", serviceTo: "2026-06-30", dueOn: "2026-06-30", payOn: "2026-07-31" })] : [] }),
      replace: async (id: number, lines: unknown[]) => { calls.push({ id, lines }); return {}; }
    }
  };
  const svc = new AnnualCloseService(db, deps);
  const p = await svc.preview({ usageType: "pub_digital", from: "2025-07-01", count: 1 });
  assert.deepEqual([p.adding, p.skipped], [1, 1]);
  assert.equal(p.targets[0].adding[0].payOn, "2026-10-31");
  assert.equal(p.targets[1].skipped, "この期間の回はもうあります");
  assert.equal(calls.length, 0, "試算は書かない");

  const r = await svc.run({ usageType: "pub_digital", from: "2025-07-01", count: 1 }, "tester");
  assert.equal(r.written, 1);
  assert.deepEqual(calls.map((c) => c.id), [5]);
  assert.equal((calls[0].lines[0] as { label: string }).label, "2025年7月〜2026年6月");
  assert.ok(db.find("INSERT INTO audit_events"));
});
