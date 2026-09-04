// 作品登録（作品＋素材＋イン条件）→ 個別利用許諾条件書V3 への橋渡し（純関数）。
//
// V1 の設計を踏襲する：
//   - 取引形態は固定3種（V1 V3LicenseMatrix の V3_FIXED_DEALS）。共通の固定軸に
//     することで構成要素の料率合算（加算型）と利用許諾計算が成立する。自由記載は
//     計算モデル不明の行を台帳に入れてしまうため廃止。
//   - 構成要素（v3_lcs）は素材マスタ（work_materials）由来のみ。素材コードの
//     手入力をやめ、条件同期（material_code → work_materials 結線）を確実にする。

import type { DocumentFormData } from "../types.js";

// ── 取引形態の固定3種（V1 準拠）───────────────────────────────────────
// id は 1/2/3 固定。構成要素の料率マップ（v3_lcs[].rates）のキーになるため変えない。
export const V3_FIXED_DEALS = [
  { id: 1, name: "自社製造・自社販売", calc_type: "BASE_QTY_RATE", addon: true,
    manufacturer: "Licensee", seller: "Licensee", maxReg: "全世界", maxLang: "全言語",
    basePrice: "上代（MSRP）× 数量", qty: "数量", ag: "0", mg: "0", cur: "JPY" },
  { id: 2, name: "権利許諾（サブライセンス）", calc_type: "BASE_RATE", addon: false,
    manufacturer: "Licensee", seller: "Sublicensee", maxReg: "全世界", maxLang: "全言語",
    basePrice: "許諾収入", qty: "1", ag: "0", mg: "0", cur: "JPY" },
  { id: 3, name: "自社製造・他社販売", calc_type: "SUPPLY_QTY", addon: true,
    manufacturer: "Licensee", seller: "販売店", maxReg: "全世界", maxLang: "全言語",
    basePrice: "供給価格 × 数量", qty: "数量", ag: "0", mg: "0", cur: "JPY" }
] as const;

export function fixedDealRows(): Array<Record<string, unknown>> {
  return V3_FIXED_DEALS.map((deal) => ({ ...deal }));
}

// 許諾地域・言語のプリセット（自由記載の揺れ＝「日本」「日本国内」が別物として
// 台帳に入りマトリクス集計が割れるのを防ぐ。datalist なので自由入力も可能）。
export const REGION_PRESETS = ["全世界", "日本", "全世界（日本を除く）", "北米", "欧州", "アジア", "中国", "韓国", "台湾"];
export const LANGUAGE_PRESETS = ["全言語", "日本語", "英語", "日本語・英語", "中国語（簡体字）", "中国語（繁体字）", "韓国語"];

// ── 作品登録フォームの素材行 ─────────────────────────────────────────
export interface IntakeMaterial {
  name: string;
  materialType: string;        // game_design / illustration / scenario / manuscript / other
  materialRole: string;        // core_logic / sub_component
  acquisitionType: string;     // license / buyout_commission / in_house
  holderLabel: string;         // 権利元の表示名（取引先マスタ名）
  holderVendorId: number | null;
  region: string;              // 許諾地域（上限枠）
  language: string;            // 許諾言語（上限枠）
  royalty: boolean;            // ロイヤリティ対象（イン条件を持つ）
  sourceDocId: number | null;      // 引用元の文書ID（根拠文書）
  sourceDocNumber: string;         // 引用元の文書番号（表示・v3_lcs.source_doc）
  r1: string; r2: string; r3: string;   // 取引形態1/2/3 の料率（%）
  mg: string; ag: string; cur: string;
}

export function emptyIntakeMaterial(holderLabel = "", holderVendorId: number | null = null): IntakeMaterial {
  return {
    name: "", materialType: "other", materialRole: "sub_component", acquisitionType: "license",
    holderLabel, holderVendorId, region: "全世界", language: "全言語",
    royalty: false, sourceDocId: null, sourceDocNumber: "",
    r1: "", r2: "", r3: "", mg: "0", ag: "0", cur: "JPY"
  };
}

// 既存文書からの引用：文書種別から取得形態を推定する。
// 発注書（買切・委託で作らせた成果物）→ buyout_commission、
// 利用許諾・ライセンス系（許諾を受けている）→ license。
export function acquisitionFromTemplateType(templateType: string): string {
  if (/purchase_order/.test(templateType)) return "buyout_commission";
  return "license";
}

/** 引用した文書から素材行を組み立てる（素材名・権利者・取得形態・根拠文書）。 */
export function materialFromDocument(doc: {
  id: number; documentNumber: string; templateType: string; title: string; counterparty: string;
}): IntakeMaterial {
  const acquisition = acquisitionFromTemplateType(doc.templateType);
  return {
    ...emptyIntakeMaterial(doc.counterparty ?? ""),
    name: doc.title || doc.documentNumber,
    acquisitionType: acquisition,
    // 発注書の買切は自社帰属＝ロイヤリティ対象外、許諾はイン条件を持つ。
    royalty: acquisition === "license",
    materialType: /illust|イラスト/.test(doc.title) ? "illustration" : "other",
    sourceDocId: doc.id, sourceDocNumber: doc.documentNumber
  };
}

/** POST /api/v2/materials の payload。 */
export function materialCreatePayload(workId: number, material: IntakeMaterial, isFirst: boolean) {
  return {
    workId,
    materialName: material.name.trim(),
    materialType: material.materialType,
    materialRole: material.materialRole,
    acquisitionType: material.acquisitionType,
    // 買切・自社制作は自社帰属（owned）、許諾は license。
    rightsType: material.acquisitionType === "license" ? "license" : "owned",
    ...(material.holderVendorId ? { rightsHolderVendorId: material.holderVendorId } : {}),
    ...(material.holderLabel.trim() ? { rightsHolderLabel: material.holderLabel.trim() } : {}),
    ...(material.region.trim() ? { territory: material.region.trim() } : {}),
    ...(material.language.trim() ? { language: material.language.trim() } : {}),
    isDefault: isFirst,
    isRoyaltyBearing: material.royalty
  };
}

/** POST /api/v2/rights-sources の payload（引用元文書がある素材のみ）。 */
export function rightsSourceCreatePayload(materialId: number, material: IntakeMaterial) {
  if (!material.sourceDocId) return null;
  return {
    materialId,
    sourceType: material.acquisitionType === "buyout_commission" ? "direct_contract" : "upstream_license",
    sourceDocumentId: material.sourceDocId,
    ...(material.holderVendorId ? { rightsHolderVendorId: material.holderVendorId } : {}),
    isPrimary: true
  };
}

// ── 既存文書の一括アップロード（作品登録ウィザード ステップ④）────────────
// 巻き直し（同じ契約の締結し直し）は1つの文書系列として扱う：
//   files = [初版, 第2版, …] の順で、最後のファイルだけが「有効版」。
//   有効版が入力された文書番号をそのまま使い、旧版は「-v1, -v2…」の枝番で登録して
//   件名に旧版マークを付け、superseded_by に有効版の番号を記録する。
// 条件明細・検索は原則として有効版（本番号）へ紐づける運用。
export const INTAKE_DOC_KINDS = [
  { value: "purchase_order", label: "発注書" },
  { value: "intl_purchase_order", label: "海外発注書" },
  { value: "individual_license_terms", label: "個別利用許諾条件" },
  { value: "contract", label: "契約書" },
  { value: "nda", label: "秘密保持契約" },
  { value: "reference", label: "参考資料・その他" }
] as const;

export function stripFileExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

export interface DocumentUploadPlan {
  documentNumber: string;
  title: string;
  supersededBy: string; // 空＝有効版
}

export function planDocumentUploads(input: { docNumber: string; fileNames: string[] }): DocumentUploadPlan[] {
  const docNumber = input.docNumber.trim();
  const last = input.fileNames.length - 1;
  return input.fileNames.map((name, index) => index === last
    ? { documentNumber: docNumber, title: stripFileExtension(name), supersededBy: "" }
    : {
      documentNumber: `${docNumber}-v${index + 1}`,
      title: `${stripFileExtension(name)}（旧版・巻き直し済）`,
      supersededBy: docNumber
    });
}

// ── 展開区分と「この作品から作る文書」────────────────────────────────
// 作品の business_line（070）で、作品から起こせる文書の種類を絞る。
export type BusinessLine = "game" | "publishing" | "both";
export const BUSINESS_LINE_OPTIONS: Array<{ value: BusinessLine; label: string; hint: string }> = [
  { value: "game", label: "ゲーム", hint: "個別利用許諾条件書（V3）・発注書" },
  { value: "publishing", label: "出版", hint: "出版個別利用許諾条件書・出版基本契約・発注書" },
  { value: "both", label: "両方", hint: "ゲームと出版の文書をどちらも作る" }
];
export function businessLineLabel(value: string | null | undefined): string {
  return BUSINESS_LINE_OPTIONS.find((o) => o.value === value)?.label ?? "未設定";
}

export interface WorkDocumentChoice {
  // "pub_master" は取引先の区分（法人/個人）で pub_master_corporate / pub_master_individual に解決する。
  templateKey: "individual_license_terms_v3" | "pub_license_terms" | "pub_master" | "purchase_order";
  label: string;
  hint: string;
  primary: boolean;
}

export function documentChoicesForWork(businessLine: string | null | undefined): WorkDocumentChoice[] {
  // 個別条件書（V3・出版）は 許諾者＝取引先／被許諾者＝当社 ＝ 当社が支払うイン条件の文書。
  const game: WorkDocumentChoice = {
    templateKey: "individual_license_terms_v3", label: "個別利用許諾条件書（ゲーム）",
    hint: "権利元へ支払う料率（イン条件）を素材マトリクスで定める新規発行", primary: true
  };
  const pub: WorkDocumentChoice = {
    templateKey: "pub_license_terms", label: "出版個別利用許諾条件書",
    hint: "許諾者へ支払う印税（イン条件）。原著作物名・許諾者・振込口座を差し込み", primary: true
  };
  const pubMaster: WorkDocumentChoice = {
    templateKey: "pub_master", label: "出版基本契約",
    hint: "許諾者が法人か個人かで書式を自動選択", primary: false
  };
  const po: WorkDocumentChoice = {
    templateKey: "purchase_order", label: "発注書",
    hint: "素材の制作委託（イン条件）", primary: false
  };
  if (businessLine === "publishing") return [pub, pubMaster, po];
  if (businessLine === "both") return [game, pub, pubMaster, po];
  if (businessLine === "game") return [game, po];
  // 未設定（旧作品）は全部見せて選ばせる。
  return [game, pub, pubMaster, po];
}

// GET /api/v2/vendors/:id（camelCase）を、DBから引用（MasterDataPicker.buildPatch）が
// 期待する取引先マスタ行（snake_case）の形に直す。担当者メール（067）があれば
// メール欄に優先して入れる（通知先は担当者宛が自然）。口座は管理者のときだけ届く。
export function vendorRecordToPickerValues(record: Record<string, unknown>): Record<string, unknown> {
  const pick = (key: string) => (record[key] === undefined ? undefined : record[key]);
  const contactEmail = String(record.contactEmail ?? "").trim();
  return {
    id: record.id,
    vendor_name: pick("vendorName"),
    vendor_code: pick("vendorCode"),
    trade_name: pick("tradeName"),
    pen_name: pick("penName"),
    entity_type: pick("entityType"),
    email: contactEmail || pick("email"),
    phone: pick("phone"),
    contact_name: pick("contactName"),
    contact_department: pick("contactDepartment"),
    address: pick("address"),
    invoice_registration_number: pick("invoiceRegistrationNumber"),
    vendor_rep: pick("vendorRep"),
    corporate_number: pick("corporateNumber"),
    bank_name: pick("bankName"),
    branch_name: pick("branchName"),
    account_type: pick("accountType"),
    account_number: pick("accountNumber"),
    account_holder_kana: pick("accountHolderKana"),
    is_invoice_issuer: pick("isInvoiceIssuer"),
    withholding_enabled: pick("withholdingEnabled")
  };
}

/** pub_master の法人/個人書式を取引先の区分で決める（不明なら法人）。 */
export function resolvePubMasterTemplate(entityType: unknown): "pub_master_individual" | "pub_master_corporate" {
  return String(entityType ?? "").trim() === "個人" ? "pub_master_individual" : "pub_master_corporate";
}

// ── 個別利用許諾条件書V3 へのシード ───────────────────────────────────
const rate = (value: string): string => {
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed !== 0 ? String(parsed) : "";
};

/**
 * 作品登録の内容から条件書フォームの初期値を組み立てる。
 * 素材コードは登録時にサーバが採番したもの（saved[].materialCode）を使う＝
 * 条件同期（material_code → work_materials）が必ず結線される。
 */
export function buildLicenseTermsSeed(
  work: { workCode: string | null; title: string; holderLabel: string },
  materials: Array<{ material: IntakeMaterial; materialCode: string | null }>
): DocumentFormData {
  const lcs = materials
    .filter(({ material }) => material.name.trim())
    .map(({ material, materialCode }) => {
      const rates: Record<string, string> = {};
      if (material.royalty) {
        const r1 = rate(material.r1); if (r1) rates["1"] = r1;
        const r2 = rate(material.r2); if (r2) rates["2"] = r2;
        const r3 = rate(material.r3); if (r3) rates["3"] = r3;
      }
      return {
        material_code: materialCode ?? "",
        name: material.name.trim(),
        holder: material.holderLabel.trim(),
        region: material.region.trim(),
        language: material.language.trim(),
        ...(material.sourceDocNumber ? { source_doc: material.sourceDocNumber } : {}),
        rates
      };
    });
  // MG/AG は取引形態別ではなく条件行（代表＝取引形態1）に持つ（V1 の 2-1 と同じ）。
  // 素材ごとの MG は合算せず、代表の1本目に最大値を入れて条件書側で確定してもらう。
  const royaltyMaterials = materials.filter(({ material }) => material.royalty);
  const mgTotal = royaltyMaterials.reduce((sum, { material }) => sum + (Number(rate(material.mg)) || 0), 0);
  const agTotal = royaltyMaterials.reduce((sum, { material }) => sum + (Number(rate(material.ag)) || 0), 0);
  const deals = fixedDealRows();
  if (mgTotal > 0) deals[0].mg = String(mgTotal);
  if (agTotal > 0) deals[0].ag = String(agTotal);
  return {
    work_id: work.workCode ?? "",
    対象製品予定名: work.title,
    Licensor_氏名会社名: work.holderLabel,
    v3_conds: deals,
    v3_lcs: lcs
  };
}
