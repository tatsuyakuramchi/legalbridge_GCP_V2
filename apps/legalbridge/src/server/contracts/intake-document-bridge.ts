import type {
  DocumentDraft,
  DocumentFormData
} from "../../types.js";
import type { DraftRepository } from "../documents/draft-repository.js";
import type { TemplateRepository } from "../documents/template-repository.js";
import type {
  ContractIntakeDocumentSource,
  IntakeBridgeVendor
} from "./intake-document-repository.js";
import type { OutboundBridgeCondition } from "./intake-outbound-repository.js";

export const contractIntakeDocumentTypes = [
  "individual_license_terms",
  "royalty_statement"
] as const;

export type ContractIntakeDocumentType =
  typeof contractIntakeDocumentTypes[number];

interface DraftPlan {
  issueKey: string;
  templateType: ContractIntakeDocumentType;
  label: string;
  counterpartyVendorId: number;
  counterpartyName: string;
  formData: DocumentFormData;
}

export interface PreparedIntakeDraft {
  draft: DocumentDraft;
  created: boolean;
  label: string;
  counterpartyVendorId: number;
  counterpartyName: string;
}

export async function prepareContractIntakeDocumentDrafts(
  source: ContractIntakeDocumentSource,
  templateType: ContractIntakeDocumentType,
  drafts: DraftRepository,
  templates: TemplateRepository,
  updatedBy: string,
  // 自社名（1-6）。app_settings の会社プロファイルから解決（未指定は従来値）。
  companyName = "株式会社アークライト"
): Promise<PreparedIntakeDraft[]> {
  const template = await templates.findCurrent(templateType);
  if (!template) {
    throw new ContractIntakeDocumentBridgeError(
      "TARGET_TEMPLATE_NOT_FOUND",
      "対象文書templateが有効ではありません"
    );
  }

  const plans = buildContractIntakeDraftPlans(source, templateType, companyName);
  const prepared: PreparedIntakeDraft[] = [];
  for (const plan of plans) {
    const existing = await drafts.find(plan.issueKey, plan.templateType);
    const draft = existing ?? await drafts.save({
      issueKey: plan.issueKey,
      templateType: plan.templateType,
      formData: plan.formData,
      updatedBy
    });
    prepared.push({
      draft,
      created: !existing,
      label: plan.label,
      counterpartyVendorId: plan.counterpartyVendorId,
      counterpartyName: plan.counterpartyName
    });
  }
  return prepared;
}

export function buildContractIntakeDraftPlans(
  source: ContractIntakeDocumentSource,
  templateType: ContractIntakeDocumentType,
  companyName = "株式会社アークライト"
): DraftPlan[] {
  return templateType === "individual_license_terms"
    ? buildIndividualLicensePlans(source, companyName)
    : [buildRoyaltyStatementPlan(source, companyName)];
}

function buildIndividualLicensePlans(
  source: ContractIntakeDocumentSource,
  companyName: string
): DraftPlan[] {
  const groups = new Map<number, Array<{
    index: number;
    value: OutboundBridgeCondition;
  }>>();
  source.outboundConditions.forEach((value, index) => {
    const current = groups.get(value.counterpartyVendorId) ?? [];
    current.push({ index, value });
    groups.set(value.counterpartyVendorId, current);
  });
  if (!groups.size) {
    throw new ContractIntakeDocumentBridgeError(
      "OUTBOUND_CONDITIONS_REQUIRED",
      "個別利用許諾条件書にはアウト条件が1件以上必要です"
    );
  }

  return [...groups.entries()].map(([vendorId, entries]) => {
    const vendor = requireVendor(source, vendorId);
    const conditions = entries.map(({ value }) => value);
    const financialConditions = conditions.map((condition, index) =>
      financialCondition(source, condition, index)
    );
    const territories = unique(conditions.map((item) => item.territory));
    const languages = unique(conditions.flatMap((item) => item.languages));
    const notes = unique(conditions.map((item) => item.notes ?? ""));
    const first = conditions[0];

    return {
      issueKey: `INTAKE-${source.documentId}-ILT-${vendorId}`,
      templateType: "individual_license_terms",
      label: `個別利用許諾条件書（${vendor.vendorName}）`,
      counterpartyVendorId: vendorId,
      counterpartyName: vendor.vendorName,
      formData: {
        source_intake_document_id: source.documentId,
        source_contract_id: source.contractId,
        source_outbound_condition_indexes: entries.map((entry) => entry.index),
        linked_contract_number: source.documentNumber,
        CONTRACT_NO: source.documentNumber,
        基本契約名: source.intake.contract.contractTitle,
        work_id: source.ownWork.id,
        WORK_ID: source.ownWork.workCode,
        ORIGINAL_WORK: source.sourceWork.title,
        PROJECT_TITLE: source.ownWork.title,
        対象製品予定名: source.ownWork.title,
        Licensor_氏名会社名: companyName,
        Licensee_氏名会社名: vendor.vendorName,
        Licensee_住所: vendor.address,
        Licensee_代表者名: vendor.representative,
        Licensee_連絡先: [vendor.contactName, vendor.phone, vendor.email]
          .filter(Boolean).join(" ／ "),
        PARTY_A_NAME: companyName,
        PARTY_B_NAME: vendor.vendorName,
        VENDOR_NAME: vendor.vendorName,
        許諾開始日: first.termStart ??
          source.intake.contract.effectiveDate ??
          source.intake.contract.executedAt,
        独占性: exclusivityLabel(first.exclusivity),
        ライセンス種別名: exclusivityLabel(first.exclusivity),
        許諾地域: territories.join("、"),
        許諾言語: languages.join("、"),
        再許諾補足: conditions.every((item) => item.sublicenseAllowed)
          ? "再許諾可"
          : "再許諾は個別条件に従う",
        特記事項: notes.join("\n"),
        financial_conditions: financialConditions,
        サブライセンシー一覧: []
      }
    };
  });
}

function buildRoyaltyStatementPlan(
  source: ContractIntakeDocumentSource,
  companyName: string
): DraftPlan {
  const vendorId = source.intake.contract.primaryVendorId;
  const vendor = requireVendor(source, vendorId);
  const lines = source.intake.inboundConditions.map((condition, index) => {
    const material = condition.materialIndex === undefined
      ? null
      : source.materials[condition.materialIndex];
    return {
      productName: [
        source.ownWork.title,
        material?.materialName,
        condition.conditionName
      ].filter(Boolean).join(" ／ "),
      sales_amount: "",
      rate_pct: condition.ratePct ?? "",
      royalty_amount: "",
      basisNote: royaltyBasisNote(condition)
    };
  });

  return {
    issueKey: `INTAKE-${source.documentId}-ROY`,
    templateType: "royalty_statement",
    label: "利用許諾料明細書",
    counterpartyVendorId: vendorId,
    counterpartyName: vendor.vendorName,
    formData: {
      source_intake_document_id: source.documentId,
      source_contract_id: source.contractId,
      linked_contract_number: source.documentNumber,
      CONTRACT_NO: source.documentNumber,
      CONTRACT_TITLE: source.intake.contract.contractTitle,
      contractTitle: source.intake.contract.contractTitle,
      PROJECT_TITLE: source.ownWork.title,
      ORIGINAL_WORK: source.sourceWork.title,
      WORK_ID: source.ownWork.workCode,
      payerCompany: companyName,
      PARTY_A_NAME: companyName,
      designerName: vendor.vendorName,
      licensor: vendor.vendorName,
      VENDOR_NAME: vendor.vendorName,
      intakeCurrency:
        source.intake.inboundConditions[0]?.currency ?? "JPY",
      royaltyCategory: "利用許諾料",
      statementMode: "single",
      lines,
      bridgeNotice:
        "契約条件と料率のみ転記済みです。対象期間、実績売上額、利用許諾料、控除・源泉徴収を確認して入力してください。"
    }
  };
}

function financialCondition(
  source: ContractIntakeDocumentSource,
  condition: OutboundBridgeCondition,
  index: number
) {
  const material = condition.materialIndex === undefined
    ? null
    : source.materials[condition.materialIndex];
  return {
    condition_no: index + 1,
    condition_name: condition.conditionName,
    subject: material?.materialName ?? source.ownWork.title,
    region_language_label:
      `${condition.territory} ／ ${condition.languages.join("・")}`,
    calc_method: paymentSchemeLabel(condition.paymentScheme),
    base_price_label: condition.royaltyBase ?? "",
    rate_pct: condition.ratePct ?? "",
    mg_amount: condition.mgAmount ?? "",
    ag_amount: condition.advanceAmount ?? "",
    currency: condition.currency,
    formula_text: [
      condition.amountExTax !== undefined
        ? `契約上の税抜額 ${condition.amountExTax.toLocaleString("ja-JP")} ${condition.currency}`
        : "",
      condition.royaltyBase ? `基準：${condition.royaltyBase}` : "",
      condition.deductibleCosts ? `控除：${condition.deductibleCosts}` : ""
    ].filter(Boolean).join(" ／ "),
    payment_terms: condition.paymentTerms ?? "",
    rights_holder: "発注者"
  };
}

function royaltyBasisNote(
  condition: ContractIntakeDocumentSource["intake"]["inboundConditions"][number]
) {
  return [
    condition.conditionName,
    condition.royaltyBase ? `基準：${condition.royaltyBase}` : "",
    condition.deductibleCosts ? `控除：${condition.deductibleCosts}` : "",
    condition.withholdingTaxTreatment
      ? `源泉徴収：${condition.withholdingTaxTreatment}`
      : "",
    condition.paymentTerms ? `支払条件：${condition.paymentTerms}` : "",
    condition.notes ?? ""
  ].filter(Boolean).join(" ／ ");
}

function paymentSchemeLabel(value: string) {
  return ({
    royalty: "ROYALTY",
    per_unit: "PER_UNIT",
    lump_sum: "FIXED",
    installment: "INSTALLMENT",
    subscription: "SUBSCRIPTION"
  } as Record<string, string>)[value] ?? value.toUpperCase();
}

function exclusivityLabel(value: string | undefined) {
  return ({
    exclusive: "独占",
    non_exclusive: "非独占",
    sole: "ソール"
  } as Record<string, string>)[value ?? ""] ?? "";
}

function requireVendor(
  source: ContractIntakeDocumentSource,
  vendorId: number
): IntakeBridgeVendor {
  const vendor = source.vendors[vendorId];
  if (!vendor) {
    throw new ContractIntakeDocumentBridgeError(
      "COUNTERPARTY_NOT_FOUND",
      `文書の相手方（vendor_id=${vendorId}）を参照できません`
    );
  }
  return vendor;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export class ContractIntakeDocumentBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
