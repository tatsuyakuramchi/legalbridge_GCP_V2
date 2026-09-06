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

test("業務委託の依頼情報を発注明細と選択項目へ自動補完する", () => {
  const schema = {
    templateKey: "purchase_order",
    templateVersionId: 1,
    label: "発注書",
    fields: []
  };
  const result = buildDocumentFormContext(schema, {
    backlog: {
      summary: "イベント運営業務",
      details: "会場進行と当日スタッフ管理",
      engagement_type: "準委任",
      service_category: "イベント企画立案運営業務",
      deadline: "2026-10-31"
    },
    vendor: { withholding_enabled: true }
  });

  assert.equal(result.SERVICE_ENGAGEMENT_TYPE, "準委任");
  assert.equal(result.SERVICE_CATEGORY, "イベント企画立案運営業務");
  assert.equal(result.WITHHOLDING_TAX, "対象");
  assert.deepEqual(result.items, [{
    item_name: "イベント企画立案運営業務",
    spec: "会場進行と当日スタッフ管理",
    engagement_type: "準委任",
    inspection_method: "完了報告確認",
    quantity: 1,
    delivery_date: "2026-10-31"
  }]);
});

test("業務委託の保存済み下書きをDB自動補完より優先する", () => {
  const schema = { templateKey: "service_master", templateVersionId: 1, label: "業務委託基本契約", fields: [] };
  const result = buildDocumentFormContext(schema, {
    backlog: { engagement_type: "準委任" },
    document: { SERVICE_ENGAGEMENT_TYPE: "請負" }
  }, { SERVICE_ENGAGEMENT_TYPE: "レベニューシェア" });

  assert.equal(result.SERVICE_ENGAGEMENT_TYPE, "レベニューシェア");
});
