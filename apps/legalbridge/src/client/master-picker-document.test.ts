import assert from "node:assert/strict";
import test from "node:test";
import { buildPatch } from "./MasterDataPicker.js";
import type { DocumentFormSchema, TemplateField } from "../types";

// 「契約・文書」タブで基本契約を選んだときの差し込み。
const CONTRACT = {
  id: "12", type: "document" as const, label: "ARC-OUT-2025-0007",
  description: "制作業務委託基本契約・株式会社エー",
  values: {
    document_number: "ARC-OUT-2025-0007",
    template_type: "outsourcing",
    CONTRACT_TITLE: "制作業務委託基本契約"
  }
};

const schemaOf = (...fields: TemplateField[]): DocumentFormSchema =>
  ({ templateKey: "purchase_order", templateVersionId: 22, label: "発注書", fields } as DocumentFormSchema);

// 発注書の該当項目（056 で hidden から表示に変えたもの）。
const PURCHASE_ORDER = schemaOf(
  { name: "ORDER_NO", label: "発注番号", type: "text" },
  { name: "HAS_BASE_CONTRACT", label: "基本契約あり", type: "boolean" },
  { name: "MASTER_CONTRACT_REF", label: "基本契約名 / 番号", type: "text" }
);

test("基本契約を選ぶと契約名が入る", () => {
  const patch = buildPatch(PURCHASE_ORDER, {}, CONTRACT);
  assert.equal(patch.MASTER_CONTRACT_REF, "制作業務委託基本契約");
});

test("基本契約を選んだら「基本契約あり」も立てる", () => {
  // これが立たないと、契約名だけ入って PDF はスポット約款の条項で出ていた
  // （テンプレートは {{#if HAS_BASE_CONTRACT}} で準拠契約と約款を出し分ける）。
  assert.equal(buildPatch(PURCHASE_ORDER, {}, CONTRACT).HAS_BASE_CONTRACT, true);
});

test("発注書の発注番号は基本契約の番号で上書きしない", () => {
  // 発注書の ORDER_NO は自分の発注番号。ここに契約番号を入れると PDF の
  // 発注番号がその契約番号に化ける（buildCommonDocumentContext は ORDER_NO を優先する）。
  assert.equal("ORDER_NO" in buildPatch(PURCHASE_ORDER, {}, CONTRACT), false);
});

test("「親発注書番号」として持つテンプレートには ORDER_NO を入れる", () => {
  // maintenance_spec の ORDER_NO は親の発注書番号＝引用したい先。
  const schema = schemaOf({ name: "ORDER_NO", label: "親発注書番号", type: "text" });
  assert.equal(buildPatch(schema, {}, CONTRACT).ORDER_NO, "ARC-OUT-2025-0007");
});

test("親 PO・契約番号の項目には従来どおり番号を入れる", () => {
  const schema = schemaOf(
    { name: "parent_po_number", label: "発注番号 (親 PO 文書番号)", type: "text" },
    { name: "linked_contract_number", label: "契約番号", type: "text" },
    { name: "基本契約番号", label: "基本契約番号", type: "text" }
  );
  const patch = buildPatch(schema, {}, CONTRACT);
  assert.equal(patch.parent_po_number, "ARC-OUT-2025-0007");
  assert.equal(patch.linked_contract_number, "ARC-OUT-2025-0007");
  assert.equal(patch.基本契約番号, "ARC-OUT-2025-0007");
});

test("基本契約名の項目が無いテンプレートではフラグを立てない", () => {
  // 検収書のように親 PO を引くだけの文書に「基本契約あり」を立ててはいけない。
  const schema = schemaOf(
    { name: "parent_po_number", label: "発注番号 (親 PO 文書番号)", type: "text" },
    { name: "HAS_BASE_CONTRACT", label: "基本契約あり", type: "boolean" }
  );
  assert.equal("HAS_BASE_CONTRACT" in buildPatch(schema, {}, CONTRACT), false);
});

test("契約名が無い文書は番号を契約名に使う", () => {
  const patch = buildPatch(PURCHASE_ORDER, {},
    { ...CONTRACT, values: { document_number: "ARC-NDA-2026-0001", template_type: "nda" } });
  assert.equal(patch.MASTER_CONTRACT_REF, "ARC-NDA-2026-0001");
  assert.equal(patch.HAS_BASE_CONTRACT, true);
});

test("項目を持たないテンプレートには何も入れない", () => {
  assert.deepEqual(buildPatch(schemaOf({ name: "件名", label: "件名" }), {}, CONTRACT), {});
});


test("海外取引先の銀行口座を海外発注書の送金欄へ引用できる", () => {
  const schema = {
    ...schemaOf(
      { name: "BANK_NAME", label: "Beneficiary Bank", type: "text" },
      { name: "BRANCH_NAME", label: "Branch", type: "hidden", hidden: true, readonly: true },
      { name: "ACCOUNT_NUMBER", label: "Account Number", type: "hidden", hidden: true, readonly: true },
      { name: "SWIFT_BIC", label: "SWIFT / BIC", type: "hidden", hidden: true, readonly: true },
      { name: "IBAN", label: "IBAN", type: "hidden", hidden: true, readonly: true },
      { name: "ROUTING_NUMBER", label: "Routing / ABA / Sort Code", type: "hidden", hidden: true, readonly: true },
      { name: "ACCOUNT_HOLDER", label: "Account Holder", type: "hidden", hidden: true, readonly: true },
      { name: "ACCOUNT_HOLDER_LOCAL", label: "Local Account Holder", type: "text" },
      { name: "BANK_COUNTRY", label: "Bank Country", type: "hidden", hidden: true, readonly: true },
      { name: "BANK_ADDRESS", label: "Bank Address", type: "hidden", hidden: true, readonly: true },
      { name: "BANK_CURRENCY", label: "Currency", type: "hidden", hidden: true, readonly: true },
      { name: "INTERMEDIARY_BANK_NAME", label: "Intermediary Bank", type: "hidden", hidden: true, readonly: true },
      { name: "INTERMEDIARY_BANK_SWIFT", label: "Intermediary Bank SWIFT", type: "hidden", hidden: true, readonly: true },
      { name: "INTERMEDIARY_BANK", label: "Intermediary Bank (combined)", type: "text" }
    ),
    templateKey: "intl_purchase_order"
  };
  const patch = buildPatch(schema, {}, {
    id: "88", type: "vendor" as const, label: "Noa Vassalli",
    values: {
      vendor_name: "Noa Vassalli",
      entity_type: "個人",
      bank_name: "Intesa Sanpaolo S.p.A.",
      branch_name: "Milano Centro",
      account_number: "00000067552",
      account_scope: "overseas",
      swift_bic: "BCITITMM",
      iban: "IT77A0306909400100000067552",
      routing_number: "03069",
      account_holder_name: "NOA VASSALLI",
      account_holder_kana: "Noa Vassalli",
      bank_country: "IT",
      bank_address: "Piazza Paolo Ferrari 10, Milano, Italy",
      currency: "EUR",
      intermediary_bank_name: "Correspondent Bank",
      intermediary_bank_swift: "CORRITMM"
    }
  });
  assert.equal(patch.BANK_NAME, "Intesa Sanpaolo S.p.A.");
  assert.equal(patch.BRANCH_NAME, "Milano Centro");
  assert.equal(patch.ACCOUNT_NUMBER, "00000067552");
  assert.equal(patch.SWIFT_BIC, "BCITITMM");
  assert.equal(patch.IBAN, "IT77A0306909400100000067552");
  assert.equal(patch.ROUTING_NUMBER, "03069");
  assert.equal(patch.ACCOUNT_HOLDER, "NOA VASSALLI");
  assert.equal(patch.ACCOUNT_HOLDER_LOCAL, "Noa Vassalli");
  assert.equal(patch.BANK_COUNTRY, "IT");
  assert.equal(patch.BANK_ADDRESS, "Piazza Paolo Ferrari 10, Milano, Italy");
  assert.equal(patch.BANK_CURRENCY, "EUR");
  assert.equal(patch.INTERMEDIARY_BANK_NAME, "Correspondent Bank");
  assert.equal(patch.INTERMEDIARY_BANK_SWIFT, "CORRITMM");
  assert.equal(patch.INTERMEDIARY_BANK, "Correspondent Bank / CORRITMM");
});
