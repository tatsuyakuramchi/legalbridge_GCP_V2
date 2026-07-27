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

