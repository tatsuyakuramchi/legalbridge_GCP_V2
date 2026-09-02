import assert from "node:assert/strict";
import test from "node:test";
import {
  V3_FIXED_DEALS, acquisitionFromTemplateType, buildLicenseTermsSeed,
  emptyIntakeMaterial, fixedDealRows, materialCreatePayload, materialFromDocument,
  rightsSourceCreatePayload
} from "./work-intake.js";

// 作品登録 → 個別利用許諾条件書V3 の橋渡し（承認済みモックのロジック）。

test("取引形態は固定3種（id 1/2/3・計算モデル紐づき・V1準拠）", () => {
  assert.deepEqual(V3_FIXED_DEALS.map((d) => d.id), [1, 2, 3]);
  assert.deepEqual(V3_FIXED_DEALS.map((d) => d.calc_type), ["BASE_QTY_RATE", "BASE_RATE", "SUPPLY_QTY"]);
  assert.deepEqual(V3_FIXED_DEALS.map((d) => d.addon), [true, false, true]);
  // fixedDealRows はコピーを返す（フォーム編集で定義が汚れない）。
  const rows = fixedDealRows();
  rows[0].mg = "999";
  assert.equal(V3_FIXED_DEALS[0].mg, "0");
});

test("引用文書からの取得形態の推定（発注書＝買切・委託／許諾系＝ライセンス）", () => {
  assert.equal(acquisitionFromTemplateType("purchase_order"), "buyout_commission");
  assert.equal(acquisitionFromTemplateType("intl_purchase_order"), "buyout_commission");
  assert.equal(acquisitionFromTemplateType("individual_license_terms_v3"), "license");
  assert.equal(acquisitionFromTemplateType("license_master"), "license");
});

test("引用文書から素材行を組み立てる（買切はロイヤリティ対象外・根拠文書つき）", () => {
  const fromPo = materialFromDocument({
    id: 117, documentNumber: "ARC-PO-2026-0117", templateType: "purchase_order",
    title: "キャラクターイラスト制作", counterparty: "株式会社クリエイト"
  });
  assert.equal(fromPo.acquisitionType, "buyout_commission");
  assert.equal(fromPo.royalty, false);
  assert.equal(fromPo.materialType, "illustration");
  assert.equal(fromPo.holderLabel, "株式会社クリエイト");
  assert.equal(fromPo.sourceDocId, 117);
  assert.equal(fromPo.sourceDocNumber, "ARC-PO-2026-0117");

  const fromIlt = materialFromDocument({
    id: 3, documentNumber: "ILT-2026-0003", templateType: "individual_license_terms_v3",
    title: "原作ゲームB 利用許諾", counterparty: "株式会社オリジナル"
  });
  assert.equal(fromIlt.acquisitionType, "license");
  assert.equal(fromIlt.royalty, true);
});

test("素材の登録payload（買切=自社帰属・許諾=license・先頭が既定素材）", () => {
  const license = { ...emptyIntakeMaterial("株式会社オリジナル", 55), name: "原作ゲーム", royalty: true };
  const payload = materialCreatePayload(21, license, true);
  assert.equal(payload.workId, 21);
  assert.equal(payload.rightsType, "license");
  assert.equal(payload.rightsHolderVendorId, 55);
  assert.equal(payload.isDefault, true);
  assert.equal(payload.isRoyaltyBearing, true);

  const buyout = { ...emptyIntakeMaterial("株式会社クリエイト"), name: "イラスト", acquisitionType: "buyout_commission" };
  const second = materialCreatePayload(21, buyout, false);
  assert.equal(second.rightsType, "owned");
  assert.equal(second.isDefault, false);
  assert.equal("rightsHolderVendorId" in second, false);
});

test("権利ソースpayloadは引用元文書がある素材だけ（種別は取得形態で出し分け）", () => {
  const noSource = { ...emptyIntakeMaterial(), name: "原作" };
  assert.equal(rightsSourceCreatePayload(9, noSource), null);
  const licensed = { ...emptyIntakeMaterial("", 55), name: "原作", sourceDocId: 3, sourceDocNumber: "ILT-2026-0003" };
  assert.deepEqual(rightsSourceCreatePayload(9, licensed), {
    materialId: 9, sourceType: "upstream_license", sourceDocumentId: 3,
    rightsHolderVendorId: 55, isPrimary: true
  });
  const bought = { ...licensed, acquisitionType: "buyout_commission", holderVendorId: null };
  assert.equal(rightsSourceCreatePayload(9, bought)?.sourceType, "direct_contract");
});

test("条件書シード: 素材コードはサーバ採番を使い、料率はロイヤリティ対象だけ", () => {
  const original = { ...emptyIntakeMaterial("株式会社オリジナル", 55),
    name: "原作ゲーム", royalty: true, r1: "5", r2: "50", r3: "3", mg: "300000",
    sourceDocNumber: "LIC-2026-0015" };
  const illustration = { ...emptyIntakeMaterial("株式会社クリエイト"),
    name: "キャラクターイラスト", acquisitionType: "buyout_commission",
    region: "日本", language: "日本語", r1: "9" };   // 対象外なので r1 は無視される
  const seed = buildLicenseTermsSeed(
    { workCode: "WRK-00021", title: "コラボゲーム", holderLabel: "株式会社オリジナル" },
    [
      { material: original, materialCode: "WRK-00021-001" },
      { material: illustration, materialCode: "WRK-00021-002" }
    ]);
  assert.equal(seed.work_id, "WRK-00021");
  assert.equal(seed.対象製品予定名, "コラボゲーム");
  assert.equal(seed.Licensor_氏名会社名, "株式会社オリジナル");
  const conds = seed.v3_conds as Array<Record<string, unknown>>;
  assert.equal(conds.length, 3);
  assert.equal(conds[0].calc_type, "BASE_QTY_RATE");
  assert.equal(conds[0].mg, "300000");   // 素材MGの合算が代表（取引形態1）へ
  const lcs = seed.v3_lcs as Array<Record<string, unknown>>;
  assert.equal(lcs.length, 2);
  assert.deepEqual(lcs[0], {
    material_code: "WRK-00021-001", name: "原作ゲーム", holder: "株式会社オリジナル",
    region: "全世界", language: "全言語", source_doc: "LIC-2026-0015",
    rates: { "1": "5", "2": "50", "3": "3" }
  });
  assert.deepEqual(lcs[1].rates, {});     // ロイヤリティ対象外は料率なし
  assert.equal(lcs[1].material_code, "WRK-00021-002");
});

test("条件書シード: 名前が空の素材行は載せない・MG無しなら既定の0のまま", () => {
  const seed = buildLicenseTermsSeed(
    { workCode: null, title: "作品X", holderLabel: "" },
    [{ material: emptyIntakeMaterial(), materialCode: "WRK-1-001" }]);
  assert.deepEqual(seed.v3_lcs, []);
  assert.equal((seed.v3_conds as Array<Record<string, unknown>>)[0].mg, "0");
  assert.equal(seed.work_id, "");
});

// ── 既存文書の一括アップロード計画（巻き直し＝版の系列）──────────────────

test("planDocumentUploads: 1ファイルなら本番号・件名は拡張子なしファイル名", async () => {
  const { planDocumentUploads } = await import("./work-intake.js");
  assert.deepEqual(
    planDocumentUploads({ docNumber: "PO-2025-0083", fileNames: ["発注書_イラスト一式.pdf"] }),
    [{ documentNumber: "PO-2025-0083", title: "発注書_イラスト一式", supersededBy: "" }]);
});

test("planDocumentUploads: 巻き直しは旧版に枝番と旧版マーク・最後だけ有効版", async () => {
  const { planDocumentUploads } = await import("./work-intake.js");
  const plans = planDocumentUploads({
    docNumber: " LIC-2024-0012 ",
    fileNames: ["利用許諾契約.pdf", "利用許諾契約_巻き直し2025.pdf", "利用許諾契約_巻き直し2026.pdf"]
  });
  assert.deepEqual(plans, [
    { documentNumber: "LIC-2024-0012-v1", title: "利用許諾契約（旧版・巻き直し済）", supersededBy: "LIC-2024-0012" },
    { documentNumber: "LIC-2024-0012-v2", title: "利用許諾契約_巻き直し2025（旧版・巻き直し済）", supersededBy: "LIC-2024-0012" },
    { documentNumber: "LIC-2024-0012", title: "利用許諾契約_巻き直し2026", supersededBy: "" }
  ]);
});

test("stripFileExtension: 拡張子だけ落とす（ドット入りファイル名は保持）", async () => {
  const { stripFileExtension } = await import("./work-intake.js");
  assert.equal(stripFileExtension("契約 v2.1 最終.docx"), "契約 v2.1 最終");
  assert.equal(stripFileExtension("拡張子なし"), "拡張子なし");
});

// ── 展開区分と「この作品から作る文書」──────────────────────────────────

test("documentChoicesForWork: 展開区分で文書の選択肢が絞られる（未設定は全部）", async () => {
  const { documentChoicesForWork } = await import("./work-intake.js");
  const keys = (line: string | null) => documentChoicesForWork(line).map((c) => c.templateKey);
  assert.deepEqual(keys("game"), ["individual_license_terms_v3", "purchase_order"]);
  assert.deepEqual(keys("publishing"), ["pub_license_terms", "pub_master", "purchase_order"]);
  assert.deepEqual(keys("both"), ["individual_license_terms_v3", "pub_license_terms", "pub_master", "purchase_order"]);
  assert.deepEqual(keys(null), ["individual_license_terms_v3", "pub_license_terms", "pub_master", "purchase_order"]);
});

test("vendorRecordToPickerValues: camelCase→マスタ行・担当者メール優先・未取得の口座は undefined", async () => {
  const { vendorRecordToPickerValues } = await import("./work-intake.js");
  const values = vendorRecordToPickerValues({
    id: 12, vendorName: "スタジオ雨宿り", entityType: "法人", email: "info@amayadori.example",
    contactEmail: "tantou@amayadori.example", phone: "03-0000-0000", contactName: "雨宿 花子",
    address: "東京都…", vendorRep: "代表取締役 雨宿 太郎", invoiceRegistrationNumber: "T1234567890123"
  });
  assert.equal(values.vendor_name, "スタジオ雨宿り");
  assert.equal(values.entity_type, "法人");
  assert.equal(values.email, "tantou@amayadori.example");   // 担当者メールが優先
  assert.equal(values.vendor_rep, "代表取締役 雨宿 太郎");
  assert.equal(values.bank_name, undefined);                  // 管理者以外には届かない＝触らない
  // 担当者メールが空なら代表メール
  assert.equal(vendorRecordToPickerValues({ email: "info@x.example", contactEmail: "" }).email, "info@x.example");
});

test("resolvePubMasterTemplate: 個人なら個人書式・それ以外は法人書式", async () => {
  const { resolvePubMasterTemplate } = await import("./work-intake.js");
  assert.equal(resolvePubMasterTemplate("個人"), "pub_master_individual");
  assert.equal(resolvePubMasterTemplate("法人"), "pub_master_corporate");
  assert.equal(resolvePubMasterTemplate(null), "pub_master_corporate");
});
