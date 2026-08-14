export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "boolean"
  | "hidden";

export interface TemplateField {
  name: string;
  label?: string;
  type?: FieldType;
  group?: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  helpText?: string;
  dbField?: string;
  // 条件表示：他項目の値により表示/非表示を切り替える（IGLA のような
  // モデル選択型テンプレートで、使わない側の項目群をフォームから隠す）。
  // anyOf は select 値の一致、truthy は boolean 項目のチェック有無で判定。
  showWhen?: { field: string; anyOf?: string[]; truthy?: boolean };
}

export interface DocumentFormSchema {
  templateKey: string;
  templateVersionId: number;
  label: string;
  category?: string;
  fields: TemplateField[];
}

export type DocumentFormData = Record<string, unknown>;

export interface DocumentDraft {
  id: number;
  issueKey: string;
  templateType: string;
  formData: DocumentFormData;
  documentNumber: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface DocumentDraftSummary {
  id: number;
  issueKey: string;
  templateType: string;
  documentNumber: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface DashboardSummary {
  kpis: Array<{ label: string; value: number; tone?: "default" | "warning" | "danger" }>;
  stages: Array<{ label: string; count: number }>;
  priorities: Array<{
    id: string;
    matterId?: number;
    title: string;
    counterparty: string;
    owner: string;
    stage: string;
    dueDate: string;
    status: string;
    overdue?: boolean;
  }>;
  nextActions?: Array<{
    matterId: number;
    matterCode: string;
    title: string;
    taskTitle: string;
    dueAt: string | null;
    overdue?: boolean;
  }>;
  // 決算バンド（消化実績・検収）。財務テーブルへのSELECT付与（grant 011）が
  // 未適用の環境では null で安全に縮退し、ホームは案件KPIのみを表示する。
  settlement?: {
    plannedTotal: number;
    consumedTotal: number;
    consumptionRate: number;        // 0..1
    linesRequiringInspection: number;
    linesInspected: number;
    inspectionRate: number;         // 0..1
  } | null;
  source?: "live" | "sample";
}
