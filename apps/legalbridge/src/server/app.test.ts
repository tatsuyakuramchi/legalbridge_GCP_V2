import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { MemoryDraftRepository } from "./documents/draft-repository.js";
import { MemoryDocumentFinalizationRepository } from "./documents/finalization-repository.js";
import { MemoryTemplateRepository } from "./documents/template-repository.js";
import { createIntegrationAdapters } from "./integrations/index.js";
import type { DocumentFormSchema } from "../types.js";
import { buildIndividualLicenseV3Context, individualLicenseV3Fields } from "./documents/individual-license-v3.js";
import { inspectTemplateCompatibility } from "./documents/compatibility.js";
import { buildCommonDocumentContext } from "./documents/context-adapter.js";
import { buildTemplateDocumentContext } from "./documents/template-context-adapters.js";
import { MemoryMasterDataRepository } from "./master-data/repository.js";
import { MemoryDocumentRegistryRepository } from "./documents/registry-repository.js";
import { MemoryMatterRepository } from "./matters/repository.js";
import { MemoryLedgerRepository } from "./ledgers/repository.js";
import { formatLedgerDate } from "./ledgers/repository.js";
import { MemoryGlobalSearchRepository } from "./search/repository.js";
import { MemoryAdminRepository } from "./admin/repository.js";
import { MemoryPdfRenderer } from "./documents/pdf-renderer.js";
import { MemorySlackNotificationHistoryRepository } from "./integrations/slack-history-repository.js";
import { MemorySlackNotificationApprovalRepository } from "./integrations/slack-approval-repository.js";
import { MemoryOutboundConditionRepository } from "./ledgers/outbound-condition-repository.js";
import { MemoryAppSettingsRepository } from "./settings/settings-repository.js";
import { MemorySecretStore } from "./settings/secret-store.js";
import {
  MemoryConditionSyncRepository, type ConditionSyncRepository
} from "./documents/condition-sync-repository.js";
import { MemoryRoyaltyEventRepository } from "./royalty/event-repository.js";
import { MemoryConditionLedgerRepository } from "./conditions/ledger-repository.js";

const schema: DocumentFormSchema = {
  templateKey: "purchase_order",
  templateVersionId: 10,
  label: "発注書",
  fields: [
    {
      name: "PROJECT_TITLE",
      label: "件名",
      required: true,
      dbField: "backlog.summary"
    },
    {
      name: "ORDER_DATE",
      label: "発行日",
      type: "date",
      required: true,
      dbField: "auto.today"
    }
  ]
};

function app() {
  return createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["drafts"])
  });
}

function readOnlyApp() {
  return createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readonly",
    requireDatabase: false
  });
}

test("DB template由来のフォーム定義を返す", async () => {
  const response = await request(app())
    .get("/api/v2/document-templates/purchase_order/form-schema")
    .expect(200);
  assert.equal(response.body.templateVersionId, 10);
  assert.equal(response.body.fields[0].name, "PROJECT_TITLE");
});

test("下書きを保存して復元する", async () => {
  const target = app();
  const saved = await request(target)
    .put("/api/v2/document-drafts/LOCAL-10")
    .send({
      templateType: "purchase_order",
      formData: {
        PROJECT_TITLE: "新しい発注",
        ORDER_DATE: "2026-07-27",
        compatibility_key: "keep"
      },
      updatedBy: "local@example.com"
    })
    .expect(200);

  const restored = await request(target)
    .get("/api/v2/document-drafts/LOCAL-10")
    .query({ template_type: "purchase_order" })
    .expect(200);

  assert.equal(restored.body.draft.formData.PROJECT_TITLE, "新しい発注");
  assert.equal(restored.body.draft.formData.compatibility_key, "keep");
  assert.equal(saved.body.draft.updatedBy, "local@example.com");

  const removed = await request(target)
    .delete("/api/v2/document-drafts/LOCAL-10")
    .query({ template_type: "purchase_order" })
    .expect(200);
  assert.equal(removed.body.removed, true);

  await request(target)
    .get("/api/v2/document-drafts/LOCAL-10")
    .query({ template_type: "purchase_order" })
    .expect(404);
});

test("書込検証環境で下書き一覧を検索しフォーム内容を返さない", async () => {
  const target = app();
  await request(target)
    .put("/api/v2/document-drafts/VALIDATION-LIST-1")
    .send({
      templateType: "purchase_order",
      formData: { PROJECT_TITLE: "一覧テスト" },
      updatedBy: "legal@example.com"
    })
    .expect(200);
  await request(target)
    .put("/api/v2/document-drafts/OTHER-1")
    .send({ templateType: "purchase_order", formData: { PROJECT_TITLE: "対象外" } })
    .expect(200);

  const response = await request(target)
    .get("/api/v2/document-drafts")
    .query({ q: "VALIDATION-LIST", limit: 10 })
    .expect(200);

  assert.equal(response.body.drafts.length, 1);
  assert.equal(response.body.drafts[0].issueKey, "VALIDATION-LIST-1");
  assert.equal(response.body.drafts[0].updatedBy, "legal@example.com");
  assert.equal(response.body.drafts[0].formData, undefined);
});

test("読取専用環境では下書き一覧を公開しない", async () => {
  const response = await request(readOnlyApp())
    .get("/api/v2/document-drafts")
    .expect(403);
  assert.equal(response.body.code, "DRAFT_WORKSPACE_DISABLED");
});

test("表示時と異なるtemplate版では検証を停止する", async () => {
  const response = await request(app())
    .post("/api/v2/documents/validate")
    .send({
      templateKey: "purchase_order",
      templateVersionId: 9,
      formData: {}
    })
    .expect(409);
  assert.equal(response.body.currentTemplateVersionId, 10);
});

test("DB templateの現行版でHTMLをプレビューする", async () => {
  const response = await request(app())
    .post("/api/v2/documents/preview")
    .send({
      templateKey: "purchase_order",
      templateVersionId: 10,
      formData: {
        PROJECT_TITLE: "新商品制作",
        VENDOR_NAME: "取引先A",
        ORDER_DATE: "2026-07-27"
      }
    })
    .expect(200);
  assert.match(response.body.html, /新商品制作/);
  assert.equal(response.body.templateVersionId, 10);
});

test("旧Worker互換helperと日付展開を使ってプレビューする", async () => {
  const helperApp = createApp({
    templates: new MemoryTemplateRepository(
      [schema],
      {
        purchase_order:
          "<p>{{concat PROJECT_TITLE ' / ' ORDER_DATE_YEAR}}</p><p>{{formatYen AMOUNT}}</p>"
      }
    ),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  });
  const response = await request(helperApp)
    .post("/api/v2/documents/preview")
    .send({
      templateKey: "purchase_order",
      templateVersionId: 10,
      formData: {
        PROJECT_TITLE: "制作業務",
        ORDER_DATE: "2026-07-28",
        AMOUNT: 120000
      }
    })
    .expect(200);
  assert.match(response.body.html, /制作業務 \/ 2026/);
  assert.match(response.body.html, /¥ 120,000/);
});

test("DBのpartialを登録して文書プレビューへ展開する", async () => {
  const partialApp = createApp({
    templates: new MemoryTemplateRepository(
      [schema],
      { purchase_order: "<main>{{PROJECT_TITLE}}{{> terms_spot_2026}}</main>" },
      { terms_spot_2026: "<footer>共通条件：{{ORDER_DATE}}</footer>" }
    ),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  });
  const response = await request(partialApp)
    .post("/api/v2/documents/preview")
    .send({
      templateKey: "purchase_order",
      templateVersionId: 10,
      formData: {
        PROJECT_TITLE: "制作業務",
        ORDER_DATE: "2026-07-28"
      }
    })
    .expect(200);
  assert.match(response.body.html, /共通条件：2026-07-28/);
  assert.deepEqual(response.body.partials, ["terms_spot_2026"]);
});

test("読取専用環境では下書き保存を拒否する", async () => {
  const response = await request(readOnlyApp())
    .put("/api/v2/document-drafts/LOCAL-10")
    .send({
      templateType: "purchase_order",
      formData: { PROJECT_TITLE: "保存されないデータ" }
    })
    .expect(403);
  assert.equal(response.body.code, "READ_ONLY_MODE");
});

test("readwrite環境でも明示スコープなしでは下書き保存を拒否する", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set()
  });
  const response = await request(target)
    .put("/api/v2/document-drafts/VALIDATION-1")
    .send({ templateType: "purchase_order", formData: { PROJECT_TITLE: "保存されない" } })
    .expect(403);
  assert.equal(response.body.code, "WRITE_SCOPE_DISABLED");
});

test("draftsスコープは下書きだけを許可し他の書込を拒否する", async () => {
  await request(app())
    .put("/api/v2/document-drafts/VALIDATION-1")
    .send({ templateType: "purchase_order", formData: { PROJECT_TITLE: "検証下書き" } })
    .expect(200);
  const response = await request(app()).post("/api/v2/matters").send({ title: "作成禁止" }).expect(403);
  assert.equal(response.body.code, "WRITE_SCOPE_DISABLED");
});

test("documentsスコープなしでは文書確定を拒否する", async () => {
  const response = await request(app())
    .post("/api/v2/documents/finalize")
    .send({})
    .expect(403);
  assert.equal(response.body.code, "WRITE_SCOPE_DISABLED");
});

test("過去文書取込の後入力パスは documents スコープでゲートを通す", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["documents"])
  });
  // ゲートを通過してルータ側の判定（リポジトリ未構成=503）に到達すること。
  // 403 WRITE_SCOPE_DISABLED になったらゲートの許可リスト漏れ（本番で取込が全滅する）。
  for (const call of [
    request(target).post("/api/v2/documents/import/upload").send({}),
    request(target).put("/api/v2/documents/1/import-details").send({ formData: {} }),
    request(target).put("/api/v2/documents/1/display-fields").send({ title: "x" })
  ]) {
    const response = await call;
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "DOCUMENT_IMPORT_UNAVAILABLE");
  }
  // documents スコープが無ければ従来どおり 403。
  const denied = await request(app()).put("/api/v2/documents/1/import-details").send({ formData: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "WRITE_SCOPE_DISABLED");
});

test("文書確定は検証済み下書きを発番し外部連携を停止したまま削除する", async () => {
  const drafts = new MemoryDraftRepository();
  const finalizations = new MemoryDocumentFinalizationRepository();
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts,
    finalizations,
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["drafts", "documents"])
  });

  const saved = await request(target)
    .put("/api/v2/document-drafts/VALIDATION-FINALIZE-1")
    .send({
      templateType: "purchase_order",
      formData: {
        PROJECT_TITLE: "文書確定テスト",
        ORDER_DATE: "2026-07-31"
      },
      updatedBy: "legal@example.com"
    })
    .expect(200);

  const finalized = await request(target)
    .post("/api/v2/documents/finalize")
    .send({
      issueKey: "VALIDATION-FINALIZE-1",
      templateType: "purchase_order",
      templateVersionId: 10,
      formData: saved.body.draft.formData,
      expectedDraftUpdatedAt: saved.body.draft.updatedAt,
      createdBy: "legal@example.com"
    })
    .expect(201);

  assert.match(finalized.body.document.documentNumber, /^ARC-TEST-/);
  assert.equal(finalized.body.integrations.drive, "disabled");
  assert.equal(finalized.body.integrations.backlog, "disabled");
  await request(target)
    .get("/api/v2/document-drafts/VALIDATION-FINALIZE-1")
    .query({ template_type: "purchase_order" })
    .expect(404);

  const runtime = await request(target).get("/api/v2/runtime").expect(200);
  assert.deepEqual(runtime.body.writeCapabilities, ["drafts", "documents"]);
});

test("確定時に金銭条件が条件明細台帳へ同期される（同期失敗でも確定は成立し警告）", async () => {
  const makeApp = (conditionSync: ConditionSyncRepository) => createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    finalizations: new MemoryDocumentFinalizationRepository(),
    conditionSync,
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["drafts", "documents"])
  });
  const finalizeVia = async (target: ReturnType<typeof createApp>) => {
    const saved = await request(target)
      .put("/api/v2/document-drafts/VALIDATION-CSYNC-1")
      .send({
        templateType: "purchase_order",
        formData: {
          PROJECT_TITLE: "条件同期テスト", ORDER_DATE: "2026-08-25",
          financial_conditions: [{ condition_no: 1, condition_name: "利用許諾料", rate_pct: 10 }]
        }
      })
      .expect(200);
    return request(target).post("/api/v2/documents/finalize").send({
      issueKey: "VALIDATION-CSYNC-1", templateType: "purchase_order", templateVersionId: 10,
      formData: saved.body.draft.formData,
      expectedDraftUpdatedAt: saved.body.draft.updatedAt
    });
  };

  const memory = new MemoryConditionSyncRepository();
  const ok = await finalizeVia(makeApp(memory)).then((r) => r);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.integrations.conditions, "synced");
  assert.deepEqual(ok.body.conditionSync, { written: 1, deleted: 0 });
  const docLines = memory.documents.get(ok.body.document.id);
  assert.equal(docLines?.get(1)?.condition_name, "利用許諾料");

  // 権限未付与（42501）でも確定は成立し、grant 066 の案内が警告として返る。
  const failing: ConditionSyncRepository = {
    async upsertDocumentConditions() {
      const error = new Error("permission denied") as Error & { code?: string };
      error.code = "42501";
      throw error;
    },
    async moveConditions() { return 0; }
  };
  const warned = await finalizeVia(makeApp(failing)).then((r) => r);
  assert.equal(warned.status, 201);
  assert.equal(warned.body.integrations.conditions, "warning");
  assert.match(warned.body.conditionSyncWarning, /grant 066/);
});

test("条件台帳（condition_ledger_id）から起こした文書の確定は条件を作り直さず台帳へ紐づけるだけ（二重防止）", async () => {
  const conditionSync = new MemoryConditionSyncRepository();
  const conditionLedgers = new MemoryConditionLedgerRepository(false);
  const ledgerInput = {
    entry: "new" as const, workId: null, workCode: null, workTitle: "", vendorId: 7, vendorName: "雨宿り", title: "別件",
    termStart: "", termEnd: "", kinds: ["service" as const], payments: [], expenses: [], fees: [], licenseIn: [], licenseOut: [],
    status: "final" as const, notes: ""
  };
  await conditionLedgers.create(ledgerInput, null);   // id=1 は別件（確定文書の id=1 と区別するため）
  const ledger = await conditionLedgers.create({
    entry: "new", workId: null, workCode: null, workTitle: "", vendorId: 7, vendorName: "雨宿り", title: "制作",
    termStart: "", termEnd: "", kinds: ["service"], payments: [], expenses: [], fees: [], licenseIn: [], licenseOut: [],
    status: "final", notes: ""
  }, "legal@example.com");
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    finalizations: new MemoryDocumentFinalizationRepository(),
    conditionSync, conditionLedgers,
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite", requireDatabase: false, writeFeaturesEnabled: true,
    writeScopes: new Set(["drafts", "documents"])
  });
  const saved = await request(target).put("/api/v2/document-drafts/VALIDATION-LEDGER-1").send({
    templateType: "purchase_order",
    formData: {
      PROJECT_TITLE: "台帳起点", ORDER_DATE: "2026-09-04", condition_ledger_id: String(ledger.id),
      // 台帳から引用した条件が form_data に入っていても、確定で同期しない
      financial_conditions: [{ condition_no: 1, condition_name: "原作", rate_pct: 5 }]
    }
  }).expect(200);
  const finalized = await request(target).post("/api/v2/documents/finalize").send({
    issueKey: "VALIDATION-LEDGER-1", templateType: "purchase_order", templateVersionId: 10,
    formData: saved.body.draft.formData, expectedDraftUpdatedAt: saved.body.draft.updatedAt
  }).expect(201);
  assert.equal(finalized.body.integrations.conditions, "ledger");
  assert.equal(finalized.body.conditionLedger.id, ledger.id);
  assert.equal(conditionSync.documents.size, 0);
  assert.equal(conditionLedgers.links.get(finalized.body.document.id), ledger.id);
});

test("計算書の確定で消化イベントが自動記帳される（条件明細ひも付け時・サーバ再計算値）", async () => {
  const royaltySchema: DocumentFormSchema = {
    templateKey: "royalty_statement", templateVersionId: 20, label: "利用許諾料計算書", fields: []
  } as DocumentFormSchema;
  const royaltyEvents = new MemoryRoyaltyEventRepository(new Set([1]), new Set([1]));
  const target = createApp({
    templates: new MemoryTemplateRepository([royaltySchema]),
    drafts: new MemoryDraftRepository(),
    finalizations: new MemoryDocumentFinalizationRepository(),
    royaltyEvents,
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    royaltyEventWritesEnabled: true,
    writeScopes: new Set(["drafts", "documents", "royalty-events"])
  });
  const saved = await request(target)
    .put("/api/v2/document-drafts/VALIDATION-ROY-1")
    .send({
      templateType: "royalty_statement",
      formData: {
        statementMode: "single", rsConditionLineId: 1, rsCalcType: "period", rsBasisKind: "sales",
        rsMsrp: 2000000, rsRatePct: 8, rsPeriodFrom: "2026-04-01", rsPeriodTo: "2026-06-30"
      }
    })
    .expect(200);
  const finalized = await request(target).post("/api/v2/documents/finalize").send({
    issueKey: "VALIDATION-ROY-1", templateType: "royalty_statement", templateVersionId: 20,
    formData: saved.body.draft.formData,
    expectedDraftUpdatedAt: saved.body.draft.updatedAt
  }).expect(201);
  assert.equal(finalized.body.integrations.royaltyEvent, "recorded");
  assert.equal(royaltyEvents.events.length, 1);
  // サーバ再計算: ceil(2,000,000 × 8%) = 160,000（MG/AG なし）
  assert.equal(royaltyEvents.events[0].amountExTax, 160000);
  assert.equal(royaltyEvents.events[0].conditionLineId, 1);
  assert.equal(royaltyEvents.events[0].documentId, finalized.body.document.id);
  assert.equal(royaltyEvents.events[0].period, "2026-06");
});

test("読取専用環境でも入力検証とプレビューを許可する", async () => {
  await request(readOnlyApp())
    .post("/api/v2/documents/validate")
    .send({
      templateKey: "purchase_order",
      templateVersionId: 10,
      formData: {
        PROJECT_TITLE: "プレビュー対象",
        ORDER_DATE: "2026-07-27"
      }
    })
    .expect(200);

  await request(readOnlyApp())
    .post("/api/v2/documents/preview")
    .send({
      templateKey: "purchase_order",
      templateVersionId: 10,
      formData: { PROJECT_TITLE: "プレビュー対象" }
    })
    .expect(200);
});

test("マスターデータを検索してフォーム自動入力候補を返す", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    masterData: new MemoryMasterDataRepository([
      {
        id: "vendor-1",
        type: "vendor",
        label: "取引先A",
        description: "V-001・法人",
        values: {
          vendor_name: "取引先A",
          address: "東京都千代田区"
        }
      }
    ])
  });

  const response = await request(target)
    .get("/api/v2/master-data/search")
    .query({ type: "vendor", q: "取引先" })
    .expect(200);

  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].values.vendor_name, "取引先A");
});

test("未対応のマスターデータ種別を拒否する", async () => {
  await request(app())
    .get("/api/v2/master-data/search")
    .query({ type: "unknown" })
    .expect(400);
});

test("登録文書の一覧検索と詳細を読取専用で返す", async () => {
  const registeredDocument = {
    id: 101,
    documentNumber: "PO-ARC-202607-001",
    issueKey: "LEGAL-101",
    templateType: "purchase_order",
    templateVersionId: 10,
    title: "新商品制作",
    counterparty: "取引先A",
    driveLink: "https://drive.google.com/example",
    createdAt: "2026-07-30T01:00:00.000Z",
    createdBy: "legal@example.com",
    formData: {
      PROJECT_TITLE: "新商品制作",
      VENDOR_NAME: "取引先A",
      ACCOUNT_NUMBER: "12345678"
    }
  };
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    documentRegistry: new MemoryDocumentRegistryRepository([registeredDocument])
  }, {
    accessMode: "readonly",
    requireDatabase: false
  });

  const list = await request(target)
    .get("/api/v2/documents")
    .query({ q: "取引先A" })
    .expect(200);
  assert.equal(list.body.documents.length, 1);
  assert.equal(list.body.documents[0].documentNumber, "PO-ARC-202607-001");
  assert.equal(list.body.documents[0].formData, undefined);
  assert.equal(list.body.documents[0].lifecycle.state, "finalized");
  assert.equal(list.body.documents[0].lifecycle.pdfState, "ready");
  assert.equal(list.body.documents[0].lifecycle.driveState, "stored");

  const detail = await request(target).get("/api/v2/documents/101").expect(200);
  assert.equal(detail.body.document.formData.PROJECT_TITLE, "新商品制作");
  // マスキング撤廃（2026-08-19 利用者決定）: 口座番号等も実値で返す（PDF・帳票と一致させる）。
  assert.equal(detail.body.document.formData.ACCOUNT_NUMBER, "12345678");
  assert.equal(detail.body.document.lifecycle.label, "確定済み");
  assert.equal(detail.body.document.lifecycle.driveLabel, "Drive保存済み");
});

test("不正な文書IDを拒否する", async () => {
  await request(app()).get("/api/v2/documents/not-a-number").expect(400);
});

test("案件一覧と関連課題・タスク・文書を返す", async () => {
  const matter = {
    id: 22, matterCode: "MTR-2026-00022", title: "海外ライセンス契約更新",
    status: "in_progress", counterparty: "North Star Games",
    primaryIssueKey: "LEGAL-22", lifecycleStage: "counterparty_review",
    ownerName: "法務 田中", targetDueDate: "2026-08-05", blockedReason: null,
    issueCount: 1, documentCount: 1, openTaskCount: 1,
    nextTaskTitle: "修正版を確認", nextTaskDueAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z", remarks: "更新条件を確認",
    driveFolderUrl: "https://drive.google.com/matter"
  };
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    matters: new MemoryMatterRepository([{
      matter,
      issues: [{ issueKey: "LEGAL-22", relation: "primary", summary: "契約更新", note: null }],
      tasks: [{ id: 1, title: "修正版を確認", status: "open", assigneeName: "法務 田中", dueAt: "2026-08-01T00:00:00.000Z", isPrimary: true, blockedReason: null }],
      documents: [{ id: 10, documentNumber: "LIC-2026-022", templateType: "license_master", issueKey: "LEGAL-22", createdAt: "2026-07-30T00:00:00.000Z", driveLink: "https://drive.google.com/document" }]
    }])
  }, { accessMode: "readonly", requireDatabase: false });

  const list = await request(target).get("/api/v2/matters").query({ q: "North Star" }).expect(200);
  assert.equal(list.body.matters[0].matterCode, "MTR-2026-00022");
  const detail = await request(target).get("/api/v2/matters/22").expect(200);
  assert.equal(detail.body.issues[0].issueKey, "LEGAL-22");
  assert.equal(detail.body.documents[0].documentNumber, "LIC-2026-022");
});

test("不正な案件状態と案件IDを拒否する", async () => {
  await request(app()).get("/api/v2/matters").query({ status: "deleted" }).expect(400);
  await request(app()).get("/api/v2/matters/invalid").expect(400);
});

test("取引先・作品・金銭条件台帳を検索する", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    ledgers: new MemoryLedgerRepository([
      {
        id: "vendor-1", type: "vendors", code: "V-001", title: "取引先A",
        subtitle: "法人", detail: { メール: "ab***@example.com" }
      },
      {
        id: "work-1", type: "works", code: "W-001", title: "作品A",
        subtitle: "自社作品", detail: { 状態: "released" }
      },
      {
        id: "material-1", type: "materials", code: "MAT-001", title: "原作素材A",
        subtitle: "W-001・作品A・game_design", detail: { 権利区分: "license" }
      }
    ])
  }, { accessMode: "readonly", requireDatabase: false });
  const vendors = await request(target).get("/api/v2/ledgers/vendors").query({ q: "取引先" }).expect(200);
  assert.equal(vendors.body.items[0].code, "V-001");
  const works = await request(target).get("/api/v2/ledgers/works").query({ q: "作品" }).expect(200);
  assert.equal(works.body.items[0].title, "作品A");
  const materials = await request(target).get("/api/v2/ledgers/materials").query({ q: "原作素材" }).expect(200);
  assert.equal(materials.body.items[0].code, "MAT-001");
  await request(target).get("/api/v2/ledgers/unknown").expect(404);
});

test("DB日付をISO形式へ揃える（住所等のマスキングは2026-08-19に撤廃）", () => {
  assert.equal(formatLedgerDate(new Date("2026-08-23T00:00:00.000Z")), "2026-08-23");
  assert.equal(formatLedgerDate("2026-09-20"), "2026-09-20");
});

test("案件・文書・取引先・作品を横断検索する", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    search: new MemoryGlobalSearchRepository([
      { id: "1", target: "matter", title: "海外ライセンス契約", code: "MTR-001", description: "取引先A" },
      { id: "2", target: "document", title: "利用許諾契約書", code: "LEGAL-2", description: "license_master" },
      { id: "3", target: "vendor", title: "取引先A", code: "V-001", description: "法人" },
      { id: "work:4", target: "work", title: "作品A", code: "W-001", description: "自社作品" }
    ])
  }, { accessMode: "readonly", requireDatabase: false });
  const response = await request(target).get("/api/v2/search").query({ q: "取引先A" }).expect(200);
  assert.equal(response.body.results.length, 2);
  assert.deepEqual(response.body.results.map((item: { target: string }) => item.target), ["matter", "vendor"]);
  const shortQuery = await request(target).get("/api/v2/search").query({ q: "A" }).expect(200);
  assert.equal(shortQuery.body.results.length, 0);
});

test("管理画面用の主要データ件数と最終更新を返す", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    admin: new MemoryAdminRepository({
      counts: {
        templates: 19, partials: 1, documents: 831, matters: 199,
        vendors: 2003, staff: 20, works: 150, conditions: 600
      },
      activity: {
        latestDocumentAt: "2026-07-30T10:47:42.000Z",
        latestMatterAt: "2026-07-30T10:50:53.000Z"
      }
    })
  }, { accessMode: "readonly", requireDatabase: false });
  const response = await request(target).get("/api/v2/admin/overview").expect(200);
  assert.equal(response.body.counts.templates, 19);
  assert.equal(response.body.counts.documents, 831);
  assert.equal(response.body.activity.latestMatterAt, "2026-07-30T10:50:53.000Z");
});

test("管理者向け診断APIは機密設定を含めず稼働状態を返す", async () => {
  const response = await request(app())
    .get("/api/v2/admin/diagnostics")
    .expect(200);

  assert.equal(response.body.status, "warning");
  assert.equal(response.body.checks.database.status, "warning");
  assert.equal(response.body.checks.templates.failed, 0);
  assert.equal(response.body.checks.integrations.externalWritesDisabled, true);
  assert.equal(response.body.checks.writeSafety.driveEnabled, false);
  assert.deepEqual(response.body.checks.writeSafety.scopes, ["drafts"]);
  const serialized = JSON.stringify(response.body).toLowerCase();
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("token"), false);
});

test("Slack UXプレビューは外部送信せず七状態を返す", async () => {
  const response = await request(app())
    .get("/api/v2/admin/slack-ux-preview")
    .expect(200);

  assert.equal(response.body.mode, "preview");
  assert.equal(response.body.externalSend, false);
  assert.equal(response.body.notifications.length, 7);
  assert.equal(response.body.notifications[1].requesterStatus, "information_required");
  assert.equal(response.body.notifications[1].shouldNotify, true);
});

test("実案件からSlack通知候補を読取専用で返す", async () => {
  const matter = {
    id: 80,
    matterCode: "MTR-2026-00080",
    title: "取引基本契約の確認",
    status: "in_progress",
    counterparty: "取引先B",
    primaryIssueKey: "LEGAL-80",
    lifecycleStage: "internal_review",
    ownerName: "法務担当",
    targetDueDate: null,
    blockedReason: "依頼者から追加情報の回答待ち",
    issueCount: 1,
    documentCount: 0,
    openTaskCount: 1,
    nextTaskTitle: "不足情報を確認",
    nextTaskDueAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    remarks: null,
    driveFolderUrl: null
  };
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    matters: new MemoryMatterRepository([{
      matter,
      issues: [],
      tasks: [],
      documents: []
    }])
  }, { accessMode: "readonly", requireDatabase: false });

  const response = await request(target)
    .get("/api/v2/admin/slack-notification-candidates")
    .expect(200);

  assert.equal(response.body.externalSend, false);
  assert.equal(response.body.source, "matter_overview_v");
  assert.equal(response.body.summary.candidates, 1);
  assert.equal(response.body.candidates[0].issueKey, "LEGAL-80");
  assert.equal(
    response.body.candidates[0].notification.requesterStatus,
    "information_required"
  );
  assert.equal(response.body.candidates[0].deliveryState, "not_evaluated");
  assert.equal(response.body.history.connected, false);
  assert.equal(response.body.summary.ready, 0);
  assert.equal(response.body.summary.historyUnavailable, 1);
  assert.equal(response.body.candidates[0].eligibility, "history_unavailable");
  assert.match(response.body.candidates[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(response.body.dryRun.externalSend, false);
  assert.equal(response.body.dryRun.historyAppend, false);
  assert.equal(response.body.dryRun.queue[0].readiness, "blocked_history");
  assert.equal(response.body.dispatch.externalSend, false);
  assert.equal(response.body.dispatch.adapterConfigured, false);
  assert.equal(response.body.dispatch.queue[0].dispatchAllowed, false);
  assert.equal(response.body.approvals.configured, false);
  assert.equal(response.body.approvals.appendEnabled, false);
  assert.ok(response.body.dispatch.queue[0].blockers.includes("history_unavailable"));
});

test("通知履歴接続時だけ未通知候補を送信可能として返す", async () => {
  const matter = {
    id: 81,
    matterCode: "MTR-2026-00081",
    title: "契約完了通知",
    status: "closed",
    counterparty: "取引先C",
    primaryIssueKey: "LEGAL-81",
    lifecycleStage: "completed",
    ownerName: "法務担当",
    targetDueDate: null,
    blockedReason: null,
    issueCount: 1,
    documentCount: 1,
    openTaskCount: 0,
    nextTaskTitle: null,
    nextTaskDueAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    remarks: null,
    driveFolderUrl: null
  };
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    slackHistory: new MemorySlackNotificationHistoryRepository(),
    matters: new MemoryMatterRepository([{
      matter,
      issues: [],
      tasks: [],
      documents: []
    }])
  }, { accessMode: "readonly", requireDatabase: false });

  const response = await request(target)
    .get("/api/v2/admin/slack-notification-candidates")
    .expect(200);

  assert.equal(response.body.history.connected, true);
  assert.equal(response.body.history.status, "connected");
  assert.equal(response.body.summary.ready, 1);
  assert.equal(response.body.summary.historyUnavailable, 0);
  assert.equal(response.body.candidates[0].eligibility, "ready");
  assert.equal(response.body.summary.dryRunBlocked, 1);
  assert.equal(response.body.dryRun.recipientDirectoryResolved, false);
  assert.equal(response.body.dryRun.queue[0].readiness, "blocked_recipient");
  assert.equal(response.body.dryRun.queue[0].target.resolution, "missing_identity");
  assert.equal(response.body.summary.dispatchAllowed, 0);
  assert.equal(response.body.summary.dispatchBlocked, 1);
  assert.equal(response.body.dispatch.queue[0].statusLabel, "送信停止");
  assert.ok(response.body.dispatch.queue[0].blockers.includes("integration_local"));
  assert.ok(response.body.dispatch.queue[0].blockers.includes("approval_missing"));
  assert.ok(response.body.dispatch.queue[0].blockers.includes("adapter_unavailable"));
});

test("空field_schemaを補うV3基本フォーム定義を持つ", () => {
  assert.ok(individualLicenseV3Fields.length >= 20);
  assert.ok(individualLicenseV3Fields.some((field) => field.name === "Licensor_氏名会社名"));
});

test("V3の取引形態と構成要素から加算料率を構築する", () => {
  const context = buildIndividualLicenseV3Context({
    契約書番号: "LIC-TEST-1",
    v3_conds: [
      { id: "sale", name: "製造販売", addon: true },
      { id: "sub", name: "サブライセンス", addon: false, fixedRate: "50" }
    ],
    v3_lcs: [
      { material_code: "LO-1", name: "原作A", rates: { sale: "5" } },
      { material_code: "LO-2", name: "原作B", rates: { sale: "2" } }
    ]
  });
  assert.equal(context.contractNo, "LIC-TEST-1");
  assert.equal(context.conds[0].appliedRate, "7%");
  assert.equal(context.conds[1].appliedRate, "50%");
});

test("template互換性検査で不足helperとpartialを検出する", () => {
  const report = inspectTemplateCompatibility(schema, "<p>{{unknownHelper PROJECT_TITLE}}</p>{{> missing_terms}}", {});
  assert.equal(report.status, "error");
  assert.deepEqual(report.missingHelpers, ["unknownHelper"]);
  assert.deepEqual(report.missingPartials, ["missing_terms"]);
});
test("template互換性レポートAPIを返す", async () => {
  const response = await request(app()).get("/api/v2/document-templates/compatibility-report").expect(200);
  assert.equal(response.body.summary.total, 1);
  assert.equal(response.body.reports[0].templateKey, "purchase_order");
});

test("elseとeach内のローカル変数を誤検出しない", () => {
  const report = inspectTemplateCompatibility(schema, "{{#if PROJECT_TITLE}}ok{{else if VENDOR_NAME}}fallback{{/if}}{{#each items}}{{item_name}}{{formatYen amount}}{{/each}}", {});
  assert.ok(!report.missingHelpers.includes("else"));
  assert.ok(!report.unmappedVariables.includes("item_name"));
  assert.ok(!report.unmappedVariables.includes("amount"));
});

test("共通文書番号・担当者・再発行情報を互換キーへ展開する", () => {
  const context = buildCommonDocumentContext({
    契約書番号: "ARC-LIC-2026-0001",
    契約締結日: "2026-07-28",
    担当者名: "法務担当",
    担当者メール: "legal@example.com",
    元契約番号: "ARC-LIC-2025-0001",
    改訂番号: "2",
    取引先種別: "法人"
  });
  assert.equal(context.CONTRACT_NO, "ARC-LIC-2026-0001");
  assert.equal(context.DOC_NO, "ARC-LIC-2026-0001");
  assert.equal(context.SIGN_DATE, "2026-07-28");
  assert.equal(context.STAFF_NAME, "法務担当");
  assert.equal(context.BASE_DOC_NO, "ARC-LIC-2025-0001");
  assert.equal(context.REVISION, 2);
  assert.equal(context.isReissue, true);
  // 発注書テンプレートが eq VENDOR_IS_CORPORATION "法人" で比較するため、
  // boolean ではなく法人="法人" / 個人=空文字を返す（個人は falsy のまま）。
  assert.equal(context.VENDOR_IS_CORPORATION, "法人");
  assert.equal(context.VENDOR_SUFFIX, "御中");
});

test("共通生成キーとtemplate説明記号を未マッピング扱いしない", () => {
  const report = inspectTemplateCompatibility(
    schema,
    "{{CONTRACT_NO}}{{STAFF_NAME}}{{BASE_DOC_NO}}{{VAR \"説明\"}}{{xxx}}",
    {}
  );
  assert.ok(!report.unmappedVariables.includes("CONTRACT_NO"));
  assert.ok(!report.unmappedVariables.includes("STAFF_NAME"));
  assert.ok(!report.unmappedVariables.includes("BASE_DOC_NO"));
  assert.ok(!report.unmappedVariables.includes("VAR"));
  assert.ok(!report.unmappedVariables.includes("xxx"));
});

test("発注書の明細・経費・金銭条件をプレビュー用に集計する", () => {
  const context = buildTemplateDocumentContext("purchase_order", {
    ORDER_DATE: "2026-07-29",
    BANK_NAME: "サンプル銀行",
    BRANCH_NAME: "本店",
    items: [
      { item_name: "制作業務", unit_price: 10000, quantity: 2 },
      { item_name: "監修業務", amount_ex_tax: 5000 }
    ],
    expenses: [{ expense_name: "交通費", amount_inc_tax: 1100 }],
    financial_conditions: [{ calc_method: "ROYALTY", rights_holder: "受注者" }]
  });
  assert.equal(context.itemsSubtotalExTax, 25000);
  assert.equal(context.expensesTotalIncTax, 1100);
  assert.equal(context.BANK_INFO, "サンプル銀行 / 本店");
  assert.equal(context.has_license_conditions, true);
  assert.equal(context.has_performance_incentive, true);
  assert.equal(context.has_seller_owned_license, true);
});

test("個別利用許諾条件書の旧金銭条件を配列へ変換する", () => {
  const context = buildTemplateDocumentContext("individual_license_terms", {
    金銭条件1_地域言語ラベル: "国内・日本語",
    金銭条件1_計算方式: "ROYALTY",
    金銭条件1_料率: "5",
    金銭条件1_基準価格ラベル: "上代",
    金銭条件1_通貨: "JPY"
  });
  const conditions = context.financial_conditions as Array<Record<string, unknown>>;
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].calc_method, "ROYALTY");
  assert.match(String(context.金銭条件1_概要), /国内・日本語/);
});

test("利用許諾料計算書と検収書の合計額を再構築する", () => {
  const royalty = buildTemplateDocumentContext("royalty_statement", {
    taxRate: 10,
    lines: [
      { sales_amount: 100000, royalty_amount: 5000 },
      { sales_amount: 50000, royalty_amount: 2500 }
    ]
  });
  assert.equal(royalty.linesTotalSalesStr, "150,000");
  assert.equal(royalty.linesTotalPaymentStr, "7,500");
  assert.equal(royalty.linesTotalIncTaxStr, "8,250");

  const inspection = buildTemplateDocumentContext("inspection_certificate", {
    taxRate: 10,
    delivery_line_items: [{ inspected_amount_ex_tax: 10000, calc_method: "ROYALTY" }],
    other_fees: [{ amount: 1000 }],
    expenses: [{ amount_inc_tax: 500 }],
    CHANGE_RECORDS: "2026-07-29|金額|9000|10000|修正"
  });
  assert.equal(inspection.combinedTaxStr, "1,100");
  assert.equal(inspection.grandTotalPayableStr, "12,600");
  assert.equal(inspection.hasChangeLogs, true);
  assert.equal(inspection.hasPerformanceRoyalty, true);
});

test("残る6テンプレートの生成変数を互換性警告にしない", () => {
  const cases = [
    ["purchase_order", "{{items}}{{expensesTotalIncTax}}{{BANK_INFO}}"],
    ["intl_purchase_order", "{{itemsSubtotalExTax}}{{PAYMENT_TERMS}}"],
    ["individual_license_terms", "{{financial_conditions}}{{サブライセンシー一覧}}"],
    ["individual_license_terms_v3", "{{xxx}}"],
    ["royalty_statement", "{{lineGroups}}{{linesTotalPaymentStr}}"],
    ["inspection_certificate", "{{delivery_line_items}}{{grandTotalPayableStr}}"]
  ] as const;
  for (const [templateKey, html] of cases) {
    const report = inspectTemplateCompatibility({ ...schema, templateKey }, html, {});
    assert.deepEqual(report.unmappedVariables, []);
  }
});


test("PDFスコープ有効時だけ登録文書をPDFとして返す", async () => {
  const documentRegistry = new MemoryDocumentRegistryRepository([{
    id: 201,
    documentNumber: "ARC-PO-2026-0001",
    issueKey: "VALIDATION-PDF-1",
    templateType: "purchase_order",
    templateVersionId: 10,
    title: "PDF検証",
    counterparty: "検証先",
    driveLink: "",
    createdAt: "2026-07-31T00:00:00.000Z",
    createdBy: "legal@example.com",
    formData: {
      PROJECT_TITLE: "PDF検証",
      ORDER_DATE: "2026-07-31"
    }
  }]);
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    documentRegistry,
    pdfRenderer: new MemoryPdfRenderer()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["pdf"])
  });

  const response = await request(target)
    .get("/api/v2/documents/201/pdf")
    .expect("Content-Type", /application\/pdf/)
    .expect(200);
  assert.match(response.headers["content-disposition"], /ARC-PO-2026-0001\.pdf/);

  const runtime = await request(target).get("/api/v2/runtime").expect(200);
  assert.deepEqual(runtime.body.writeCapabilities, ["pdf"]);

  const disabled = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    documentRegistry,
    pdfRenderer: new MemoryPdfRenderer()
  }, {
    accessMode: "readonly",
    requireDatabase: false
  });
  const rejected = await request(disabled)
    .get("/api/v2/documents/201/pdf")
    .expect(403);
  assert.equal(rejected.body.code, "PDF_GENERATION_DISABLED");
});


test("Slack承認は専用scopeなしで拒否し外部送信しない", async () => {
  const approvals = new MemorySlackNotificationApprovalRepository();
  const dependencies = {
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    slackApprovals: approvals
  };
  const disabled = createApp(dependencies, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["drafts", "documents", "pdf"])
  });
  const rejected = await request(disabled)
    .post("/api/v2/admin/slack-notification-approvals")
    .send({
      issueKey: "LEGAL-1",
      fingerprint: "a".repeat(64),
      decision: "approved"
    })
    .expect(403);
  assert.equal(rejected.body.code, "WRITE_SCOPE_DISABLED");

  const enabled = createApp(dependencies, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["slack-approvals"])
  });
  const runtime = await request(enabled).get("/api/v2/runtime").expect(200);
  assert.deepEqual(runtime.body.writeCapabilities, ["slack-approvals"]);
  const unavailable = await request(enabled)
    .post("/api/v2/admin/slack-notification-approvals")
    .send({
      issueKey: "LEGAL-1",
      fingerprint: "a".repeat(64),
      decision: "approved"
    })
    .expect(503);
  assert.equal(unavailable.body.code, "SLACK_APPROVAL_UNAVAILABLE");
  assert.deepEqual(await approvals.listLatest(["LEGAL-1"]), []);
});


function outboundConditionPayload() {
  return {
    workId: "work:42",
    workLabel: "W-42 作品",
    counterpartyId: "18",
    counterpartyLabel: "V-18 相手方",
    transactionKind: "license",
    conditionName: "英語版ライセンス",
    documentNumber: "ARC-LIC-2026-0001",
    territory: "全世界",
    languages: ["英語"],
    exclusivity: "non_exclusive",
    sublicenseAllowed: false,
    currency: "USD",
    paymentScheme: "royalty",
    ratePct: 5
  };
}

test("アウト条件は専用フラグとscopeが揃わなければ保存しない", async () => {
  const repository = new MemoryOutboundConditionRepository();
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    outboundConditions: repository
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["outbound-conditions"]),
    outboundConditionWritesEnabled: false
  });

  const response = await request(target)
    .post("/api/v2/outbound-conditions")
    .send(outboundConditionPayload())
    .expect(403);
  assert.equal(response.body.code, "WRITE_SCOPE_DISABLED");
  assert.equal(repository.conditions.length, 0);
});

test("管理者は専用ゲート経由でアウト条件を保存し外部連携を起動しない", async () => {
  const repository = new MemoryOutboundConditionRepository();
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    outboundConditions: repository
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["outbound-conditions"]),
    outboundConditionWritesEnabled: true
  });

  const response = await request(target)
    .post("/api/v2/outbound-conditions")
    .send(outboundConditionPayload())
    .expect(201);
  assert.equal(response.body.condition.direction, "receivable");
  assert.deepEqual(response.body.integrations, {
    backlog: "disabled",
    slack: "disabled",
    drive: "disabled"
  });
  assert.equal(repository.conditions.length, 1);

  const runtime = await request(target).get("/api/v2/runtime").expect(200);
  assert.deepEqual(runtime.body.writeCapabilities, ["outbound-conditions"]);
});

test("法務担当者でも管理者指定がなければアウト条件を保存しない", async () => {
  const repository = new MemoryOutboundConditionRepository();
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    outboundConditions: repository
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["outbound-conditions"]),
    outboundConditionWritesEnabled: true,
    auth: {
      mode: "iap",
      adminEmails: new Set(["admin@example.com"]),
      legalEmails: new Set(["legal@example.com"]),
      requesterDomains: new Set(["example.com"])
    }
  });

  const response = await request(target)
    .post("/api/v2/outbound-conditions")
    .set("x-goog-authenticated-user-email", "accounts.google.com:legal@example.com")
    .set("x-goog-authenticated-user-id", "accounts.google.com:legal-user")
    .send(outboundConditionPayload())
    .expect(403);
  assert.equal(response.body.code, "OUTBOUND_CONDITION_ADMIN_REQUIRED");
  assert.equal(repository.conditions.length, 0);
});

// APIキー投入（/settings/secrets）がグローバル書込ガードを settings スコープで通過すること
// （回帰：許可リスト漏れで 403 WRITE_SCOPE_DISABLED になっていた）。
test("settings/secrets: settings スコープで書込ガードを通過して保存できる", async () => {
  const store = new MemorySecretStore();
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    appSettings: new MemoryAppSettingsRepository({}),
    secretStore: store
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["settings"]),
    appSettingsWriteEnabled: true
  });
  const response = await request(target)
    .post("/api/v2/settings/secrets")
    .send({ secrets: { BACKLOG_API_KEY: "backlog-key-value-123" } })
    .expect(200);
  assert.equal(response.body.saved, 1);
  assert.equal(await store.access("backlog-api-key"), "backlog-key-value-123");
});

// 案件Slack（スレッド作成）が matter-slack スコープで書込ガードを通過すること
// （回帰：許可リスト漏れで 403 WRITE_SCOPE_DISABLED になっていた）。
// Slack ライブ設定が無い環境ではルート側の 409 が返る＝ガードの 403 でないことを検証する。
test("matters/slack/thread: matter-slack スコープで書込ガードを通過する", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["matter-slack"])
  });
  const response = await request(target)
    .post("/api/v2/matters/1/slack/thread")
    .send({});
  assert.notEqual(response.status, 403);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "MATTER_SLACK_DISABLED");
});

test("matters/slack/thread: matter-slack スコープが無ければ書込ガードで403", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["drafts"])
  });
  const response = await request(target)
    .post("/api/v2/matters/1/slack/thread")
    .send({});
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "WRITE_SCOPE_DISABLED");
});

test("settings/secrets: settings スコープが無ければ書込ガードで403", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    appSettings: new MemoryAppSettingsRepository({}),
    secretStore: new MemorySecretStore()
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set(["drafts"])
  });
  const response = await request(target)
    .post("/api/v2/settings/secrets")
    .send({ secrets: { BACKLOG_API_KEY: "backlog-key-value-123" } })
    .expect(403);
  assert.equal(response.body.code, "WRITE_SCOPE_DISABLED");
});

test("文書検索は template で発注書だけに絞れる（検収書の親PO検索）", async () => {
  const target = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    masterData: new MemoryMasterDataRepository([
      { id: "1", type: "document", label: "ARC-PO-2026-0117",
        values: { document_number: "ARC-PO-2026-0117", template_type: "purchase_order" } },
      { id: "2", type: "document", label: "ARC-OUT-2025-0007",
        values: { document_number: "ARC-OUT-2025-0007", template_type: "outsourcing" } }
    ])
  });
  const filtered = await request(target)
    .get("/api/v2/master-data/search")
    .query({ type: "document", q: "", template: "purchase_order,intl_purchase_order" })
    .expect(200);
  assert.deepEqual(filtered.body.items.map((i: { id: string }) => i.id), ["1"]);
  // 絞り込み指定なしは従来どおり全文書。
  const all = await request(target)
    .get("/api/v2/master-data/search")
    .query({ type: "document", q: "" })
    .expect(200);
  assert.equal(all.body.items.length, 2);
});

test("V3条件書: Licensee通知先が空なら当社担当者（STAFF_*）から連結して補完する", () => {
  // 通知先欄（別紙頭書の Licensee：）が空で出ていた実障害。V1 は選択中担当者から
  // 「氏名 ／ 電話 ／ メール」を連結していた。STAFF_* はログイン担当者の自動補完
  // または「DBから引用→担当者」で入る。
  const filled = buildIndividualLicenseV3Context({
    STAFF_NAME: "山田 太郎", STAFF_PHONE: "03-1111-2222", STAFF_EMAIL: "yamada@example.co.jp"
  });
  assert.equal(filled.licenseeContact, "山田 太郎 ／ 03-1111-2222 ／ yamada@example.co.jp");
  // 欄への手入力・引用値があればそちらを優先する。
  const explicit = buildIndividualLicenseV3Context({
    Licensee_連絡先: "法務部 直通 03-9999-0000", STAFF_NAME: "山田 太郎"
  });
  assert.equal(explicit.licenseeContact, "法務部 直通 03-9999-0000");
  // どちらも無ければ空のまま。
  assert.equal(buildIndividualLicenseV3Context({}).licenseeContact, "");
});
