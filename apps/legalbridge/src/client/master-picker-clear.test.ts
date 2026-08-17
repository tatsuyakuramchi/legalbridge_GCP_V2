import assert from "node:assert/strict";
import test from "node:test";
import { buildPatch } from "./MasterDataPicker.js";
import type { DocumentFormSchema, TemplateField } from "../types";

// マスタを直しても情報が残る、という報告の再現。
// 取引先マスタで担当部署・担当者名を消したあと、フォームで同じ取引先を引き直しても
// 前の値が残っていた（null を「触らない」として飛ばしていたため）。
const schemaOf = (...fields: TemplateField[]): DocumentFormSchema =>
  ({ templateKey: "purchase_order", templateVersionId: 22, label: "発注書", fields } as DocumentFormSchema);

const PURCHASE_ORDER = schemaOf(
  { name: "VENDOR_NAME", label: "発注先 名称" },
  { name: "VENDOR_ADDRESS", label: "発注先 住所" },
  { name: "VENDOR_CONTACT_DEPARTMENT", label: "担当部署", group: "II. 発注先 (取引先)" },
  { name: "VENDOR_CONTACT_NAME", label: "担当者名", group: "II. 発注先 (取引先)" },
  { name: "BANK_NAME", label: "金融機関名" }
);

// マスタで担当部署・担当者名を空にした取引先（列は返るが null）。
const vendorWithClearedContact = {
  id: "556", type: "vendor" as const, label: "大神貴寛", description: "",
  values: {
    vendor_name: "大神貴寛", entity_type: "個人", address: "東京都…",
    contact_department: null, contact_name: null,
    phone: null, email: null, vendor_rep: null,
    bank_name: "みずほ銀行"
  }
};

test("マスタで消した項目はフォームからも消える", () => {
  const patch = buildPatch(PURCHASE_ORDER, {}, vendorWithClearedContact);
  assert.equal(patch.VENDOR_CONTACT_DEPARTMENT, "");
  assert.equal(patch.VENDOR_CONTACT_NAME, "");
});

test("消す指示として patch に載せる（キーを落とさない）", () => {
  // キーが無いと呼び出し側の { ...current, ...patch } で前の値が生き残る。
  const patch = buildPatch(PURCHASE_ORDER, {}, vendorWithClearedContact);
  assert.ok("VENDOR_CONTACT_DEPARTMENT" in patch);
  assert.ok("VENDOR_CONTACT_NAME" in patch);
});

test("値のある項目は従来どおり入る", () => {
  const patch = buildPatch(PURCHASE_ORDER, {}, vendorWithClearedContact);
  assert.equal(patch.VENDOR_NAME, "大神貴寛");
  assert.equal(patch.VENDOR_ADDRESS, "東京都…");
  assert.equal(patch.BANK_NAME, "みずほ銀行");
});

test("マスタが返していない列は触らない", () => {
  // 口座情報は権限によって返らない。返っていない列を空にすると、
  // 権限の無い利用者が引用しただけで既存の口座を消してしまう。
  const patch = buildPatch(PURCHASE_ORDER, {},
    { ...vendorWithClearedContact, values: { vendor_name: "大神貴寛", entity_type: "個人" } });
  assert.equal("BANK_NAME" in patch, false);
  assert.equal("VENDOR_ADDRESS" in patch, false);
});

test("dbField 対応の項目も同じ規則で空にする", () => {
  const schema = schemaOf({ name: "取引先電話", label: "電話", dbField: "vendor.phone" });
  assert.equal(buildPatch(schema, {}, vendorWithClearedContact).取引先電話, "");
});

test("ラベル推定で引く項目も空にする", () => {
  // 対応表に無い項目名はラベルから役割を推定して引いている。こちらも同じ規則。
  const schema = schemaOf({ name: "受託者担当者", label: "担当者", group: "受託者" });
  assert.equal(buildPatch(schema, {}, vendorWithClearedContact).受託者担当者, "");
});

test("ラベル推定は最初に当たった役割だけを使う", () => {
  // 「代表者名称」で代表者が空のとき、以前は次の規則に流れて会社名が入っていた。
  const schema = schemaOf({ name: "取引先代表者名称", label: "代表者名称", group: "取引先" });
  assert.equal(buildPatch(schema, {}, vendorWithClearedContact).取引先代表者名称, "");
});

test("敬称と区分はマスタから導出したままにする", () => {
  const schema = schemaOf(
    { name: "VENDOR_IS_CORPORATION", label: "発注先区分" },
    { name: "VENDOR_SUFFIX", label: "敬称" }
  );
  const patch = buildPatch(schema, {}, vendorWithClearedContact);
  assert.equal(patch.VENDOR_IS_CORPORATION, "個人");
  assert.equal(patch.VENDOR_SUFFIX, "様");
});
