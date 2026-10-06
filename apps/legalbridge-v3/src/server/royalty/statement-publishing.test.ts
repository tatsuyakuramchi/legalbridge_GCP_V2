import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { RoyaltyStatementService } from "./statement-service.js";
import { bundleLinesFor } from "./bundle.js";

/**
 * 出版（電子）の印税は、実績（事業部の Excel の行＝報告月 × 書店 × 作品）ごとに
 * 売上 × 料率 を切り捨てて足す（rounding.ts の floorRoyalty）。
 *   実績 700：1,818 × 15% = 272.7 → 272（Apple Books）
 *   実績 701：2,727 × 15% = 409.05 → 409（Kindle）
 *   合計 681。合計に掛けて丸めると 4,545 × 15% = 681.75 → 682 で 1 円ずれる。
 */
const EVENTS = [
  { id: 700, gross_amount: 1818, quantity: 1, note: "電子書籍売上取込 2026-03｜Apple Books" },
  { id: 701, gross_amount: 2727, quantity: 1, note: "電子書籍売上取込 2026-03｜Kindle（wholesale）｜販売月 2026-01" }
];

const responder = (usage: string | null) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM documents WHERE id = $1 FOR UPDATE")) return [{ id: 6, status: "issued" }];
  if (text.includes("FROM statements WHERE document_id")) return [];
  if (text.includes("FROM conditions c") && text.includes("LEFT JOIN parties p")) {
    return [{ id: 5, condition_no: "CL-2026-00042", name: "電子出版", kind: "license",
              direction: "in", counterparty_id: 11, currency: "JPY", usage_type: usage,
              pricing_model: "revenue_rate", rate_ppm: 150000,
              unit_amount: null, flat_amount: null, mg_amount: null, ag_amount: null,
              tax_category: "taxable", status: "active",
              agreement_title: "出版契約", agreement_no: "AG-2026-0002",
              withholding: true, party_kind: "individual" }];
  }
  if (text.includes("SUM(e.deductions)")) return [{ consumed: 0 }];
  if (text.includes("c.status IN ('active', 'scheduled', 'superseded')")) return [{ id: 5, condition_no: "CL-2026-00042", effective_from: null }];
  if (text.includes("FROM condition_shares s")) return [];
  if (text.includes("JOIN statement_lines l ON l.statement_id = s.id")) return [];
  if (text.includes("FROM condition_events e JOIN conditions c")) {
    return EVENTS.map((e) => ({
      ...e, condition_id: 5, event_type: "sales", occurred_on: "2026-03-31", period: "2026年3月分",
      sample_quantity: null, amount: e.gross_amount, document_id: null, status: "active", usage_type: null,
      out_condition_id: null, unit_amount: e.gross_amount, payment_stage: null, tax_included: null,
      rate_ppm: 150000, same_series: true, in_work_title: "キズナバレット 1", in_work_kind: "own",
      in_usage_type: usage, event_work_title: "キズナバレット 1", child_titles: null
    }));
  }
  if (text.includes("INSERT INTO condition_events")) return [{ id: 702 }];
  if (text.includes("INSERT INTO statements")) return [{ id: 800 }];
  return undefined;
};

test("出版の条件：実績ごとに切り捨てて足す。行に額と料率と製品名「報告月 作品名」が付く", async () => {
  const db = new FakeDatabase(responder("pub_digital"));
  const royalty = new RoyaltyStatementService(db);
  const r = await royalty.preview({ conditionId: 5, eventIds: [700, 701] });
  assert.equal(r.amounts.grossMinor, 681, "272 + 409（合計に掛けると 682）");
  assert.equal(r.amounts.netMinor, 681);
  assert.equal(r.reported.salesInput, 4545, "報告売上は売上の合計のまま");
  assert.deepEqual(r.events.map((e) => [e.amount, e.ratePct, e.productName]),
    [[272, 15, "2026年3月 キズナバレット 1"], [409, 15, "2026年3月 キズナバレット 1"]]);
  assert.match(r.fee.formula_breakdown, /実績ごとに切り捨て/);

  // 紙の行：実績 1 件 1 行（書店は但し書き）。
  const lines = bundleLinesFor(r);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].conditionName, "2026年3月 キズナバレット 1");
  assert.deepEqual([lines[0].salesJpy, lines[0].ratePct, lines[0].paymentJpy], [1818, 15, 272]);
  assert.match(lines[0].basisNote, /Apple Books/);
  assert.deepEqual([lines[1].salesJpy, lines[1].paymentJpy], [2727, 409]);

  // 確定：明細の行の額は行ごとの額（按分しない）。
  const done = await royalty.finalize({ conditionId: 5, documentId: 6, eventIds: [700, 701] }, "kuramochi");
  assert.equal(done.netMinor, 681);
  const inserted = db.all("INSERT INTO statement_lines");
  assert.deepEqual(inserted.map((q) => q.params[11]), [272, 409]);
  assert.deepEqual(inserted.map((q) => q.params[4]), ["2026年3月 キズナバレット 1", "2026年3月 キズナバレット 1"]);
  assert.deepEqual(inserted.map((q) => q.params[8]), [150000, 150000], "行の料率");
});

test("出版でない料率の条件は、これまでどおり合計に掛けて四捨五入（行は 1 本）", async () => {
  const royalty = new RoyaltyStatementService(new FakeDatabase(responder(null)));
  const r = await royalty.preview({ conditionId: 5, eventIds: [700, 701] });
  assert.equal(r.amounts.grossMinor, 682);
  assert.equal(r.events[0].amount ?? null, null);
  assert.equal(bundleLinesFor(r).length, 1);
});
