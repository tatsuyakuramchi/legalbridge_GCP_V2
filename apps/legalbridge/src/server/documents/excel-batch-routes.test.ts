import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createExcelBatchRouter } from "./excel-batch-routes.js";
import { MemoryExcelBatchRepository } from "./excel-batch-repository.js";
import { groupExcelBatches, deriveExcelGroupKey, type RawExcelDoc } from "./excel-batch-engine.js";

test("deriveExcelGroupKey: royalty と inspection で参照フィールドが違う", () => {
  const roy = deriveExcelGroupKey("royalty_statement", { paymentDueDate: "2026-09-30", STAFF_EMAIL: "a@x", STAFF_NAME: "A" });
  assert.equal(roy.category, "royalty_statement");
  assert.equal(roy.paymentDate, "2026-09-30");
  assert.equal(roy.inspectorEmail, "a@x");
  const ins = deriveExcelGroupKey("inspection_certificate", { paymentDate: "2026-08-31T00:00:00Z", inspectorName: "B" });
  assert.equal(ins.category, "inspection_certificate");
  assert.equal(ins.paymentDate, "2026-08-31");
  assert.equal(ins.inspectorName, "B");
});

test("groupExcelBatches: 種別×担当者×支払期日で束ね支払期日昇順", () => {
  const docs: RawExcelDoc[] = [
    { documentNumber: "INS-1", templateType: "inspection_certificate", formData: { inspectorEmail: "a@x", inspectorName: "A", paymentDate: "2026-09-30", description: "件1" } },
    { documentNumber: "INS-2", templateType: "inspection_certificate", formData: { inspectorEmail: "a@x", inspectorName: "A", paymentDate: "2026-09-30", description: "件2" } },
    { documentNumber: "ROY-1", templateType: "royalty_statement", formData: { STAFF_EMAIL: "b@x", STAFF_NAME: "B", paymentDueDate: "2026-08-31" } }
  ];
  const groups = groupExcelBatches(docs);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].category, "royalty_statement");   // 8/31 が先
  assert.equal(groups[1].count, 2);                        // INS 2件
  assert.deepEqual(groups[1].documentNumbers, ["INS-1", "INS-2"]);
});

test("groupExcelBatches: 文書ごとの税区分内訳とグループ合計（経理提出用）が付く", () => {
  const docs: RawExcelDoc[] = [
    { documentNumber: "INS-1", templateType: "inspection_certificate", formData: {
      inspectorEmail: "a@x", paymentDate: "2026-09-30", taxRate: 10,
      delivery_line_items: [{ inspected_amount_ex_tax: 300000 }],
      other_fees: [{ amount: 440, tax_category: "taxable" }],
      expenses: [{ amount_ex_tax: 20000, tax_category: "exempt" }]
    } },
    { documentNumber: "INS-2", templateType: "inspection_certificate", formData: {
      inspectorEmail: "a@x", paymentDate: "2026-09-30", taxRate: 10,
      delivery_line_items: [{ inspected_amount_ex_tax: 100000 }]
    } },
    { documentNumber: "ROY-1", templateType: "royalty_statement", formData: {
      paymentDueDate: "2026-08-31", statementMode: "single", rsCalcType: "period", rsBasisKind: "sales", rsMsrp: 1000000, rsRatePct: 3, taxRate: 10
    } }
  ];
  const groups = groupExcelBatches(docs);
  const royalty = groups.find((g) => g.category === "royalty_statement")!;
  assert.equal(royalty.items[0].taxable10, 30000);
  assert.equal(royalty.totals.totalIncTax, 33000);
  const inspection = groups.find((g) => g.category === "inspection_certificate")!;
  assert.equal(inspection.items[0].taxable10, 300440);
  assert.equal(inspection.items[0].exempt, 20000);
  assert.equal(inspection.totals.taxable10, 400440);
  assert.equal(inspection.totals.exempt, 20000);
  assert.equal(inspection.totals.tax, 40044);
  assert.equal(inspection.totals.totalIncTax, 400440 + 20000 + 40044);
});

function appFor(opts: { enabled?: boolean; role?: string } = {}) {
  const docs: RawExcelDoc[] = [
    { documentNumber: "INS-1", templateType: "inspection_certificate", formData: { inspectorEmail: "a@x", paymentDate: "2026-09-30" } },
    { documentNumber: "ROY-1", templateType: "royalty_statement", formData: { paymentDueDate: "2026-08-31" } }
  ];
  const repository = new MemoryExcelBatchRepository(docs);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createExcelBatchRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("excel-batches: admin/legal 以外は403", async () => {
  const res = await request(appFor({ role: "requester" }).app).get("/api/v2/documents/excel-batches");
  assert.equal(res.status, 403);
});

test("excel-batches: 集計を返す（書込無効でも可）", async () => {
  const res = await request(appFor({ enabled: false }).app).get("/api/v2/documents/excel-batches").expect(200);
  assert.equal(res.body.groups.length, 2);
  assert.equal(res.body.writeEnabled, false);
});

test("mark: 書込無効時は503", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .post("/api/v2/documents/excel-batches/mark").send({ documentNumbers: ["INS-1"] });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "EXCEL_BATCH_WRITE_UNAVAILABLE");
});

test("mark: 発行済み記録すると保留一覧から除外される", async () => {
  const target = appFor({ enabled: true });
  const marked = await request(target.app)
    .post("/api/v2/documents/excel-batches/mark").send({ documentNumbers: ["INS-1"], batchKey: "k" }).expect(200);
  assert.equal(marked.body.recorded, 1);
  const after = await request(target.app).get("/api/v2/documents/excel-batches").expect(200);
  assert.equal(after.body.total, 1);   // ROY-1 のみ残る
  assert.equal(after.body.groups[0].category, "royalty_statement");
});

test("mark: 空配列は400", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/documents/excel-batches/mark").send({ documentNumbers: [] });
  assert.equal(res.status, 400);
});
