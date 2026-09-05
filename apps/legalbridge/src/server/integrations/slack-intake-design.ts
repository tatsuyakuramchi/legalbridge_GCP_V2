import type { DocumentFormSchema } from "../../types.js";

export type SlackIntakeWorkflowId =
  | "legal_review"
  | "document_create"
  | "license_contract"
  | "purchase_order"
  | "delivery_inspection"
  | "license_settlement"
  | "deadline_change";

export type SlackCompletionMode =
  | "request_only"
  | "request_then_workspace"
  | "slack_inline";

export interface SlackIntakeWorkflowDefinition {
  id: SlackIntakeWorkflowId;
  label: string;
  group: "法務相談" | "文書作成" | "契約・発注" | "履行・精算" | "その他";
  description: string;
  completionMode: SlackCompletionMode;
  workspaceView:
    | "requests"
    | "templates"
    | "license-contract"
    | "documents"
    | "license-settlements"
    | "home";
  outputTemplateKey?: string;
  templateSelection: "none" | "generic_documents" | "purchase_orders";
  slackFields: string[];
}

export const slackIntakeWorkflowDefinitions: SlackIntakeWorkflowDefinition[] = [
  {
    id: "legal_review",
    label: "法務相談・レビュー",
    group: "法務相談",
    description: "相談・契約レビュー・法的評価。必要に応じて法務評価書/回答書を作成して共有し完了します。",
    completionMode: "request_only",
    workspaceView: "requests",
    outputTemplateKey: "legal_response",
    templateSelection: "none",
    slackFields: ["summary","deadline","details","attachment"]
  },
  {
    id: "document_create",
    label: "文書を作成してほしい",
    group: "文書作成",
    description: "NDA、業務委託契約、売買契約、覚書、通知書等。Template固有項目はLegalBridgeで入力します。",
    completionMode: "request_then_workspace",
    workspaceView: "templates",
    templateSelection: "generic_documents",
    slackFields: ["template","summary","deadline","counterparty","details"]
  },
  {
    id: "license_contract",
    label: "ライセンス契約を新規作成",
    group: "契約・発注",
    description: "IN/OUTを起点に作品・権利ソース・利用条件をLegalBridgeで入力し、Templateを生成します。",
    completionMode: "request_then_workspace",
    workspaceView: "license-contract",
    templateSelection: "none",
    slackFields: ["license_direction","summary","deadline","counterparty","work_hint","details"]
  },
  {
    id: "purchase_order",
    label: "発注書を作成",
    group: "契約・発注",
    description: "発注の受付だけSlackで行い、業務明細・支払条件・成果物権利はLegalBridgeで構造化入力します。",
    completionMode: "request_then_workspace",
    workspaceView: "documents",
    templateSelection: "purchase_orders",
    slackFields: ["template","summary","deadline","counterparty","details"]
  },
  {
    id: "delivery_inspection",
    label: "納品・検収",
    group: "履行・精算",
    description: "対象発注/契約と納品事実を受付し、検収・支払期限はLegalBridgeで管理します。",
    completionMode: "request_then_workspace",
    workspaceView: "documents",
    outputTemplateKey: "inspection_certificate",
    templateSelection: "none",
    slackFields: ["target_document_number","event_date","summary","details"]
  },
  {
    id: "license_settlement",
    label: "利用許諾料を精算",
    group: "履行・精算",
    description: "製造・販売・サブライセンス料入金の発生を受付し、条件・金額計算はSettlement Workspaceで行います。",
    completionMode: "request_then_workspace",
    workspaceView: "license-settlements",
    outputTemplateKey: "royalty_statement",
    templateSelection: "none",
    slackFields: ["settlement_trigger","target_document_number","event_date","work_hint","summary","details"]
  },
  {
    id: "deadline_change",
    label: "納期変更",
    group: "その他",
    description: "対象依頼の納期変更のみ。Slack内で完結できる短い業務です。",
    completionMode: "slack_inline",
    workspaceView: "home",
    templateSelection: "none",
    slackFields: ["target_issue_key","new_deadline","change_reason"]
  }
];

const outputOnlyTemplates = new Set([
  "legal_response",
  "royalty_statement",
  "inspection_certificate"
]);

const purchaseOrderTemplates = new Set([
  "purchase_order",
  "intl_purchase_order"
]);

const licenseWorkflowTemplates = new Set([
  "license_master",
  "individual_license_terms",
  "individual_license_terms_v3",
  "igla_license_en",
  "igla_license_annex_en",
  "license_out_en"
]);

export function workflowForTemplate(templateKey: string): SlackIntakeWorkflowId {
  if (templateKey === "legal_response") return "legal_review";
  if (templateKey === "royalty_statement") return "license_settlement";
  if (templateKey === "inspection_certificate") return "delivery_inspection";
  if (purchaseOrderTemplates.has(templateKey)) return "purchase_order";
  if (licenseWorkflowTemplates.has(templateKey)) return "license_contract";
  return "document_create";
}

export function selectableTemplatesForWorkflow(
  workflow: SlackIntakeWorkflowId,
  templates: DocumentFormSchema[]
) {
  if (workflow === "purchase_order") {
    return templates.filter((template) => purchaseOrderTemplates.has(template.templateKey));
  }
  if (workflow === "document_create") {
    return templates.filter((template) =>
      !outputOnlyTemplates.has(template.templateKey) &&
      !purchaseOrderTemplates.has(template.templateKey) &&
      !licenseWorkflowTemplates.has(template.templateKey)
    );
  }
  return [];
}

export function slackWorkflowCatalog(templates: DocumentFormSchema[]) {
  return slackIntakeWorkflowDefinitions.map((workflow) => ({
    ...workflow,
    templates: selectableTemplatesForWorkflow(workflow.id, templates).map((template) => ({
      templateKey: template.templateKey,
      templateVersionId: template.templateVersionId,
      label: template.label,
      category: template.category ?? null,
      fieldCount: template.fields.length
    }))
  }));
}

export function workflowDefinition(id: string | undefined) {
  return slackIntakeWorkflowDefinitions.find((workflow) => workflow.id === id)
    ?? slackIntakeWorkflowDefinitions[0];
}
