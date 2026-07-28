import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { MemoryDraftRepository } from "./documents/draft-repository.js";
import { MemoryTemplateRepository } from "./documents/template-repository.js";
import { createIntegrationAdapters } from "./integrations/index.js";
import type { DocumentFormSchema } from "../types.js";
import { buildIndividualLicenseV3Context, individualLicenseV3Fields } from "./documents/individual-license-v3.js";

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
