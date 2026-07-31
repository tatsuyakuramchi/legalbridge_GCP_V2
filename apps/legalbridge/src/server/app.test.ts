import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { MemoryDraftRepository } from "./documents/draft-repository.js";
import { MemoryTemplateRepository } from "./documents/template-repository.js";
import { createIntegrationAdapters } from "./integrations/index.js";
import type { DocumentFormSchema } from "../types.js";
import { buildIndividualLicenseV3Context, individualLicenseV3Fields } from "./documents/individual-license-v3.js";
import { inspectTemplateCompatibility } from "./documents/compatibility.js";
import { buildCommonDocumentContext } from "./documents/context-adapter.js";
import { buildTemplateDocumentContext } from "./documents/template-context-adapters.js";
import { MemoryMasterDataRepository } from "./master-data/repository.js";
import { MemoryDocumentRegistryRepository } from "./documents/registry-repository.js";

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
    formData: { PROJECT_TITLE: "新商品制作", VENDOR_NAME: "取引先A" }
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

  const detail = await request(target).get("/api/v2/documents/101").expect(200);
  assert.equal(detail.body.document.formData.PROJECT_TITLE, "新商品制作");
});

test("不正な文書IDを拒否する", async () => {
  await request(app()).get("/api/v2/documents/not-a-number").expect(400);
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
