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
import { formatLedgerDate, maskLedgerAddress } from "./ledgers/repository.js";
import { MemoryGlobalSearchRepository } from "./search/repository.js";
import { MemoryAdminRepository } from "./admin/repository.js";
import { MemoryPdfRenderer } from "./documents/pdf-renderer.js";

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
  assert.equal(detail.body.document.formData.ACCOUNT_NUMBER, "****5678");
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
      }
    ])
  }, { accessMode: "readonly", requireDatabase: false });
  const vendors = await request(target).get("/api/v2/ledgers/vendors").query({ q: "取引先" }).expect(200);
  assert.equal(vendors.body.items[0].code, "V-001");
  const works = await request(target).get("/api/v2/ledgers/works").query({ q: "作品" }).expect(200);
  assert.equal(works.body.items[0].title, "作品A");
  await request(target).get("/api/v2/ledgers/unknown").expect(404);
});

test("個人住所を都道府県単位にマスクしDB日付をISO形式へ揃える", () => {
  assert.equal(maskLedgerAddress("東京都港区台場2-2-2", "個人"), "東京都（詳細非表示）");
  assert.equal(maskLedgerAddress("Seoul, Korea", "個人"), "住所詳細非表示");
  assert.equal(maskLedgerAddress("東京都千代田区", "法人"), "東京都千代田区");
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
  assert.equal(context.VENDOR_IS_CORPORATION, true);
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
