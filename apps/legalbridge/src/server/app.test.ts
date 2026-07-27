import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { MemoryDraftRepository } from "./documents/draft-repository.js";
import { MemoryTemplateRepository } from "./documents/template-repository.js";
import { createIntegrationAdapters } from "./integrations/index.js";
import type { DocumentFormSchema } from "../types.js";

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
