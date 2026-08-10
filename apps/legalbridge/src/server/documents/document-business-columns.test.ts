import assert from "node:assert/strict";
import test from "node:test";
import { deriveRecordType, firstTextValue, PARTY_NAME_KEYS, TITLE_KEYS } from "./document-business-columns.js";

// V1（services/worker/server.ts:9676 の分岐）と同じ結果になることを固定する。

test("record_type: 発注・検収は individual_contract", () => {
  assert.equal(deriveRecordType("purchase_order"), "individual_contract");
  assert.equal(deriveRecordType("intl_purchase_order"), "individual_contract");
  assert.equal(deriveRecordType("inspection_certificate"), "individual_contract");
});

test("record_type: ライセンス・ロイヤリティは license_condition", () => {
  assert.equal(deriveRecordType("license_master"), "license_condition");
  assert.equal(deriveRecordType("individual_license_terms"), "license_condition");
  assert.equal(deriveRecordType("royalty_statement"), "license_condition");
});

test("record_type: 出版系は pub_master_* だけ master_contract（license を含む語より優先）", () => {
  assert.equal(deriveRecordType("pub_master_individual"), "master_contract");
  assert.equal(deriveRecordType("pub_master_corporate"), "master_contract");
  // pub_license_terms は 'license' を含むが publication_condition が正（V1 Phase 25.6）
  assert.equal(deriveRecordType("pub_license_terms"), "publication_condition");
  assert.equal(deriveRecordType("pub_additional_terms"), "publication_condition");
});

test("record_type: その他は master_contract（V1 既定）", () => {
  assert.equal(deriveRecordType("nda"), "master_contract");
  assert.equal(deriveRecordType("legal_response"), "master_contract");
  assert.equal(deriveRecordType("service_master"), "master_contract");
});

test("firstTextValue: 候補キー順で最初の非空文字列を返す", () => {
  assert.equal(firstTextValue({ VENDOR_NAME: "  株式会社A  " }, PARTY_NAME_KEYS), "株式会社A");
  assert.equal(firstTextValue({ VENDOR_NAME: "", 取引先: "B社" }, PARTY_NAME_KEYS), "B社");
  assert.equal(firstTextValue({ PROJECT_TITLE: "作品X 発注" }, TITLE_KEYS), "作品X 発注");
  assert.equal(firstTextValue({ CONTRACT_TITLE: 123 }, TITLE_KEYS), null);   // 文字列以外は無視
  assert.equal(firstTextValue({}, TITLE_KEYS), null);
  assert.equal(firstTextValue(null, TITLE_KEYS), null);
});
