import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { toCsv } from "../exports/csv.js";
import { AUDIT_CSV, AuditReportRepository, isAuditCsvSection, parsePeriod } from "./audit-report.js";

test("期間の既定は今日まで30日", () => {
  assert.deepEqual(parsePeriod({}, "2026-10-19"), { since: "2026-09-19", until: "2026-10-19" });
  assert.deepEqual(parsePeriod({ since: "2026-09-27" }, "2026-10-19"), { since: "2026-09-27", until: "2026-10-19" });
});

test("期間の形と前後を確かめる", () => {
  assert.throws(() => parsePeriod({ since: "2026/09/27" }, "2026-10-19"), /YYYY-MM-DD/);
  assert.throws(() => parsePeriod({ since: "2026-02-30" }, "2026-10-19"), /YYYY-MM-DD/, "実在しない日は弾く");
  assert.throws(() => parsePeriod({ since: "2026-10-20", until: "2026-10-19" }, "2026-10-19"), /後です/);
});

test("期間は日本時間の日付で両端を含めて渡す", async () => {
  const db = new FakeDatabase();
  await new AuditReportRepository(db).report({ since: "2026-09-27", until: "2026-10-10" });
  const matters = db.find("FROM matters mt")!;
  assert.deepEqual(matters.params, ["2026-09-27", "2026-10-10"]);
  assert.match(matters.text, /AT TIME ZONE 'Asia\/Tokyo'\)::date BETWEEN \$1::date AND \$2::date/);
});

test("部署は依頼者だけで決め、担当（法務）の部署へ落とさない", async () => {
  const db = new FakeDatabase();
  await new AuditReportRepository(db).report({ since: "2026-09-27", until: "2026-10-10" });
  const q = db.find("AS purchase_orders\n          FROM m LEFT JOIN po")!;
  assert.ok(q, "依頼部署別の集計が走る");
  assert.ok(!/COALESCE\([^)]*os\.department/.test(q.text), "担当者の部署を部署の代わりにしない");
  assert.match(q.text, /（依頼者未入力）/);
});

test("移行の空の支払（0円）は数えない", async () => {
  const db = new FakeDatabase();
  await new AuditReportRepository(db).report({ since: "2026-09-27", until: "2026-10-10" });
  for (const q of db.all("FROM payments p")) assert.match(q.text, /p\.amount > 0/);
});

test("支払の種類は業務委託を1本でも含めば業務委託", async () => {
  const db = new FakeDatabase();
  await new AuditReportRepository(db).report({ since: "2026-09-27", until: "2026-10-10" });
  const q = db.find("FROM payments p")!;
  assert.match(q.text, /bool_or\(c\.kind IN \('service', 'product'\)\) THEN 'outsourcing'/);
});

test("品質の集計は期間を渡さない（いま開いているもの）", async () => {
  const db = new FakeDatabase();
  await new AuditReportRepository(db).report({ since: "2026-09-27", until: "2026-10-10" });
  assert.deepEqual(db.find("FROM data_quality_issues\n")!.params, []);
});

test("行を画面の形に直す", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("AS unattributed")) {
      return [{ requests: "38", matters: "15", outsourcing_matters: "7", purchase_orders: "52", documents: "148",
                payments: "48", individual_payments: "39", outsourcing_payments: "23", outsourcing_ok: "23",
                outsourcing_over: "0", outsourcing_unset: "0", outsourcing_max_days: 60,
                license_over: "16", overdue: "0", open_high: "737", unattributed: "5" }];
    }
    if (t.includes("SELECT party_kind, pay_kind, verdict")) {
      return [{ party_kind: "individual", pay_kind: "license", verdict: "over_limit", n: "12", amount: "705830", max_days: 153 }];
    }
    return undefined;
  });
  const r = await new AuditReportRepository(db).report({ since: "2026-09-27", until: "2026-10-10" });
  assert.equal(r.summary.outsourcingOk, 23);
  assert.equal(r.summary.outsourcingMaxDays, 60);
  assert.equal(r.summary.unattributedMatters, 5);
  assert.deepEqual(r.dueVerdicts[0], { partyKind: "individual", payKind: "license", verdict: "over_limit",
                                       count: 12, amount: 705830, maxDays: 153 });
});

test("CSV は表ごとに出せ、知らない表は弾く", async () => {
  assert.ok(isAuditCsvSection("dueVerdicts"));
  assert.ok(!isAuditCsvSection("toString"), "プロトタイプの名前で通さない");
  assert.ok(!isAuditCsvSection("unknown"));

  const db = new FakeDatabase((t) =>
    t.includes("SELECT party_kind, pay_kind, verdict")
      ? [{ party_kind: "corporate", pay_kind: "outsourcing", verdict: "ok", n: 5, amount: 1120000, max_days: 60 }]
      : undefined);
  const r = await new AuditReportRepository(db).report({ since: "2026-09-27", until: "2026-10-10" });
  const spec = AUDIT_CSV.dueVerdicts;
  const csv = toCsv(spec.columns, spec.rows(r) as unknown[]);
  assert.equal(csv, "種類,区分,判定,件数,金額（税抜）,最長日数\r\n業務委託,法人,適合,5,1120000,60");

  const summary = toCsv(AUDIT_CSV.summary.columns, AUDIT_CSV.summary.rows(r) as unknown[]);
  assert.match(summary.split("\r\n")[1]!, /^2026-09-27,2026-10-10,/);
});
