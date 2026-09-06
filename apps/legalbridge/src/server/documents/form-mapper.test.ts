import assert from "node:assert/strict";
import test from "node:test";
import { buildDocumentFormContext, validateDocumentForm } from "./form-mapper.js";

test("dbFieldの初期値へ下書きを優先適用する", () => {
  const schema = {
    templateKey: "purchase_order",
    templateVersionId: 1,
    label: "発注書",
    fields: [
      { name: "PROJECT_TITLE", required: true, dbField: "backlog.summary" },
      { name: "VENDOR_NAME", dbField: "vendor.vendor_name" }
    ]
  };
  const result = buildDocumentFormContext(
    schema,
    {
      backlog: { summary: "自動件名" },
      vendor: { vendor_name: "取引先A" }
    },
    { PROJECT_TITLE: "下書き件名", legacy_key: "keep" }
  );

  assert.equal(result.PROJECT_TITLE, "下書き件名");
  assert.equal(result.VENDOR_NAME, "取引先A");
  assert.equal(result.legacy_key, "keep");
  assert.equal(validateDocumentForm(schema.fields, result).length, 0);
});

test("案件・取引先・作品のDB情報を旧フィールド名へ自動補完する", () => {
  const schema = {
    templateKey: "legacy_contract",
    templateVersionId: 1,
    label: "旧契約",
    fields: [
      { name: "PROJECT_TITLE", required: true },
      { name: "VENDOR_NAME", required: true },
      { name: "VENDOR_ADDRESS" },
      { name: "STAFF_NAME" },
      { name: "対象作品予定名" },
      { name: "linked_contract_number" },
      { name: "COMPANY_NAME" }
    ]
  };
  const result = buildDocumentFormContext(schema, {
    backlog: { summary: "海外利用許諾契約" },
    vendor: { vendor_name: "Example GmbH", address: "Berlin" },
    staff: { staff_name: "法務担当" },
    work: { title: "対象作品" },
    document: { document_number: "CT-2026-0001" },
    company: { name: "株式会社アークライト" }
  });
  assert.equal(result.PROJECT_TITLE, "海外利用許諾契約");
  assert.equal(result.VENDOR_NAME, "Example GmbH");
  assert.equal(result.VENDOR_ADDRESS, "Berlin");
  assert.equal(result.STAFF_NAME, "法務担当");
  assert.equal(result["対象作品予定名"], "対象作品");
  assert.equal(result.linked_contract_number, "CT-2026-0001");
  assert.equal(result.COMPANY_NAME, "株式会社アークライト");
});
