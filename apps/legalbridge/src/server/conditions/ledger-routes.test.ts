import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createConditionLedgerRouter } from "./ledger-routes.js";
import { MemoryConditionLedgerRepository } from "./ledger-repository.js";
import { MemoryConditionSyncRepository } from "../documents/condition-sync-repository.js";

function appFor(options: { role?: string; writeEnabled?: boolean; ledgers?: MemoryConditionLedgerRepository; sync?: MemoryConditionSyncRepository } = {}) {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = {
      email: "legal@example.com", subject: "legal@example.com",
      role: (options.role ?? "legal") as "admin" | "legal" | "requester", source: "iap"
    };
    next();
  });
  app.use("/api/v2", createConditionLedgerRouter({
    ledgers: options.ledgers, conditionSync: options.sync, writeEnabled: options.writeEnabled ?? true
  }));
  return app;
}

const body = {
  entry: "work", workId: 13, workCode: "WRK-10013", vendorId: 7, vendorName: "スタジオ雨宿り", title: "制作・許諾",
  kinds: ["service", "license_in"],
  payments: [{ scheme: "lump_sum", name: "制作費", amountExTax: "300,000", paymentTerms: "翌月末" }],
  expenses: [{ name: "交通費", amountExTax: 20000, taxCategory: "taxable" }],
  fees: [{ name: "印紙", amountExTax: 200, taxCategory: "exempt" }],
  licenseIn: [{ materialCode: "WRK-10013-001", name: "原作", ratePct: 5, groupNo: 1, regions: [{ code: "JP", name: "日本" }], languages: [{ name: "日本語" }] }]
};

test("未構成なら503、requester は403", async () => {
  assert.equal((await request(appFor({ ledgers: undefined })).get("/api/v2/condition-ledgers")).status, 503);
  const ledgers = new MemoryConditionLedgerRepository();
  const forbidden = await request(appFor({ ledgers, role: "requester" })).post("/api/v2/condition-ledgers").send(body);
  assert.equal(forbidden.status, 403);
  const disabled = await request(appFor({ ledgers, writeEnabled: false })).post("/api/v2/condition-ledgers").send(body);
  assert.equal(disabled.status, 503);
});

test("作成で台帳レコードと条件明細（5行）が同期され、更新で置換・確定できる", async () => {
  const ledgers = new MemoryConditionLedgerRepository();
  const sync = new MemoryConditionSyncRepository();
  const app = appFor({ ledgers, sync });
  const created = await request(app).post("/api/v2/condition-ledgers").send(body);
  assert.equal(created.status, 201);
  assert.equal(created.body.ledger.status, "draft");
  assert.match(created.body.ledger.documentNumber, /^CT-/);
  assert.deepEqual(created.body.conditionSync, { written: 4, deleted: 0 });
  const lines = sync.documents.get(created.body.ledger.id)!;
  assert.deepEqual([...lines.keys()].sort(), [1001, 2001, 3001, 5001]);
  assert.equal(lines.get(1001)?.amount_ex_tax, 300000);     // "300,000" → 数値
  assert.equal(lines.get(2001)?.tax_category, "taxable");
  assert.equal(lines.get(5001)?.regions?.[0].code, "JP");

  const updated = await request(app).put(`/api/v2/condition-ledgers/${created.body.ledger.id}`)
    .send({ ...body, status: "final", expenses: [] });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ledger.status, "final");
  assert.deepEqual(updated.body.conditionSync, { written: 3, deleted: 1 });

  const list = await request(app).get("/api/v2/condition-ledgers?workId=13&status=final");
  assert.equal(list.body.ledgers.length, 1);
  const detail = await request(app).get(`/api/v2/condition-ledgers/${created.body.ledger.id}`);
  assert.equal(detail.body.ledger.payload.kinds.length, 2);
  assert.equal((await request(app).get("/api/v2/condition-ledgers/999")).status, 404);
});

test("種類が空・日付形式違いは400、紐づけ先が無ければ404", async () => {
  const ledgers = new MemoryConditionLedgerRepository();
  const app = appFor({ ledgers, sync: new MemoryConditionSyncRepository() });
  assert.equal((await request(app).post("/api/v2/condition-ledgers").send({ ...body, kinds: [] })).status, 400);
  assert.equal((await request(app).post("/api/v2/condition-ledgers").send({ ...body, termStart: "2026/4/1" })).status, 400);
  const created = await request(app).post("/api/v2/condition-ledgers").send(body);
  const missing = await request(app).post(`/api/v2/condition-ledgers/${created.body.ledger.id}/attach`).send({ documentId: 77 });
  assert.equal(missing.status, 404);
  ledgers.documents.set(77, { id: 77, documentNumber: "PO-2025-0083", templateType: "purchase_order", templateVersionId: null, lifecycleStatus: null, title: "旧PO" });
  const attached = await request(app).post(`/api/v2/condition-ledgers/${created.body.ledger.id}/attach`).send({ documentId: 77 });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.document.documentNumber, "PO-2025-0083");
  const detail = await request(app).get(`/api/v2/condition-ledgers/${created.body.ledger.id}`);
  assert.equal(detail.body.ledger.linkedDocuments.length, 1);
  const detached = await request(app).post(`/api/v2/condition-ledgers/${created.body.ledger.id}/detach`).send({ documentId: 77 });
  assert.equal(detached.status, 200);
});

test("同期の権限不足（42501）・列未追加（42703）は警告として返し、台帳レコードは成立する", async () => {
  const make = (code: string) => ({
    async upsertDocumentConditions() { throw Object.assign(new Error("db"), { code }); },
    async moveConditions() { return 0; }
  });
  const grant = await request(appFor({ ledgers: new MemoryConditionLedgerRepository(), sync: make("42501") as never }))
    .post("/api/v2/condition-ledgers").send(body);
  assert.equal(grant.status, 201);
  assert.match(grant.body.conditionSyncWarning, /grant 066/);
  const column = await request(appFor({ ledgers: new MemoryConditionLedgerRepository(), sync: make("42703") as never }))
    .post("/api/v2/condition-ledgers").send(body);
  assert.match(column.body.conditionSyncWarning, /075/);
});
