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
  assert.equal(validateDocumentForm(schema.templateKey, schema.fields, result).length, 0);
});

// 必須チェックは「画面に出ている項目」だけ。隠れた必須項目が空でも検証を通す
// （検収書の明細モードで単票フォールバック項目が必須のまま塞がっていた＝プレビュー不出）。

test("検収書: 明細があるとき単票フォールバックの必須項目は検証しない", () => {
  const fields = [
    { name: "deliveredAmountStr", label: "納品額", required: true },
    { name: "description", label: "成果物", required: true },
    { name: "counterparty", label: "相手方", required: true }
  ];
  const withLines = {
    delivery_line_items: [{ item_name: "キービジュアル", inspected_amount_ex_tax: 50000 }],
    counterparty: "株式会社エー"
  };
  assert.deepEqual(validateDocumentForm("inspection_certificate", fields, withLines), []);
  // 明細が無い（単票モード）なら従来どおり必須
  const withoutLines = { counterparty: "株式会社エー" };
  assert.equal(validateDocumentForm("inspection_certificate", fields, withoutLines).length, 2);
  // 可視の必須項目が空なら明細があっても止める
  assert.equal(
    validateDocumentForm("inspection_certificate", fields, { ...withLines, counterparty: "" }).length, 1);
});

test("showWhen で隠れている必須項目は検証しない", () => {
  const fields = [
    { name: "detail", label: "詳細", required: true, showWhen: { field: "mode", anyOf: ["full"] } }
  ];
  assert.deepEqual(validateDocumentForm("purchase_order", fields, { mode: "simple" }), []);
  assert.equal(validateDocumentForm("purchase_order", fields, { mode: "full" }).length, 1);
});

test("計算書: 構造化入力中は自動計算欄の必須を検証しない", () => {
  const fields = [{ name: "grossRoyaltyStr", label: "グロス", required: true }];
  const structured = { rsCalcType: "event", rsMsrp: 6000 };
  assert.deepEqual(validateDocumentForm("royalty_statement", fields, structured), []);
  assert.equal(validateDocumentForm("royalty_statement", fields, {}).length, 1);
});


test("license_master: 許諾者が個人ならライセンサー代表者（必須）を検証しない", () => {
  const fields = [
    { name: "VENDOR_NAME", label: "ライセンサー名称", required: true },
    { name: "VENDOR_REP", label: "ライセンサー代表者", required: true }
  ];
  // 個人（マスタ引用が vendorEntityType を記録）→ 代表者は空でも通る。
  const individual = validateDocumentForm("license_master", fields,
    { VENDOR_NAME: "山田 太郎", vendorEntityType: "個人" });
  assert.equal(individual.length, 0);
  // 法人 → 従来どおり必須。
  const corporate = validateDocumentForm("license_master", fields,
    { VENDOR_NAME: "株式会社エー", vendorEntityType: "法人" });
  assert.deepEqual(corporate.map((e) => e.field), ["VENDOR_REP"]);
  // 区分未記録（手入力）→ 従来どおり必須のまま。
  const unknown = validateDocumentForm("license_master", fields, { VENDOR_NAME: "山田 太郎" });
  assert.deepEqual(unknown.map((e) => e.field), ["VENDOR_REP"]);
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
