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

// ── 個人の取引先に担当者・部署・代表者は無い（V1 と同じ規則）─────────────
// V1: purchaseOrder.tsx「担当者・部署は法人の概念。個人取引先では空にする」
// V2 はマスタの値をそのまま引いていたため、担当者名に口座名義カナが入っている
// 取引先で宛名の下に「<カナ>　<カナ> 様」が出ていた（実データ11件）。
const CONTACT_FIELDS = schemaOf(
  { name: "VENDOR_NAME", label: "発注先 名称" },
  { name: "VENDOR_CONTACT_DEPARTMENT", label: "担当部署", group: "II. 発注先 (取引先)" },
  { name: "VENDOR_CONTACT_NAME", label: "担当者名", group: "II. 発注先 (取引先)" },
  { name: "VENDOR_REPRESENTATIVE_SAMA", label: "代表者名 (＋様)", group: "II. 発注先 (取引先)" },
  { name: "VENDOR_CONTACT_PHONE", label: "TEL", group: "II. 発注先 (取引先)" }
);

const individual = (extra: Record<string, unknown> = {}) => ({
  id: "1", type: "vendor" as const, label: "斎田明也", description: "",
  values: {
    vendor_name: "斎田明也", entity_type: "個人", phone: "090-7254-6167",
    account_holder_kana: "サイタ　アキヤ", ...extra
  }
});

test("個人ではマスタに担当者名があっても空にする", () => {
  const patch = buildPatch(CONTACT_FIELDS, {},
    individual({ contact_name: "サイタ　アキヤ", contact_department: "サイタ　アキヤ" }));
  assert.equal(patch.VENDOR_CONTACT_NAME, "");
  assert.equal(patch.VENDOR_CONTACT_DEPARTMENT, "");
});

test("個人では代表者欄も空にする", () => {
  const patch = buildPatch(CONTACT_FIELDS, {}, individual({ vendor_rep: "斎田明也" }));
  assert.equal(patch.VENDOR_REPRESENTATIVE_SAMA, "");
});

test("個人でも電話・宛名は引く（連絡先は個人にもある）", () => {
  const patch = buildPatch(CONTACT_FIELDS, {}, individual({ contact_name: "サイタ　アキヤ" }));
  assert.equal(patch.VENDOR_NAME, "斎田明也");
  assert.equal(patch.VENDOR_CONTACT_PHONE, "090-7254-6167");
});

test("法人では担当者・部署を従来どおり引く", () => {
  const patch = buildPatch(CONTACT_FIELDS, {}, {
    id: "2", type: "vendor", label: "株式会社ビー", description: "",
    values: {
      vendor_name: "株式会社ビー", entity_type: "法人",
      contact_name: "田中 一郎", contact_department: "経理部", vendor_rep: "山田 花子"
    }
  });
  assert.equal(patch.VENDOR_CONTACT_NAME, "田中 一郎");
  assert.equal(patch.VENDOR_CONTACT_DEPARTMENT, "経理部");
});

test("代表者欄は敬称込みで入れる（項目名が「代表者名 (＋様)」）", () => {
  // ラベル推定に任せると敬称なしの氏名が入り、テンプレートは敬称を足さない。
  const patch = buildPatch(CONTACT_FIELDS, {}, {
    id: "2", type: "vendor", label: "株式会社ビー", description: "",
    values: { vendor_name: "株式会社ビー", entity_type: "法人", vendor_rep: "山田 花子" }
  });
  assert.equal(patch.VENDOR_REPRESENTATIVE_SAMA, "山田 花子 様");
});

test("代表者が未登録なら担当者名を代表者として使う（V1 と同じ）", () => {
  const patch = buildPatch(CONTACT_FIELDS, {}, {
    id: "2", type: "vendor", label: "株式会社ビー", description: "",
    values: { vendor_name: "株式会社ビー", entity_type: "法人", contact_name: "田中 一郎" }
  });
  assert.equal(patch.VENDOR_REPRESENTATIVE_SAMA, "田中 一郎 様");
});

test("代表者も担当者も無い法人では代表者欄を空にする（「null 様」を出さない）", () => {
  const patch = buildPatch(CONTACT_FIELDS, {}, {
    id: "2", type: "vendor", label: "株式会社ビー", description: "",
    values: { vendor_name: "株式会社ビー", entity_type: "法人" }
  });
  assert.equal(patch.VENDOR_REPRESENTATIVE_SAMA, "");
});

test("個人ではラベル推定の担当者欄も空にする", () => {
  const schema = schemaOf({ name: "受託者担当者", label: "担当者", group: "受託者" });
  assert.equal(buildPatch(schema, {}, individual({ contact_name: "サイタ　アキヤ" })).受託者担当者, "");
});

test("個人では dbField 対応の担当者欄も空にする", () => {
  const schema = schemaOf({ name: "先方担当", label: "担当", dbField: "vendor.contact_name" });
  assert.equal(buildPatch(schema, {}, individual({ contact_name: "サイタ　アキヤ" })).先方担当, "");
});

test("区分（法人/個人）はスキーマに欄が無くても vendorEntityType として記録する", () => {
  // license_master には区分の入力欄が無い。法人専用項目（代表者）の必須解除と
  // PDF の法人/個人出し分けのため、マスタ引用時に formData へ区分を記録する。
  const licenseMaster = schemaOf(
    { name: "VENDOR_NAME", label: "ライセンサー名称" },
    { name: "VENDOR_REP", label: "ライセンサー代表者" }
  );
  const individual = buildPatch(licenseMaster, {}, vendorWithClearedContact);
  assert.equal(individual.vendorEntityType, "個人");
  const corporate = buildPatch(licenseMaster, {}, {
    id: "1", type: "vendor" as const, label: "株式会社エー", description: "",
    values: { vendor_name: "株式会社エー", entity_type: "法人", vendor_rep: "代表 太郎" }
  });
  assert.equal(corporate.vendorEntityType, "法人");
  assert.equal(corporate.VENDOR_REP, "代表 太郎");
  // 区分がマスタに無い取引先では記録しない（誤った必須解除を防ぐ）。
  const unknown = buildPatch(licenseMaster, {}, {
    id: "2", type: "vendor" as const, label: "区分未設定商店", description: "",
    values: { vendor_name: "区分未設定商店" }
  });
  assert.equal("vendorEntityType" in unknown, false);
});

test("担当者の引用はスキーマに欄が無くても通知先（STAFF_*）へ常に反映する", () => {
  // license_master などは STAFF_* の入力欄を持たないが、通知条項が参照する。
  // 担当者タブで選んだ人が、ログインユーザーの自動補完を上書きできること。
  const licenseMaster = schemaOf({ name: "VENDOR_NAME", label: "ライセンサー名称" });
  const patch = buildPatch(licenseMaster, {}, {
    id: "7", type: "staff" as const, label: "山田 太郎", description: "",
    values: { staff_name: "山田 太郎", department: "編集部", email: "yamada@example.co.jp", phone: "03-1111-2222" }
  });
  assert.equal(patch.STAFF_NAME, "山田 太郎");
  assert.equal(patch.STAFF_DEPARTMENT, "編集部");
  assert.equal(patch.STAFF_EMAIL, "yamada@example.co.jp");
  assert.equal(patch.STAFF_PHONE, "03-1111-2222");
});
