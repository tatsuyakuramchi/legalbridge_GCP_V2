import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { MemoryDraftRepository } from "./draft-repository.js";
import { MemoryDocumentRegistryRepository, type RegisteredDocument } from "./registry-repository.js";
import { MemoryDocumentLookupRepository, type MemoryLookupDoc } from "./document-lookup-repository.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import { createIntegrationAdapters } from "../integrations/index.js";
import type { DocumentFormSchema } from "../../types.js";

const schema: DocumentFormSchema = {
  templateKey: "purchase_order", templateVersionId: 10, label: "発注書",
  fields: [{ name: "PROJECT_TITLE", label: "件名", required: true }]
};

function doc(over: Partial<RegisteredDocument> = {}): RegisteredDocument {
  return {
    id: 1, documentNumber: "ARC-PO-2026-0001", issueKey: "LB-1", templateType: "purchase_order",
    templateVersionId: 10, title: "発注A", counterparty: "取引先A", driveLink: "",
    createdAt: "2026-07-01T00:00:00.000Z", createdBy: "legal@example.com",
    lifecycleStatus: "final", formData: { PROJECT_TITLE: "発注A" }, ...over
  };
}

function appFor() {
  const registry = new MemoryDocumentRegistryRepository([
    // バージョン系列（base=ARC-PO-2026-0001）：0001(旧版) → 0001-R1(正本)
    doc({ id: 1, documentNumber: "ARC-PO-2026-0001", baseDocumentNumber: "ARC-PO-2026-0001",
      isPrimary: false, supersededBy: "ARC-PO-2026-0001-R1", createdAt: "2026-07-01T00:00:00.000Z" }),
    doc({ id: 4, documentNumber: "ARC-PO-2026-0001-R1", baseDocumentNumber: "ARC-PO-2026-0001",
      isPrimary: true, title: "発注A(改訂)", createdAt: "2026-07-05T00:00:00.000Z" }),
    doc({ id: 2, documentNumber: "ARC-PO-2026-0002", driveLink: "https://drive/x", title: "発注B" }),
    doc({ id: 3, documentNumber: "ARC-PO-2026-0003", lifecycleStatus: "voided", title: "廃止" })
  ]);
  const lookupDocs: MemoryLookupDoc[] = [
    { id: 1, documentNumber: "ARC-PO-2026-0001", issueKey: "LB-1", templateType: "purchase_order", driveLink: "", title: "発注A" },
    { id: 2, documentNumber: "ARC-PO-2026-0002", issueKey: "LB-2", templateType: "purchase_order", driveLink: "https://drive/x" },
    { id: 3, documentNumber: "ARC-PO-2026-0003", issueKey: "LB-3", templateType: "purchase_order", driveLink: "", lifecycleStatus: "voided" }
  ];
  const lookup = new MemoryDocumentLookupRepository(
    lookupDocs,
    { purchase_order: "PO" },
    { [`PO:${new Date().getUTCFullYear()}`]: 41 }
  );
  return createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    documentRegistry: registry,
    documentLookup: lookup
  }, { accessMode: "readonly", requireDatabase: false });
}

test("by-number: 文書番号で1件を引く", async () => {
  const res = await request(appFor()).get("/api/v2/documents/by-number/ARC-PO-2026-0001").expect(200);
  assert.equal(res.body.document.id, 1);
  assert.equal(res.body.document.documentNumber, "ARC-PO-2026-0001");
});

test("by-number: 未存在は404", async () => {
  const res = await request(appFor()).get("/api/v2/documents/by-number/NOPE").expect(404);
  assert.equal(res.body.code, "DOCUMENT_NOT_FOUND");
});

test("pending-pdf: Drive未保存かつvoidでない文書のみ・件数集計", async () => {
  const res = await request(appFor()).get("/api/v2/documents/pending-pdf").expect(200);
  assert.equal(res.body.total, 1);                 // id=1 のみ（2はdrive有・3はvoid）
  assert.equal(res.body.rows[0].id, 1);
  assert.equal(res.body.countsByTemplate.purchase_order, 1);
});

test("numbering/next: 非破壊で次番号をプレビュー", async () => {
  const res = await request(appFor()).get("/api/v2/documents/numbering/next?type=purchase_order").expect(200);
  const year = new Date().getUTCFullYear();
  assert.equal(res.body.sequence, 42);             // current 41 → 次 42（増分しない）
  assert.equal(res.body.number, `ARC-PO-${year}-0042`);
});

test("numbering/next: type 未指定は400", async () => {
  const res = await request(appFor()).get("/api/v2/documents/numbering/next").expect(400);
  assert.equal(res.body.code, "NUMBERING_TYPE_REQUIRED");
});

test("numbering/next: プレフィックス未設定の種別は404", async () => {
  const res = await request(appFor()).get("/api/v2/documents/numbering/next?type=unknown_type").expect(404);
  assert.equal(res.body.code, "NUMBERING_PREFIX_MISSING");
});

test("pending-pdf は /documents/:id より先に評価される（誤って詳細取得にならない）", async () => {
  // pending-pdf が :id="pending-pdf" として registry に吸われていないことを確認
  const res = await request(appFor()).get("/api/v2/documents/pending-pdf").expect(200);
  assert.ok(Array.isArray(res.body.rows));
});

test("history: 同一系列のバージョンを古い順に返す", async () => {
  const res = await request(appFor()).get("/api/v2/documents/1/history").expect(200);
  assert.equal(res.body.versions.length, 2);
  assert.deepEqual(res.body.versions.map((v: any) => v.documentNumber), ["ARC-PO-2026-0001", "ARC-PO-2026-0001-R1"]);
  assert.equal(res.body.versions[0].isPrimary, false);
  assert.equal(res.body.versions[1].isPrimary, true);
});

test("history: 系列を持たない文書は自身1件のみ", async () => {
  const res = await request(appFor()).get("/api/v2/documents/2/history").expect(200);
  assert.equal(res.body.versions.length, 1);
  assert.equal(res.body.versions[0].documentNumber, "ARC-PO-2026-0002");
});

test("lifecycle フィルタ: voided のみ／active のみを切り分ける", async () => {
  const app = appFor();
  const voided = await request(app).get("/api/v2/documents?lifecycle=voided").expect(200);
  assert.deepEqual(voided.body.documents.map((d: any) => d.id), [3]);
  const active = await request(app).get("/api/v2/documents?lifecycle=active").expect(200);
  assert.ok(!active.body.documents.some((d: any) => d.id === 3));
  assert.ok(active.body.documents.some((d: any) => d.id === 1));
});

// 同じ親POの確定済み検収書の明細履歴（検収済み行の支払日・金額の補完）。

function appWithInspectionHistory() {
  const registry = new MemoryDocumentRegistryRepository([]);
  const lookupDocs: MemoryLookupDoc[] = [
    {
      id: 10, documentNumber: "ARC-INS-2026-0201", issueKey: "LB-9",
      templateType: "inspection_certificate", driveLink: "",
      formData: {
        parent_po_number: "ARC-PO-2026-0117", paymentDueDate: "2026-08-31",
        inspectionCompletedAt: "2026-07-31",
        delivery_line_items: [
          { item_name: "キービジュアル", inspection_status: "now", inspected_amount_ex_tax: 100000, delivery_date: "2026-07-31" },
          { item_name: "対象外", inspection_status: "skip", inspected_amount_ex_tax: 1 }
        ]
      }
    },
    {
      id: 11, documentNumber: "ARC-INS-2026-0300", issueKey: "LB-10",
      templateType: "inspection_certificate", driveLink: "", lifecycleStatus: "reissued",
      formData: {
        parent_po_number: "ARC-PO-2026-0117",
        delivery_line_items: [{ item_name: "旧版の行", inspected_amount_ex_tax: 5 }]
      }
    },
    {
      id: 12, documentNumber: "ARC-INS-2026-0400", issueKey: "LB-11",
      templateType: "inspection_certificate", driveLink: "",
      formData: {
        parent_po_number: "ARC-PO-2099-9999",
        delivery_line_items: [{ item_name: "別POの行", inspected_amount_ex_tax: 7 }]
      }
    }
  ];
  const lookup = new MemoryDocumentLookupRepository(lookupDocs);
  return createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    documentRegistry: registry,
    documentLookup: lookup
  }, { accessMode: "readonly", requireDatabase: false });
}

test("inspection-history: 同じ親POの確定済み検収書から明細履歴を返す（skip・旧版・別POは除外）", async () => {
  const res = await request(appWithInspectionHistory())
    .get("/api/v2/documents/inspection-history?po=ARC-PO-2026-0117").expect(200);
  assert.equal(res.body.entries.length, 1);
  const entry = res.body.entries[0];
  assert.equal(entry.itemName, "キービジュアル");
  assert.equal(entry.amountExTax, 100000);
  assert.equal(entry.paidDate, "2026-08-31");            // 行に支払日が無いので文書の支払予定日
  assert.equal(entry.inspectionCompletedAt, "2026-07-31");
  assert.equal(entry.documentNumber, "ARC-INS-2026-0201");
});

test("inspection-history: po が無ければ400", async () => {
  const res = await request(appWithInspectionHistory())
    .get("/api/v2/documents/inspection-history").expect(400);
  assert.equal(res.body.code, "INSPECTION_HISTORY_PO_REQUIRED");
});
