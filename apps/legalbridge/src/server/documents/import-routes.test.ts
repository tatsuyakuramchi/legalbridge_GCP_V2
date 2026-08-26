import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createDocumentImportRouter } from "./import-routes.js";
import {
  MemoryDocumentImportRepository, normalizeDate, inferMimeType, buildImportFormData,
  documentImportRowSchema
} from "./import-repository.js";
import { MemoryDriveStorage } from "./drive-storage.js";
import { MemoryConditionSyncRepository } from "./condition-sync-repository.js";
import { looksLikePdf } from "./cloudsign-source-pdf.js";
import type { RegisteredDocument } from "./registry-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester"; drive?: boolean }) {
  const repository = new MemoryDocumentImportRepository();
  const storage = options.drive === false ? null : new MemoryDriveStorage();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "admin@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createDocumentImportRouter(repository, options.enabled, storage));
  return { app, repository, storage };
}

test("取込無効時は過去文書取込を拒否する", async () => {
  const response = await request(appFor({ enabled: false }).app)
    .post("/api/v2/documents/import").send({ rows: [{ documentNumber: "PO-1", templateType: "purchase_order" }] });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "DOCUMENT_IMPORT_UNAVAILABLE");
});

test("依頼者ロールは過去文書取込できない", async () => {
  const response = await request(appFor({ enabled: true, role: "requester" }).app)
    .post("/api/v2/documents/import").send({ rows: [{ documentNumber: "PO-1", templateType: "purchase_order" }] });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "DOCUMENT_IMPORT_FORBIDDEN");
});

test("有効行を取込み無効行・重複を報告する", async () => {
  const response = await request(appFor({ enabled: true }).app).post("/api/v2/documents/import").send({
    rows: [
      { documentNumber: "PO-1", templateType: "purchase_order", issueKey: "LEGAL-1" },
      { documentNumber: "", templateType: "purchase_order" },
      { documentNumber: "PO-1", templateType: "purchase_order" }
    ]
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.insertedCount, 1);
  assert.equal(response.body.failedCount, 2);
});

test("validate は不正行を報告する", async () => {
  const response = await request(appFor({ enabled: true }).app).post("/api/v2/documents/import/validate").send({
    rows: [{ documentNumber: "PO-1", templateType: "purchase_order" }, { documentNumber: "" }]
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.errors[0].index, 1);
});

test("件名・相手先・日付・ファイル名を form_data に格納しMIMEを推定する", async () => {
  const { app, repository } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/documents/import").send({
    rows: [{
      documentNumber: "PO-2019-0001", templateType: "purchase_order",
      title: "業務委託発注書", counterparty: "甲社", documentDate: "2019/3/5",
      originalFileName: "発注書_甲社.pdf", driveLink: "https://drive.google.com/file/d/abcdefghij123/view"
    }]
  });
  assert.equal(response.status, 201);
  const stored = repository.inputs[0];
  assert.deepEqual(stored.formData, {
    title: "業務委託発注書", counterparty: "甲社", document_date: "2019-03-05",
    original_file_name: "発注書_甲社.pdf", source_mime_type: "application/pdf"
  });
  // メールPDF添付・CloudSign送信のPDF判定がこの記録で通ること（＝送信可能な取込）。
  const doc = {
    id: 1, documentNumber: "PO-2019-0001", issueKey: "", templateType: "purchase_order",
    templateVersionId: null, title: "業務委託発注書", counterparty: "甲社",
    driveLink: "https://drive.google.com/file/d/abcdefghij123/view",
    createdAt: "", createdBy: null, formData: stored.formData
  } as unknown as RegisteredDocument;
  assert.equal(looksLikePdf(doc), true);
});

test("不正な日付は行エラーになる", async () => {
  const response = await request(appFor({ enabled: true }).app).post("/api/v2/documents/import/validate").send({
    rows: [{ documentNumber: "PO-1", templateType: "purchase_order", documentDate: "2024年3月" }]
  });
  assert.equal(response.body.ok, false);
  assert.match(response.body.errors[0].error, /YYYY-MM-DD/);
});

function uploadRequest(app: express.Express, fields: Record<string, string>) {
  const req = request(app).post("/api/v2/documents/import/upload");
  for (const [key, value] of Object.entries(fields)) req.field(key, value);
  return req.attach("file", Buffer.from("%PDF-1.7 test"), { filename: "past.pdf", contentType: "application/pdf" });
}

test("upload: ファイルをDriveへ格納し drive_link つきで登録する", async () => {
  const { app, repository, storage } = appFor({ enabled: true });
  const response = await uploadRequest(app, {
    documentNumber: "CT-2018-0009", templateType: "contract",
    title: "旧取引基本契約", counterparty: "乙社", documentDate: "2018-04-01",
    originalName: "取引基本契約書.pdf"
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.document.documentNumber, "CT-2018-0009");
  assert.ok(response.body.driveLink.includes("drive.google.com"));
  // Drive 上のファイル名は「文書番号_元ファイル名」
  assert.equal(storage!.fileUploads[0].filename, "CT-2018-0009_取引基本契約書.pdf");
  assert.equal(storage!.fileUploads[0].mimeType, "application/pdf");
  const stored = repository.inputs[0];
  assert.equal(stored.row.driveLink, response.body.driveLink);
  assert.equal(stored.formData.original_file_name, "取引基本契約書.pdf");
  assert.equal(stored.formData.source_mime_type, "application/pdf");
  assert.equal(stored.formData.document_date, "2018-04-01");
});

test("upload: 既存の文書番号は Drive 格納前に 409 で弾く", async () => {
  const { app, repository, storage } = appFor({ enabled: true });
  await repository.importOne(documentImportRowSchema.parse({ documentNumber: "CT-1", templateType: "contract" }));
  const response = await uploadRequest(app, { documentNumber: "CT-1", templateType: "contract" });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "DOCUMENT_CONFLICT");
  assert.equal(storage!.fileUploads.length, 0);   // 孤児ファイルを作らない
});

test("upload: Drive 連携が無効なら 503（リンク取込は案内）", async () => {
  const { app } = appFor({ enabled: true, drive: false });
  const response = await uploadRequest(app, { documentNumber: "CT-2", templateType: "contract" });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "DOCUMENT_IMPORT_DRIVE_UNAVAILABLE");
});

test("upload: 依頼者ロールは 403", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await uploadRequest(app, { documentNumber: "CT-3", templateType: "contract" });
  assert.equal(response.status, 403);
});

test("import-details: 取込文書の form_data を差し替える（存在しない/生成文書は404）", async () => {
  const { app, repository } = appFor({ enabled: true });
  await repository.importOne(documentImportRowSchema.parse({
    documentNumber: "PO-2019-0001", templateType: "purchase_order", title: "旧発注書"
  }));
  const formData = {
    title: "旧発注書", counterparty: "甲社",
    items: [{ item_name: "イラスト制作", quantity: 10, unit_price: 30000, amount_ex_tax: 300000, calc_method: "FIXED" }],
    expenses: [{ expense_name: "送料", amount_inc_tax: 1100 }]
  };
  const ok = await request(app).put("/api/v2/documents/1/import-details").send({ formData });
  assert.equal(ok.status, 200);
  assert.deepEqual(repository.details.get(1), formData);

  const missing = await request(app).put("/api/v2/documents/999/import-details").send({ formData });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "DOCUMENT_IMPORT_DETAILS_NOT_FOUND");
});

test("import-details: 依頼者ロールは403・無効時は503", async () => {
  const denied = await request(appFor({ enabled: true, role: "requester" }).app)
    .put("/api/v2/documents/1/import-details").send({ formData: {} });
  assert.equal(denied.status, 403);
  const disabled = await request(appFor({ enabled: false }).app)
    .put("/api/v2/documents/1/import-details").send({ formData: {} });
  assert.equal(disabled.status, 503);
});

test("display-fields: 件名・相手先だけをマージ追記する（他キーは触らない設計）", async () => {
  const { app, repository } = appFor({ enabled: true });
  await repository.importOne(documentImportRowSchema.parse({
    documentNumber: "IC-2025-0003", templateType: "inspection_certificate"
  }));
  const one = await request(app).put("/api/v2/documents/1/display-fields")
    .send({ counterparty: "株式会社シー" });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.patch, { counterparty: "株式会社シー" });
  const two = await request(app).put("/api/v2/documents/1/display-fields")
    .send({ title: "検収書（2025年3月分）" });
  assert.equal(two.status, 200);
  // マージ＝先の相手先は保持されたまま件名が追記される
  assert.deepEqual(repository.displayFields.get(1),
    { counterparty: "株式会社シー", title: "検収書（2025年3月分）" });

  const empty = await request(app).put("/api/v2/documents/1/display-fields").send({});
  assert.equal(empty.status, 400);
  const missing = await request(app).put("/api/v2/documents/99/display-fields").send({ title: "x" });
  assert.equal(missing.status, 404);
});

test("display-fields: 依頼者ロールは403", async () => {
  const denied = await request(appFor({ enabled: true, role: "requester" }).app)
    .put("/api/v2/documents/1/display-fields").send({ title: "x" });
  assert.equal(denied.status, 403);
});

test("import-details: 金銭条件を含む保存は条件明細台帳へ自動同期される", async () => {
  const repository = new MemoryDocumentImportRepository();
  const conditionSync = new MemoryConditionSyncRepository();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "a@x.jp", subject: "t", role: "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createDocumentImportRouter(repository, true, null, conditionSync));
  await repository.importOne(documentImportRowSchema.parse({
    documentNumber: "ILT-2019-0001", templateType: "individual_license_terms"
  }));
  const response = await request(app).put("/api/v2/documents/1/import-details").send({
    formData: {
      title: "旧利用許諾条件書",
      financial_conditions: [{ condition_no: 1, condition_name: "利用許諾料", rate_pct: 10, mg_amount: 100000 }]
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.conditionSync, { written: 1, deleted: 0 });
  assert.equal(conditionSync.documents.get(1)!.get(1)!.condition_name, "利用許諾料");
});

test("純関数: normalizeDate / inferMimeType / buildImportFormData", () => {
  assert.equal(normalizeDate(""), "");
  assert.equal(normalizeDate("2024/3/5"), "2024-03-05");
  assert.equal(normalizeDate("2024-12-31"), "2024-12-31");
  assert.equal(normalizeDate("2024/13/01"), null);
  assert.equal(normalizeDate("あとで"), null);
  assert.equal(inferMimeType("契約書.PDF"), "application/pdf");
  assert.equal(inferMimeType("見積.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(inferMimeType("拡張子なし"), "");
  // 明示 MIME があれば推定より優先
  const row = documentImportRowSchema.parse({
    documentNumber: "X-1", templateType: "contract", originalFileName: "a.bin", mimeType: "application/pdf"
  });
  assert.equal(buildImportFormData(row).source_mime_type, "application/pdf");
});
