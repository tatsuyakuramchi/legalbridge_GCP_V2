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

// V1 互換の束ね出力（xlsx ＋ PDF zip）。
function bundleAppFor(opts: { role?: string } = {}) {
  const individual = { vendorCode: "2-20-9453", vendorName: "佐野篤", vendorNameKana: "サノアツシ", entityType: "個人", withholdingEnabled: null, invoiceRegistrationNumber: null };
  const corporate = { vendorCode: "1-10-0001", vendorName: "株式会社テスト", vendorNameKana: "", entityType: "法人", withholdingEnabled: false, invoiceRegistrationNumber: "T1234567890123" };
  const docs: RawExcelDoc[] = [
    { documentNumber: "ARC-INS-2026-0059", templateType: "inspection_certificate", vendor: individual, formData: {
      inspectorEmail: "a@x", inspectorName: "池田", paymentDate: "2026-09-20", taxRate: 10,
      delivery_line_items: [
        { item_name: "分析（第4期）", inspection_status: "paid", inspected_amount_ex_tax: 35000, unit_price: 35000, inspected_quantity: 1, calc_method: "SUBSCRIPTION" },
        { item_name: "分析（第5期）", inspection_status: "now", inspected_amount_ex_tax: 35000, unit_price: 35000, inspected_quantity: 1, calc_method: "SUBSCRIPTION" },
        { item_name: "分析（第6期）", inspection_status: "skip", inspected_amount_ex_tax: 35000, unit_price: 35000, inspected_quantity: 1, calc_method: "SUBSCRIPTION" }
      ] } },
    { documentNumber: "ARC-INS-2026-0070", templateType: "inspection_certificate", vendor: corporate, formData: {
      inspectorEmail: "a@x", inspectorName: "池田", paymentDate: "2026-09-20", taxRate: 10,
      delivery_line_items: [{ item_name: "編集", inspection_status: "now", inspected_amount_ex_tax: 100000 }] } }
  ];
  const repository = new MemoryExcelBatchRepository(docs);
  const app = express();
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "legal", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createExcelBatchRouter(repository, false, { pdfEnabled: false }));
  return app;
}

test("excel-batches/bundle: 個人だけの xlsx（V1 の 53 列・今回検収分のみ）を返す", async () => {
  const app = bundleAppFor();
  const listed = await request(app).get("/api/v2/documents/excel-batches");
  const key = listed.body.groups[0].key as string;
  const res = await request(app).get("/api/v2/documents/excel-batches/bundle")
    .query({ key, entity: "個人", withPdf: "0" }).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /spreadsheetml/);
  assert.match(String(res.headers["content-disposition"]), /filename\*=UTF-8''%E6%A4%9C%E5%8F%8E%E6%9B%B8_%E5%80%8B%E4%BA%BA_2026-09-20\.xlsx/);
  const body = res.body as Buffer;
  assert.equal(body.readUInt32LE(0), 0x04034b50);
  const text = body.toString("utf8");
  assert.match(text, /検収書\(個人\)/);                    // シート名
  assert.match(text, /分析（第5期）/);                      // 今回検収の行だけ
  assert.doesNotMatch(text, /第4期|第6期|株式会社テスト/);   // 支払済・未検収・法人は入らない
  assert.match(text, /<c r="H2"><v>35000<\/v><\/c>/);      // 単価（1）
  assert.match(text, /<c r="I2"><v>1<\/v><\/c>/);          // 数量（1）
  assert.match(text, /<c r="AV2"><v>35000<\/v><\/c>/);     // 小計（48 列目）
});

test("excel-batches/bundle: PDF 生成が無効でも zip（xlsx＋未生成メモ）を返し、該当区分が無ければ 404", async () => {
  const app = bundleAppFor();
  const listed = await request(app).get("/api/v2/documents/excel-batches");
  const key = listed.body.groups[0].key as string;
  const zip = await request(app).get("/api/v2/documents/excel-batches/bundle")
    .query({ key, entity: "法人" }).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(zip.status, 200);
  assert.match(String(zip.headers["content-type"]), /application\/zip/);
  const text = (zip.body as Buffer).toString("utf8");
  assert.match(text, /検収書_法人_2026-09-20\.xlsx/);
  assert.match(text, /PDF未生成\.txt/);
  assert.match(text, /ARC-INS-2026-0070/);
  const missing = await request(app).get("/api/v2/documents/excel-batches/bundle").query({ key: "nope", entity: "個人" });
  assert.equal(missing.status, 404);
  const forbidden = await request(bundleAppFor({ role: "requester" })).get("/api/v2/documents/excel-batches/bundle").query({ key, entity: "個人" });
  assert.equal(forbidden.status, 403);
});
