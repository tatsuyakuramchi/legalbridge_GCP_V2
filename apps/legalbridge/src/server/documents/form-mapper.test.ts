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

