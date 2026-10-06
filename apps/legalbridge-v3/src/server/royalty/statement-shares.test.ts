import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { RoyaltyStatementService } from "./statement-service.js";
import { DomainError } from "../core/errors.js";

/**
 * 共著の取り分（A-068）。条件 1 本で全体を出し、受取人ごとに割って計算書を作る。
 *   条件：料率 15%・相手先 11（法人）。取り分：A（#21 個人）60% / B（#22 法人）40%。
 */
interface Options {
  shares?: Array<{ party_id: number; party_name: string; party_kind: string; share_ppm: number }>;
  siblings?: Array<{ document_id: number; payee_party_id: number }>;
  hasStatement?: boolean;
}

const SHARES = [
  { party_id: 21, party_name: "作家A", party_kind: "individual", share_ppm: 600000 },
  { party_id: 22, party_name: "作家B", party_kind: "corporate", share_ppm: 400000 }
];

const responder = (options: Options = {}) => (text: string, params: unknown[]): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM documents WHERE id = $1 FOR UPDATE")) return [{ id: 6, status: "issued" }];
  if (text.includes("FROM statements WHERE document_id")) return options.hasStatement ? [{ id: 99 }] : [];
  if (text.includes("FROM conditions c") && text.includes("LEFT JOIN parties p")) {
    return [{ id: 5, condition_no: "CL-2026-00042", name: "電子出版", kind: "license",
              direction: "in", counterparty_id: 11, currency: "JPY",
              pricing_model: "revenue_rate", rate_ppm: 150000,
              unit_amount: null, flat_amount: null, mg_amount: null, ag_amount: null,
              tax_category: "taxable", status: "active",
              agreement_title: "出版契約", agreement_no: "AG-2026-0002",
              withholding: false, party_kind: "corporate" }];
  }
  if (text.includes("SUM(e.deductions)")) return [{ consumed: 0 }];
  if (text.includes("c.status IN ('active', 'scheduled', 'superseded')")) {
    return [{ id: 5, condition_no: "CL-2026-00042", effective_from: null }];
  }
  if (text.includes("FROM condition_shares s")) {
    return (options.shares ?? SHARES).map((s) => ({ ...s, sort_order: 0, note: null }));
  }
  if (text.includes("FROM parties WHERE id = $1")) {
    const id = Number(params[0]);
    return [{ kind: id === 21 ? "individual" : "corporate", withholding: false, residency: "resident",
              treaty_rate_pct: null, treaty_docs_received_on: null }];
  }
  if (text.includes("JOIN statement_lines l ON l.statement_id = s.id")) return options.siblings ?? [];
  if (text.includes("FROM condition_events e JOIN conditions c")) {
    return [{ id: 700, condition_id: 5, event_type: "sales", occurred_on: "2026-06-30", period: "2026上期",
              quantity: null, sample_quantity: null, gross_amount: 60300, amount: null,
              document_id: null, status: "active", note: null, usage_type: null, out_condition_id: null,
              unit_amount: null, payment_stage: null, tax_included: null, rate_ppm: 150000, same_series: true }];
  }
  if (text.includes("INSERT INTO condition_events")) return [{ id: 701 }];
  if (text.includes("INSERT INTO statements")) return [{ id: 800 }];
  return undefined;
};

const service = (options: Options = {}) => {
  const db = new FakeDatabase(responder(options));
  return { db, service: new RoyaltyStatementService(db) };
};

test("受取人を選ばない試算は全体の額で、取り分ごとの内訳を添える", async () => {
  const { service: royalty } = service();
  const r = await royalty.preview({ conditionId: 5, period: "2026上期", reported: { salesInput: 60300 } });
  // 60,300 × 15% = 9,045
  assert.equal(r.amounts.netMinor, 9045);
  assert.equal(r.payee, null);
  assert.deepEqual(r.shares!.map((s) => [s.partyId, s.netMinor]), [[21, 5427], [22, 3618]]);
});

test("受取人を選ぶと、その人の額になる（四捨五入・全体を超えない・源泉は受取人で決まる）", async () => {
  const { service: royalty } = service();
  const a = await royalty.preview({ conditionId: 5, period: "2026上期", reported: { salesInput: 60300 }, payeePartyId: 21 });
  assert.equal(a.amounts.netMinor, 5427, "9,045 × 60% = 5,427");
  assert.equal(a.whole!.netMinor, 9045);
  assert.equal(a.payee!.partyId, 21);
  assert.equal(a.fee.actual_ex_tax, 5427);
  assert.equal(a.fee.tax_amount, 542, "消費税は受取人の額に掛けて切り捨て");
  assert.equal(a.payment.withholdingEnabled, true, "A は個人なので源泉");
  assert.match(a.fee.formula_breakdown, /取り分 60%/);

  const b = await royalty.preview({ conditionId: 5, period: "2026上期", reported: { salesInput: 60300 }, payeePartyId: 22 });
  assert.equal(b.amounts.netMinor, 3618);
  assert.equal(b.payment.withholdingEnabled, false, "B は法人");
  assert.equal(a.amounts.netMinor + b.amounts.netMinor, 9045, "合計は全体に一致（超えない）");
});

test("取り分の無い条件に受取人は渡せない。取り分にない人も選べない", async () => {
  const { service: plain } = service({ shares: [] });
  await assert.rejects(
    () => plain.preview({ conditionId: 5, period: "x", reported: { salesInput: 100 }, payeePartyId: 21 }),
    (e: unknown) => e instanceof DomainError && /取り分がありません/.test(e.message));
  const { service: royalty } = service();
  await assert.rejects(
    () => royalty.preview({ conditionId: 5, period: "x", reported: { salesInput: 100 }, payeePartyId: 99 }),
    (e: unknown) => e instanceof DomainError && /取り分にありません/.test(e.message));
});

test("確定は受取人が必須。計算書に受取人と取り分を書く", async () => {
  const { db, service: royalty } = service();
  await assert.rejects(
    () => royalty.finalize({ conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 60300 } }, "x"),
    (e: unknown) => e instanceof DomainError && /受取人を選んで/.test(e.message));

  const done = await royalty.finalize({
    conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 60300 }, payeePartyId: 21
  }, "kuramochi");
  assert.equal(done.netMinor, 5427);
  const statement = db.find("INSERT INTO statements");
  assert.equal(statement!.params[7], 5427, "net_amount は受取人の額");
  assert.equal(statement!.params[9], 21, "payee_party_id");
  assert.equal(statement!.params[10], 600000, "share_ppm");
  const dup = db.find("FROM statements WHERE document_id");
  assert.equal(dup!.params[2], 21, "二重の検査は受取人つき");
});

test("実績の束：ほかの受取人の計算書に結ばれた実績は空いている。同じ受取人には出さない", async () => {
  // B（#22）の計算書（文書 31）がすでに実績 700 を指している。A（#21）はその実績で出せる。
  const { db, service: royalty } = service({ siblings: [{ document_id: 31, payee_party_id: 22 }] });
  const r = await royalty.preview({ conditionId: 5, eventIds: [700], payeePartyId: 21 });
  assert.equal(r.amounts.netMinor, 5427);
  assert.equal(r.events[0].amount ?? null, null, "利用形態の無い実績は按分で行に割る（行の額は確定時）");
  void db;

  // B はもう出せない。
  await assert.rejects(
    () => royalty.preview({ conditionId: 5, eventIds: [700], payeePartyId: 22 }),
    (e: unknown) => e instanceof DomainError && /この受取人の計算書はすでにあります/.test(e.message));
});
