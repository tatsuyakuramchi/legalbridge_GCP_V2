// 契約チェック（Phase 16-2）純関数エンジン。V1 services/api/contractCheckService.ts の判定核を
// 文字列まで同一に移植（判定＝カテゴリ別 master_contract の存在×用途コード接頭辞×フラグ）。
// 用途マスタは V1 で静的シード（書込経路なし）のため TS 定数化＝contract_purposes への grant 不要。

export interface ContractPurpose {
  purposeCode: string; purposeGroup: string; purposeLabel: string; category: string;
  requiredContractType: string; defaultDocumentType: string; sortOrder: number;
  flowDirection: "in" | "out" | null; highRiskFlag: boolean;
}

export const CONTRACT_PURPOSES: ContractPurpose[] = [
  { purposeCode: "service_general", purposeGroup: "業務を依頼する", purposeLabel: "制作・編集・デザイン等の業務を依頼したい", category: "service", requiredContractType: "service_basic", defaultDocumentType: "purchase_order", sortOrder: 10, flowDirection: "in", highRiskFlag: false },
  { purposeCode: "service_creative", purposeGroup: "業務を依頼する", purposeLabel: "イラスト・原稿・DTP・校正等を依頼したい", category: "service", requiredContractType: "service_basic", defaultDocumentType: "purchase_order", sortOrder: 20, flowDirection: "in", highRiskFlag: false },
  { purposeCode: "service_event", purposeGroup: "業務を依頼する", purposeLabel: "イベント運営・スタッフ業務を依頼したい", category: "service", requiredContractType: "service_basic", defaultDocumentType: "purchase_order", sortOrder: 30, flowDirection: "in", highRiskFlag: false },
  { purposeCode: "license_game", purposeGroup: "作品・IPを利用する", purposeLabel: "作品・ゲーム・IPをアナログゲーム化したい", category: "license", requiredContractType: "license_basic", defaultDocumentType: "license_condition", sortOrder: 40, flowDirection: "in", highRiskFlag: false },
  { purposeCode: "license_in", purposeGroup: "方向で登録", purposeLabel: "ライセンスイン — 他社の作品・IPの利用許諾を受ける(当社が支払)", category: "license", requiredContractType: "license_basic", defaultDocumentType: "license_condition", sortOrder: 41, flowDirection: "in", highRiskFlag: false },
  { purposeCode: "license_out", purposeGroup: "方向で登録", purposeLabel: "ライセンスアウト — 自社の作品・IPを第三者に許諾する(当社が受領)", category: "license", requiredContractType: "license_basic", defaultDocumentType: "license_condition", sortOrder: 42, flowDirection: "out", highRiskFlag: false },
  { purposeCode: "license_localize", purposeGroup: "作品・IPを利用する", purposeLabel: "作品を別地域・別言語で展開したい", category: "license", requiredContractType: "license_basic", defaultDocumentType: "license_condition", sortOrder: 50, flowDirection: "in", highRiskFlag: false },
  { purposeCode: "license_sublicense", purposeGroup: "作品・IPを利用する", purposeLabel: "第三者に再許諾・OEM展開したい", category: "license", requiredContractType: "license_basic", defaultDocumentType: "license_condition", sortOrder: 60, flowDirection: "out", highRiskFlag: false },
  { purposeCode: "publication_paper", purposeGroup: "出版する", purposeLabel: "紙書籍として出版したい", category: "publication", requiredContractType: "publication_license", defaultDocumentType: "publication_contract", sortOrder: 70, flowDirection: null, highRiskFlag: false },
  { purposeCode: "publication_ebook", purposeGroup: "出版する", purposeLabel: "電子書籍として配信したい", category: "publication", requiredContractType: "publication_license", defaultDocumentType: "publication_contract", sortOrder: 80, flowDirection: null, highRiskFlag: false },
  { purposeCode: "publication_translation", purposeGroup: "出版する", purposeLabel: "海外出版・翻訳版を出したい", category: "publication", requiredContractType: "publication_license", defaultDocumentType: "publication_contract", sortOrder: 90, flowDirection: null, highRiskFlag: false },
  { purposeCode: "publication_merch", purposeGroup: "出版する", purposeLabel: "出版物・イラストを商品化したい", category: "publication", requiredContractType: "publication_license", defaultDocumentType: "publication_contract", sortOrder: 100, flowDirection: null, highRiskFlag: false },
  { purposeCode: "publication_video_game", purposeGroup: "出版する", purposeLabel: "映像化・ゲーム化したい", category: "publication", requiredContractType: "publication_license", defaultDocumentType: "legal_review", sortOrder: 110, flowDirection: null, highRiskFlag: false },
  { purposeCode: "mixed_service_license", purposeGroup: "複合取引", purposeLabel: "業務依頼と権利利用の両方がある", category: "mixed", requiredContractType: "service_basic,license_basic", defaultDocumentType: "purchase_order,license_condition", sortOrder: 120, flowDirection: null, highRiskFlag: false },
  { purposeCode: "product_in", purposeGroup: "方向で登録", purposeLabel: "プロダクトイン — 商品/製品を仕入れる(当社が支払)", category: "sales", requiredContractType: "legal_review", defaultDocumentType: "legal_review", sortOrder: 131, flowDirection: "in", highRiskFlag: false },
  { purposeCode: "product_out", purposeGroup: "方向で登録", purposeLabel: "プロダクトアウト — 商品/製品を供給する(当社が受領)", category: "sales", requiredContractType: "legal_review", defaultDocumentType: "legal_review", sortOrder: 132, flowDirection: "out", highRiskFlag: false },
  { purposeCode: "unknown", purposeGroup: "その他", purposeLabel: "どれに該当するかわからない", category: "unknown", requiredContractType: "unknown", defaultDocumentType: "legal_review", sortOrder: 999, flowDirection: null, highRiskFlag: false }
];

export function findPurpose(code: string | null | undefined): ContractPurpose | null {
  if (!code) return null;
  return CONTRACT_PURPOSES.find((p) => p.purposeCode === code) ?? null;
}

// V1 normalizeName 準拠（NFKC→全空白除去→法人格語の先頭一致除去→括弧記号除去）。
const ENTITY_WORDS = [
  "株式会社", "有限会社", "合同会社", "一般社団法人", "公益社団法人", "一般財団法人", "公益財団法人",
  "特定非営利活動法人", "NPO法人", "(株)", "(有)", "(合)", "(一社)", "(公社)", "(一財)", "(公財)", "(特非)"
];
export function normalizeName(input: string | null | undefined): string {
  if (!input) return "";
  let v = String(input).normalize("NFKC").replace(/\s+/g, "");
  for (const w of ENTITY_WORDS) v = v.replace(w, "");   // 先頭一致1回のみ（V1 準拠）
  return v.replace(/[（）()<>〈〉［\]｛｝{}[\]]/g, "");
}

export interface MasterContractStatus {
  exists: boolean; status: string; label: string; contractTitle: string; documentNumber: string;
  effectiveDate: string; expirationDate: string; autoRenewal: boolean; availableDocument: string;
  documentUrl: string; legalonUrl: string; cloudsignUrl: string; driveUrl: string;
}
export interface MasterContracts { service: MasterContractStatus; license: MasterContractStatus; publication: MasterContractStatus; }

export interface VendorDocumentRow {
  recordType: string | null; contractCategory: string | null; contractTitle: string | null;
  documentNumber: string | null; contractStatus: string | null; effectiveDate: string | null;
  expirationDate: string | null; autoRenewal: boolean | null; documentUrl: string | null;
  legalonUrl: string | null; cloudsignUrl: string | null; driveUrl: string | null;
  conditionNumber: string | null; originalWork: string | null; workName: string | null;
  productName: string | null; media: string | null; territory: string | null; language: string | null;
  scope: string | null; isPrimary: boolean | null; lifecycleStatus: string | null;
}

const AVAILABLE_DOC: Record<string, string> = {
  service: "purchase_order", license: "license_condition", publication: "publication_contract"
};
function emptyStatus(category: string): MasterContractStatus {
  return {
    exists: false, status: "not_found", label: "未締結", contractTitle: "", documentNumber: "",
    effectiveDate: "", expirationDate: "", autoRenewal: false,
    availableDocument: AVAILABLE_DOC[category] ?? "", documentUrl: "", legalonUrl: "", cloudsignUrl: "", driveUrl: ""
  };
}
const ymd = (v: string | null) => (v ? String(v).slice(0, 10) : "");

// master_contract 行→カテゴリ別サマリ。V1 は「最後の行勝ち」の非決定だったが、
// V2 は 現行版（final・非void）＞is_primary＞新しい effective_date を優先する（監査で指摘の改良）。
export function buildMasterContractSummary(rows: VendorDocumentRow[]): MasterContracts {
  const out: MasterContracts = {
    service: emptyStatus("service"), license: emptyStatus("license"), publication: emptyStatus("publication")
  };
  const score = (r: VendorDocumentRow) =>
    ((r.lifecycleStatus ?? "final") === "final" ? 4 : 0) + (r.isPrimary !== false ? 2 : 0);
  const sorted = rows
    .filter((r) => r.recordType === "master_contract")
    .sort((a, b) => score(a) - score(b) || String(a.effectiveDate ?? "").localeCompare(String(b.effectiveDate ?? "")));
  for (const r of sorted) {   // 高スコアほど後＝上書きで勝つ
    const cat = String(r.contractCategory ?? "");
    if (cat !== "service" && cat !== "license" && cat !== "publication") continue;
    const status = r.contractStatus || "executed";
    out[cat] = {
      exists: true, status, label: status === "executed" ? "締結済" : "確認中",
      contractTitle: r.contractTitle ?? "", documentNumber: r.documentNumber ?? "",
      effectiveDate: ymd(r.effectiveDate), expirationDate: ymd(r.expirationDate),
      autoRenewal: r.autoRenewal === true, availableDocument: AVAILABLE_DOC[cat],
      documentUrl: r.documentUrl ?? "", legalonUrl: r.legalonUrl ?? "",
      cloudsignUrl: r.cloudsignUrl ?? "", driveUrl: r.driveUrl ?? ""
    };
  }
  return out;
}

export function buildLicenseConditions(rows: VendorDocumentRow[]) {
  return rows.filter((r) => r.recordType === "license_condition").map((r) => ({
    conditionNumber: r.conditionNumber ?? "", originalWork: r.originalWork ?? "",
    productName: r.productName ?? "", territory: r.territory ?? "", language: r.language ?? "",
    status: r.contractStatus === "executed" ? "有効" : "終了/確認中", documentUrl: r.documentUrl ?? ""
  }));
}
export function buildPublicationConditions(rows: VendorDocumentRow[]) {
  return rows.filter((r) => r.recordType === "publication_condition").map((r) => ({
    conditionNumber: r.conditionNumber ?? "", workName: r.workName || r.originalWork || "",
    media: r.media ?? "", territory: r.territory ?? "", language: r.language ?? "",
    scope: r.scope ?? "", status: r.contractStatus === "executed" ? "有効" : "終了/確認中",
    documentUrl: r.documentUrl ?? ""
  }));
}

export interface AdditionalFlags {
  usesIp?: boolean; includesSublicense?: boolean; includesOverseas?: boolean;
  includesEbook?: boolean; includesVideoGame?: boolean; unusualPaymentTerms?: boolean;
}
export interface PurposeResult {
  selected: boolean; label: string; judgmentLabel: string;
  recommendedDocumentType: string; legalReviewRequired: boolean; reasonSummary: string;
}

// V1 buildPurposeResult（判定文字列は一字一句同一。V1:844 の「契約書案 of 法務レビュー」typo は修正）。
export function buildPurposeResult(
  flags: AdditionalFlags, master: MasterContracts, purpose: ContractPurpose | null
): PurposeResult {
  if (!purpose) {
    return {
      selected: false, label: "契約締結状況のみ表示", judgmentLabel: "用途未選択",
      recommendedDocumentType: "none", legalReviewRequired: false,
      reasonSummary: "用途が選択されていないため、現在の締結状況のみを表示しています。"
    };
  }
  const r: PurposeResult = {
    selected: true, label: purpose.purposeLabel, judgmentLabel: "",
    recommendedDocumentType: purpose.defaultDocumentType,
    legalReviewRequired: purpose.highRiskFlag, reasonSummary: ""
  };
  const code = purpose.purposeCode;
  if (code.startsWith("service_")) {
    if (master.service.exists) {
      r.judgmentLabel = "発注書で進行可能";
      r.reasonSummary = "業務委託基本契約が締結済みであり、発注書で個別条件を定める運用に適合します。";
    } else {
      r.judgmentLabel = "業務委託基本契約の締結または法務確認が必要";
      r.legalReviewRequired = true; r.recommendedDocumentType = "legal_review";
      r.reasonSummary = "基本契約が未締結です。新たに基本契約を締結するか、本件固有の契約書作成について法務へ相談してください。";
    }
  } else if (code.startsWith("license_")) {
    if (master.license.exists) {
      r.judgmentLabel = "個別利用許諾条件書で確認";
      r.reasonSummary = "ライセンス利用許諾基本契約が締結済みです。基本契約の範囲内であることを確認の上、個別利用許諾条件書（または発注書）を作成してください。";
      if (flags.includesSublicense || flags.includesOverseas) {
        r.legalReviewRequired = true;
        r.judgmentLabel = "再許諾・海外展開を含むため、法務確認を推奨";
        r.reasonSummary += " ただし、再許諾や海外展開が含まれる場合は基本契約の許諾範囲を超える可能性があるため、法務確認が必要です。";
      }
    } else {
      r.judgmentLabel = "ライセンス基本契約の締結が必要";
      r.legalReviewRequired = true; r.recommendedDocumentType = "legal_review";
      r.reasonSummary = "ライセンス利用に関する基本契約（またはマスター契約）が未締結です。";
    }
  } else if (code.startsWith("publication_")) {
    r.legalReviewRequired = true; r.recommendedDocumentType = "publication_contract";
    if (code === "publication_video_game") {
      r.judgmentLabel = "法務による個別検討・契約作成が必要";
      r.recommendedDocumentType = "legal_review";
      r.reasonSummary = "映像化・ゲーム化等の権利処理は複雑なため、必ず法務担当者へ相談してください。";
    } else {
      r.judgmentLabel = "出版契約書の作成が必要";
      r.reasonSummary = "出版許諾基本契約がある場合でも、出版契約は個別案件ごとの調整事項が多いため、原則として契約書案の法務レビューを受けてください。";
    }
  } else if (code === "mixed_service_license") {
    r.legalReviewRequired = true;
    r.judgmentLabel = "複合取引のため、法務確認が必要";
    r.reasonSummary = "業務委託とライセンスが混在する取引は、権利帰属や対価構成が複雑になるため法務確認を必須としています。";
  } else {
    r.legalReviewRequired = true;
    r.judgmentLabel = "法務確認を推奨";
    r.reasonSummary = "選択された用途または不明な用途については、法務担当者へ直接相談してください。";
  }
  return r;
}

export interface SuggestedAction { label: string; legalReviewRequired: boolean; message: string; }
export function buildSuggestedAction(result: PurposeResult): SuggestedAction {
  const message = result.legalReviewRequired
    ? "確認結果に基づき、法務へ詳細を相談してください。Backlogの法務相談チケット起票を推奨します。"
    : result.recommendedDocumentType === "purchase_order"
      ? "基本契約に基づき「発注書」を作成・発行してください。"
      : result.recommendedDocumentType === "license_condition"
        ? "基本契約に基づき「個別利用許諾条件書」を作成・締結してください。"
        : "確認結果に基づき、必要な個別文書を作成してください。";
  return { label: "契約状況の確認結果", legalReviewRequired: result.legalReviewRequired, message };
}

// 取引先未検出時の定型（V1 shape (c)）。
export function notFoundResult(purpose: ContractPurpose | null) {
  return {
    ok: true, counterparty: null, masterContracts: null,
    licenseConditions: [] as unknown[], publicationConditions: [] as unknown[],
    purposeResult: {
      selected: Boolean(purpose), label: purpose?.purposeLabel ?? "未選択",
      judgmentLabel: "取引先が見つかりません", recommendedDocumentType: "legal_review",
      legalReviewRequired: true,
      reasonSummary: "指定された名称で取引先マスタが見つからないため、新規登録または名称確認が必要です。"
    },
    suggestedAction: {
      label: "取引先確認", legalReviewRequired: true,
      message: "取引先マスタに登録されている正式名称で再検索するか、法務へ相談してください。"
    }
  };
}
