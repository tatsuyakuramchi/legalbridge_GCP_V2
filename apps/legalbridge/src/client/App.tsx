import { useEffect, useRef, useState } from "react";
import type {
  DashboardSummary,
  DocumentDraft,
  DocumentFormData,
  DocumentFormSchema
} from "../types";
import { SpecializedDocumentForms } from "./SpecializedDocumentForms";
import { isFieldVisible, isInspectionFallbackFieldHidden } from "./field-visibility";
import { MasterDataPicker } from "./MasterDataPicker";
import { DocumentRegistry, type RegisteredDocument } from "./DocumentRegistry";
import { MatterRegistry } from "./MatterRegistry";
import { LedgerWorkspace } from "./LedgerWorkspace";
import { GlobalSearch } from "./GlobalSearch";
import { AdminOverview } from "./AdminOverview";
import { DraftWorkspace } from "./DraftWorkspace";
import { OutboundConditionWorkspace } from "./OutboundConditionWorkspace";
import { ContractChainWizard } from "./ContractChainWizard";
import { ConditionLinesWorkspace } from "./ConditionLinesWorkspace";
import { StaffWorkspace } from "./StaffWorkspace";
import { GmailInboundWorkspace } from "./GmailInboundWorkspace";
import { RoyaltyPreview } from "./RoyaltyPreview";
import { BillingDashboard } from "./BillingDashboard";
import { ReceivableMap } from "./ReceivableMap";
import { WorkDetail } from "./WorkDetail";
import { EmptyState } from "./EmptyState";
import { CartPanel } from "./MergeCart";
import { DocumentOutputActions } from "./DocumentOutputActions";
import { DataQuality } from "./DataQuality";
import { VendorMerge } from "./VendorMerge";
import { MatterMerge } from "./MatterMerge";
import { OperationsGuide } from "./OperationsGuide";
import { TextSnippets } from "./TextSnippets";
import { TemplateSamples } from "./TemplateSamples";
import { RequestsWorkspace } from "./RequestsWorkspace";
import { seedFormData } from "./extract-variables";
import { duplicateFormData, type DuplicateMode } from "./duplicate-document";
import { PaymentReport } from "./PaymentReport";
import { ExcelBatchWorkspace } from "./ExcelBatchWorkspace";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { WorkflowRulesWorkspace } from "./WorkflowRulesWorkspace";
import { ContractMasterWorkspace } from "./ContractMasterWorkspace";
import { BillingPrint } from "./BillingPrint";
import { isPurchaseOrderTemplate, purchaseOrderTotals, withPurchaseOrderTotals } from "../purchase-order-totals";
import { honorificWarnings } from "../honorific";

type CompatibilityReport = { summary: { total: number; ok: number; warning: number; error: number }; reports: Array<{ templateKey: string; status: "ok" | "warning" | "error"; missingHelpers: string[]; missingPartials: string[]; unmappedVariables: string[]; renderError?: string }> };

const fallback: DashboardSummary = {
  kpis: [
    { label: "対応待ち", value: 12, tone: "warning" },
    { label: "本日期限", value: 4, tone: "danger" },
    { label: "承認待ち", value: 7 },
    { label: "今月完了", value: 38 }
  ],
  stages: [
    { label: "受付", count: 8 },
    { label: "審査", count: 11 },
    { label: "ドラフト", count: 6 },
    { label: "承認・締結", count: 5 },
    { label: "完了", count: 38 }
  ],
  priorities: []
};

type View = "home" | "matters" | "documents" | "templates" | "document" | "drafts" | "ledgers" | "contract-intake" | "outbound" | "conditions" | "staff" | "admin" | "gmail-inbound" | "royalty-preview" | "billing" | "receivable-map" | "payment-report" | "billing-print" | "works" | "data-quality" | "vendor-merge" | "matter-merge" | "guide" | "snippets" | "requests" | "excel-batch" | "settings" | "workflow-rules" | "contract-master" | "template-samples";
type NavItem = { view: View; label: string; description: string; match: View[] };
type NavGroup = { label: string; items: NavItem[] };

function navGroups(access: {
  legalWorkspace: boolean; adminWorkspace: boolean; requesterWorkspace: boolean; readOnly: boolean;
  gmailInbound?: boolean;
}): NavGroup[] {
  const legalOrRequester = access.legalWorkspace || access.requesterWorkspace;
  // 情報設計（UX R1・タスクフロー優先）：概要／しごと／権利・条件／お金／マスタ・設定。
  //   しごと＝依頼→案件→文書→送信の主ループ（作成もここへ寄せる）、
  //   権利・条件＝作品と契約条件の閲覧・作成、お金＝財務レポート（法務のみ）、
  //   マスタ・設定＝マスタ編集・連携・保守・運用。表示はロールで出し分ける。
  const groups: NavGroup[] = [
    { label: "概要", items: [
      { view: "home", label: "ホーム", description: "業務の全体状況と次アクション", match: ["home"] }
    ] },
    { label: "しごと", items: [
      ...(access.legalWorkspace ? [{ view: "requests" as const, label: "依頼", description: "Backlog課題を起点に文書作成（読み取り）", match: ["requests" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "matters" as const, label: "案件", description: "案件・課題・タスクの管理", match: ["matters" as const] }] : []),
      ...(legalOrRequester ? [{ view: "documents" as const, label: access.requesterWorkspace ? "自分の文書" : "文書", description: "文書の作成・確定・PDF", match: ["documents" as const, "templates" as const, "document" as const] }] : []),
      ...(!access.readOnly && legalOrRequester ? [{ view: "drafts" as const, label: access.requesterWorkspace ? "自分の下書き" : "下書き", description: "保存中の下書きを再開", match: ["drafts" as const] }] : []),
      // 「スニペット」だと探せないという指摘があったため、実際に呼ばれている
      // 「定型文」を表に出す（機能は Phase 16-1 の text_snippets のまま）。
      ...(legalOrRequester ? [{ view: "snippets" as const, label: "定型文", description: "よく使う文言を全社で共有してコピー", match: ["snippets" as const] }] : []),
      ...(legalOrRequester ? [{ view: "template-samples" as const, label: "ひな形", description: "各テンプレートの完成イメージをサンプル値で閲覧", match: ["template-samples" as const] }] : [])
    ] },
    { label: "権利・条件", items: [
      ...(access.legalWorkspace ? [{ view: "works" as const, label: "作品", description: "作品を起点に系譜・素材・条件・権利ソースを一望", match: ["works" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "conditions" as const, label: "条件明細", description: "契約条件の横断検索・消化・検収", match: ["conditions" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "outbound" as const, label: "アウト条件", description: "許諾先へのアウト条件追記", match: ["outbound" as const] }] : [])
    ] },
    { label: "お金", items: [
      ...(access.legalWorkspace ? [{ view: "billing" as const, label: "請求", description: "再許諾料の受領・分配の横断俯瞰", match: ["billing" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "receivable-map" as const, label: "債権マップ", description: "作品中心の受領・分配・留保の系譜俯瞰", match: ["receivable-map" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "payment-report" as const, label: "支払報告書", description: "出金台帳の源泉・消費税・振込額とCSV出力", match: ["payment-report" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "billing-print" as const, label: "請求印刷", description: "受領・分配 計算書の印刷/PDF", match: ["billing-print" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "excel-batch" as const, label: "Excel一括", description: "検収書・利用許諾料計算書を担当者×支払期日で束ねてExcel出力", match: ["excel-batch" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "royalty-preview" as const, label: "ロイヤリティ試算", description: "確定前のロイヤリティ・源泉のライブ試算（保存なし）", match: ["royalty-preview" as const] }] : [])
    ] },
    // 旧「マスタ・設定」は admin で12項目に肥大していた（F1 過積載の再発・監査 P1-13）。
    // マスタ／データ整備／設定・運用の3グループに分割する。
    { label: "マスタ", items: [
      ...(access.legalWorkspace ? [{ view: "ledgers" as const, label: "台帳", description: "作品・取引先などのマスタ", match: ["ledgers" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "contract-master" as const, label: "契約マスタ", description: "既存契約の中核項目・ライフサイクル状態の編集", match: ["contract-master" as const] }] : []),
      ...(access.adminWorkspace ? [{ view: "contract-intake" as const, label: "契約取込", description: "締結済イン契約の登録", match: ["contract-intake" as const] }] : []),
      ...(access.adminWorkspace ? [{ view: "staff" as const, label: "担当者", description: "担当者マスタの管理", match: ["staff" as const] }] : []),
      ...(access.adminWorkspace && access.gmailInbound ? [{ view: "gmail-inbound" as const, label: "受信取込", description: "受信メールの契約PDF取込", match: ["gmail-inbound" as const] }] : [])
    ] },
    { label: "データ整備", items: [
      ...(access.legalWorkspace ? [{ view: "data-quality" as const, label: "データ品質", description: "横断整合スキャン（未リンク・重複・欠落）の俯瞰", match: ["data-quality" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "vendor-merge" as const, label: "取引先名寄せ", description: "重複した取引先を統合（参照再指定・旧は無効化）", match: ["vendor-merge" as const] }] : []),
      ...(access.legalWorkspace ? [{ view: "matter-merge" as const, label: "案件名寄せ", description: "重複した案件を統合（課題・文書・送信履歴を移送・旧はアーカイブ）", match: ["matter-merge" as const] }] : [])
    ] },
    { label: "設定・運用", items: [
      ...(access.adminWorkspace ? [{ view: "settings" as const, label: "システム設定", description: "会社プロファイル（自社情報）の編集", match: ["settings" as const] }] : []),
      ...(access.adminWorkspace ? [{ view: "workflow-rules" as const, label: "承認ルート", description: "部門別の承認者・押印担当・責任者・Slackチャンネル", match: ["workflow-rules" as const] }] : []),
      ...(access.adminWorkspace ? [{ view: "admin" as const, label: "管理", description: "通知・運用の管理", match: ["admin" as const] }] : []),
      ...(access.adminWorkspace ? [{ view: "guide" as const, label: "運用ガイド", description: "権限・有効化・デプロイの要点", match: ["guide" as const] }] : [])
    ] }
  ];
  return groups.filter((group) => group.items.length > 0);
}

// URL-less breadcrumb: derive the trail from the current view so every screen
// shows where the user is and offers a one-click path back to the parent.
function breadcrumbFor(view: View): Array<{ label: string; view?: View }> {
  const home = { label: "ホーム", view: "home" as View };
  const trails: Record<View, Array<{ label: string; view?: View }>> = {
    home: [{ label: "ホーム" }],
    matters: [home, { label: "案件" }],
    documents: [home, { label: "文書" }],
    templates: [home, { label: "文書", view: "documents" }, { label: "テンプレート選択" }],
    document: [home, { label: "文書", view: "documents" }, { label: "文書作成" }],
    drafts: [home, { label: "下書き" }],
    ledgers: [home, { label: "台帳" }],
    "contract-intake": [home, { label: "契約取込" }],
    outbound: [home, { label: "アウト条件" }],
    requests: [home, { label: "依頼" }],
    works: [home, { label: "作品" }],
    "data-quality": [home, { label: "データ品質" }],
    "vendor-merge": [home, { label: "取引先名寄せ" }],
    "matter-merge": [home, { label: "案件名寄せ" }],
    guide: [home, { label: "運用ガイド" }],
    snippets: [home, { label: "定型文" }],
    "template-samples": [home, { label: "ひな形" }],
    conditions: [home, { label: "条件明細" }],
    "royalty-preview": [home, { label: "ロイヤリティ試算" }],
    billing: [home, { label: "請求" }],
    "receivable-map": [home, { label: "債権マップ" }],
    "payment-report": [home, { label: "支払報告書" }],
    "billing-print": [home, { label: "請求印刷" }],
    "excel-batch": [home, { label: "Excel一括" }],
    settings: [home, { label: "システム設定" }],
    "workflow-rules": [home, { label: "承認ルート" }],
    "contract-master": [home, { label: "契約マスタ" }],
    staff: [home, { label: "担当者" }],
    "gmail-inbound": [home, { label: "受信取込" }],
    admin: [home, { label: "管理" }]
  };
  return trails[view] ?? [{ label: "ホーム" }];
}

function Breadcrumb({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const trail = breadcrumbFor(view);
  if (trail.length <= 1) return null;
  return <nav className="breadcrumb" aria-label="現在地">
    {trail.map((crumb, index) => {
      const last = index === trail.length - 1;
      return <span key={`${crumb.label}-${index}`}>
        {crumb.view && !last
          ? <button onClick={() => onNavigate(crumb.view!)}>{crumb.label}</button>
          : <span className={last ? "current" : ""}>{crumb.label}</span>}
        {!last && <i aria-hidden="true">›</i>}
      </span>;
    })}
  </nav>;
}

export function App() {
  const [dashboard, setDashboard] = useState(fallback);
  const [templates, setTemplates] = useState<DocumentFormSchema[]>([]);
  const [schema, setSchema] = useState<DocumentFormSchema | null>(null);
  const [compatibility, setCompatibility] = useState<CompatibilityReport | null>(null);
  const [view, setView] = useState<View>("home");
  const [readOnly, setReadOnly] = useState(true);
  const [canFinalizeDocuments, setCanFinalizeDocuments] = useState(false);
  const [canGeneratePdf, setCanGeneratePdf] = useState(false);
  const [canSaveToDrive, setCanSaveToDrive] = useState(false);
  const [canCommitContractIntake, setCanCommitContractIntake] = useState(false);
  const [canEditMatters, setCanEditMatters] = useState(false);
  const [canDeleteMatters, setCanDeleteMatters] = useState(false);
  const [canEditVendors, setCanEditVendors] = useState(false);
  const [canEditWorks, setCanEditWorks] = useState(false);
  const [canEditMaterials, setCanEditMaterials] = useState(false);
  const [canEditRightsSources, setCanEditRightsSources] = useState(false);
  const [canMergeVendors, setCanMergeVendors] = useState(false);
  // データ品質→名寄せのドリル時に統合元IDを引き継ぐ（発見→是正を1動線に・Q1）。
  const [mergeSourceSeed, setMergeSourceSeed] = useState("");
  const [drillWorkId, setDrillWorkId] = useState<number | null>(null);
  const [drillConditionId, setDrillConditionId] = useState<number | null>(null);
  const [drillReceiptConditionId, setDrillReceiptConditionId] = useState<number | null>(null);
  // 条件明細→台帳（金銭条件）/ 作品ビュー→台帳（作品）へのクロスリンクで開くタブを指定（R2/R3）。
  const [ledgerSeedType, setLedgerSeedType] = useState<"conditions" | "works" | undefined>(undefined);
  const [canMergeMatters, setCanMergeMatters] = useState(false);
  const [canBacklogComment, setCanBacklogComment] = useState(false);
  const [canEditStaff, setCanEditStaff] = useState(false);
  const [canGmailNotify, setCanGmailNotify] = useState(false);
  const [canCloudSign, setCanCloudSign] = useState(false);
  const [canGmailInbound, setCanGmailInbound] = useState(false);
  const [canRecordReceipt, setCanRecordReceipt] = useState(false);
  const [canRepairConditions, setCanRepairConditions] = useState(false);
  const [canVoidDocument, setCanVoidDocument] = useState(false);
  const [canReissueDocument, setCanReissueDocument] = useState(false);
  const [canExcelBatch, setCanExcelBatch] = useState(false);
  const [canEditSettings, setCanEditSettings] = useState(false);
  const [canEditWorkflowRules, setCanEditWorkflowRules] = useState(false);
  const [canEditContractMaster, setCanEditContractMaster] = useState(false);
  const [canEditSnippets, setCanEditSnippets] = useState(false);
  const [canUploadAttachments, setCanUploadAttachments] = useState(false);
  // サイドバーのカテゴリ折りたたみ（この端末に保存）。現在地を含むグループは表示時に自動展開。
  const [collapsedNav, setCollapsedNav] = useState<Record<string, boolean>>(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem("lb-v2-nav-collapsed") ?? "{}");
      return raw && typeof raw === "object" ? raw as Record<string, boolean> : {};
    } catch { return {}; }
  });
  function toggleNavGroup(label: string) {
    setCollapsedNav((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      try { window.localStorage.setItem("lb-v2-nav-collapsed", JSON.stringify(next)); } catch { /* quota等は無視 */ }
      return next;
    });
  }
  const [currentUser, setCurrentUser] = useState<{ email: string; role: "admin" | "legal" | "requester" } | null>(null);
  const [searchSelection, setSearchSelection] = useState<{ target: "matter" | "document" | "vendor" | "work"; id: string; title: string } | null>(null);
  const [draftSelection, setDraftSelection] = useState<{ issueKey: string; templateType: string } | null>(null);
  const [deepLinkIssue, setDeepLinkIssue] = useState("");
  // Issue key seeded when 文書を作成 is launched from a matter (LB-F01 導線).
  const [newDocIssueKey, setNewDocIssueKey] = useState("");
  const [newDocSeed, setNewDocSeed] = useState<Record<string, string>>({});
  // 確定済み文書の内容を丸ごと引き継いだ新規入力（相手先だけ差し替えて2通目を出す）。
  // Backlog 抽出値のシードは「空欄だけ補完」なので、明細を含む複製には使えない。
  const [duplicateValues, setDuplicateValues] = useState<DocumentFormData | null>(null);
  const [duplicateFrom, setDuplicateFrom] = useState<string | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>("vendor");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const issueKey = params.get("issue")?.trim().slice(0, 100) ?? "";
    const requestedView = params.get("view");
    if (issueKey) setDeepLinkIssue(issueKey);
    // 別タブで開くリンク（作成フォーム横の「定型文」等）から到達できる画面。
    // 任意の view を通すと未実装・権限外の画面へ飛べてしまうので、明示的に列挙する。
    const deepLinkable: View[] = ["home", "documents", "drafts", "snippets", "template-samples", "guide"];
    if (requestedView && (deepLinkable as string[]).includes(requestedView)) {
      setView(requestedView as View);
    }
  }, []);

  useEffect(() => {
    fetch("/api/v2/me")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setCurrentUser(data.user ?? null))
      .catch(() => setCurrentUser(null));
    fetch("/api/v2/dashboard").then((response) => response.ok && response.json()).then((data) => data && setDashboard(data)).catch(() => undefined);
    fetch("/api/v2/runtime")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((runtime) => {
        const capabilities = Array.isArray(runtime.writeCapabilities)
          ? runtime.writeCapabilities as string[]
          : [];
        setReadOnly(!capabilities.includes("drafts"));
        setCanFinalizeDocuments(capabilities.includes("documents"));
        setCanGeneratePdf(capabilities.includes("pdf"));
        setCanSaveToDrive(capabilities.includes("drive"));
        setCanCommitContractIntake(capabilities.includes("contract-intake"));
        setCanEditMatters(capabilities.includes("matters"));
        setCanDeleteMatters(capabilities.includes("matter-delete"));
        setCanEditVendors(capabilities.includes("vendors"));
        setCanEditWorks(capabilities.includes("works"));
        setCanEditMaterials(capabilities.includes("materials"));
        setCanEditRightsSources(capabilities.includes("rights-sources"));
        setCanMergeVendors(capabilities.includes("vendor-merge"));
        setCanMergeMatters(capabilities.includes("matter-merge"));
        setCanBacklogComment(capabilities.includes("backlog-comment"));
        setCanEditStaff(capabilities.includes("staff"));
        setCanGmailNotify(capabilities.includes("gmail"));
        setCanCloudSign(capabilities.includes("cloudsign"));
        setCanGmailInbound(capabilities.includes("gmail-inbound"));
        setCanRecordReceipt(capabilities.includes("receipts"));
        setCanRepairConditions(capabilities.includes("condition-repair"));
        setCanVoidDocument(capabilities.includes("document-void"));
        setCanReissueDocument(capabilities.includes("document-reissue"));
        setCanExcelBatch(capabilities.includes("excel-batch"));
        setCanEditSettings(capabilities.includes("settings"));
        setCanEditWorkflowRules(capabilities.includes("workflow-rules"));
        setCanEditContractMaster(capabilities.includes("contract-master"));
        setCanEditSnippets(capabilities.includes("snippets"));
        setCanUploadAttachments(capabilities.includes("attachments"));
      })
      .catch(() => {
        setReadOnly(true);
        setCanFinalizeDocuments(false);
        setCanGeneratePdf(false);
        setCanSaveToDrive(false);
        setCanCommitContractIntake(false);
        setCanEditMatters(false);
        setCanEditVendors(false);
        setCanEditWorks(false);
        setCanEditMaterials(false);
        setCanEditStaff(false);
        setCanGmailNotify(false);
        setCanCloudSign(false);
        setCanGmailInbound(false);
        setCanRecordReceipt(false);
        setCanRepairConditions(false);
      });
    fetch("/api/v2/document-templates")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setTemplates(data.templates ?? []))
      .catch(() => undefined);
    fetch("/api/v2/document-templates/compatibility-report").then((response) => response.ok ? response.json() : Promise.reject()).then(setCompatibility).catch(() => undefined);
  }, []);

  const [formNonce, setFormNonce] = useState(0);
  // 確定済み文書を複製して新しい入力を開く。相手先だけ差し替えて2通目を出す運用
  // （同一内容の発注書を取引先A・Bへ、など）。1通目の下書きは確定時に消えているので、
  // 下書きの一意制約（受付番号×テンプレート）とは競合しない。
  async function duplicateDocument(document: RegisteredDocument, mode: DuplicateMode) {
    const response = await fetch(
      `/api/v2/document-templates/${encodeURIComponent(document.templateType)}/form-schema`);
    if (!response.ok) return;
    setFormNonce((v) => v + 1);
    setDraftSelection(null);
    setNewDocSeed({});
    setNewDocIssueKey(document.issueKey ?? "");
    setDuplicateValues(duplicateFormData(document.formData ?? {}, mode));
    setSchema(await response.json());
    setDuplicateFrom(document.documentNumber ?? null);
    setDuplicateMode(mode);
    setView("document");
  }

  async function openDocumentForm(templateKey: string) {
    setFormNonce((v) => v + 1);
    setDuplicateValues(null);
    setDuplicateFrom(null);
    const response = await fetch(
      `/api/v2/document-templates/${encodeURIComponent(templateKey)}/form-schema`
    );
    if (!response.ok) return;
    setDraftSelection(null);
    setSchema(await response.json());
    setView("document");
  }

  async function resumeDraft(issueKey: string, templateType: string) {
    const response = await fetch(
      `/api/v2/document-templates/${encodeURIComponent(templateType)}/form-schema`
    );
    if (!response.ok) return;
    setDraftSelection({ issueKey, templateType });
    setSchema(await response.json());
    setView("document");
  }

  const legalWorkspace = currentUser?.role === "admin" || currentUser?.role === "legal";
  const adminWorkspace = currentUser?.role === "admin";
  const requesterWorkspace = currentUser?.role === "requester";

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">LegalBridge <span>V2</span></div>
        <nav>
          {navGroups({ legalWorkspace, adminWorkspace, requesterWorkspace, readOnly, gmailInbound: canGmailInbound }).map((group) => {
            // 現在地を含むグループは畳んでいても自動展開（現在地が隠れないように）。
            const hasActive = group.items.some((item) => item.match.includes(view));
            const collapsed = Boolean(collapsedNav[group.label]) && !hasActive;
            return (
              <div className={`nav-group${collapsed ? " collapsed" : ""}`} key={group.label}>
                <button type="button" className="nav-group-toggle" aria-expanded={!collapsed}
                  onClick={() => toggleNavGroup(group.label)}>
                  <span className="nav-caret" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                  {group.label}
                </button>
                {!collapsed && group.items.map((item) => (
                  <button key={item.view}
                    className={item.match.includes(view) ? "active" : ""}
                    onClick={() => { setMergeSourceSeed(""); setLedgerSeedType(undefined); setView(item.view); }}
                    title={item.description}
                  >{item.label}</button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="backlog"><strong>Backlog連携</strong><small>参照のみ・変更なし</small></div>
      </aside>

      <main>
        {readOnly && (
          <div className="readonly-banner">
            読取専用プレビュー環境：本番データの保存・更新・削除・外部送信は停止しています
          </div>
        )}
        <header>
          {legalWorkspace && <GlobalSearch onNavigate={(target, id, title) => {
            setSearchSelection({ target, id, title });
            setView(target === "matter" ? "matters" : target === "document" ? "documents" : "ledgers");
          }} />}
          <div className="profile">{currentUser ? `${roleLabel(currentUser.role)}・${currentUser.email}` : "認証確認中"}</div>
        </header>

        <Breadcrumb view={view} onNavigate={setView} />

        {view === "home" && (
          requesterWorkspace && !legalWorkspace
            ? <RequesterHome onNavigate={setView} showDrafts={!readOnly}
                onCreateDocument={() => { setNewDocIssueKey(""); setNewDocSeed({}); setView("templates"); }} />
            : <Dashboard dashboard={dashboard}
                access={{ legalWorkspace, adminWorkspace, requesterWorkspace }}
                onNavigate={setView}
                onOpenMatter={(id, title) => {
                  setSearchSelection({ target: "matter", id: String(id), title });
                  setView("matters");
                }}
                onCreateDocument={() => { setNewDocIssueKey(""); setNewDocSeed({}); setView("templates"); }} />
        )}
        {view === "matters" && <MatterRegistry templates={templates}
          onOpenDocument={(id) => { setSearchSelection({ target: "document", id: String(id), title: "" }); setView("documents"); }}
          canEdit={canEditMatters}
          canDelete={canDeleteMatters}
          canUploadAttachments={canUploadAttachments}
          onCreateDocument={(legalWorkspace || requesterWorkspace)
            ? (issueKey) => { setNewDocIssueKey(issueKey ?? ""); setNewDocSeed({}); setDraftSelection(null); setView("templates"); }
            : undefined}
          selectedId={searchSelection?.target === "matter" ? Number(searchSelection.id) : undefined} />}
        {view === "drafts" && !readOnly && (
          <DraftWorkspace templates={templates} onResume={resumeDraft} initialQuery={deepLinkIssue} />
        )}
        {view === "ledgers" && <LedgerWorkspace
          canEditVendors={canEditVendors}
          canEditWorks={canEditWorks}
          canEditMaterials={canEditMaterials}
          initialType={ledgerSeedType ?? (searchSelection?.target === "work" ? "works" : searchSelection?.target === "vendor" ? "vendors" : undefined)}
          initialQuery={searchSelection?.target === "work" || searchSelection?.target === "vendor" ? searchSelection.title : undefined}
          selectedId={searchSelection?.target === "work" || searchSelection?.target === "vendor" ? searchSelection.id : undefined}
          onNavigate={(t) => setView(t as View)} />}
        {view === "contract-intake" && adminWorkspace && (
          <ContractChainWizard
            canCommit={canCommitContractIntake}
            onOpenDraft={resumeDraft}
          />
        )}
        {view === "outbound" && <OutboundConditionWorkspace onNavigate={(t) => setView(t as View)} />}
        {view === "royalty-preview" && <RoyaltyPreview />}
        {view === "billing" && <BillingDashboard key={drillReceiptConditionId ?? "billing"} canRecord={canRecordReceipt} initialConditionLineId={drillReceiptConditionId} onCreatePaymentDocument={(legalWorkspace || requesterWorkspace) ? () => { setNewDocIssueKey(""); setNewDocSeed({}); setDraftSelection(null); setView("templates"); } : undefined} />}
        {view === "works" && <WorkDetail key={drillWorkId ?? "works"} initialWorkId={drillWorkId} canEdit={canEditWorks} canEditRights={canEditRightsSources} canEditMaterials={canEditMaterials}
          onNavigate={(t) => { if (t === "ledgers-works") { setLedgerSeedType("works"); setView("ledgers"); } else setView(t as View); }} />}
        {view === "data-quality" && <DataQuality onNavigate={(v, id) => {
          setMergeSourceSeed((v === "vendor-merge" || v === "matter-merge") && id != null ? String(id) : "");
          // 監査指摘：works/conditions への「開く」が行 id を捨てていた → 詳細を直接開く。
          setDrillWorkId(v === "works" && id != null ? id : null);
          setDrillConditionId(v === "conditions" && id != null ? id : null);
          setView(v as View);
        }} />}
        {view === "vendor-merge" && <VendorMerge canMerge={canMergeVendors} initialSource={mergeSourceSeed} />}
        {view === "matter-merge" && <MatterMerge canMerge={canMergeMatters} initialSource={mergeSourceSeed} />}
        {view === "requests" && (legalWorkspace || requesterWorkspace) && (
          <RequestsWorkspace canComment={canBacklogComment}
            onCreateDocument={(issueKey, seed) => { setNewDocIssueKey(issueKey); setNewDocSeed(seed ?? {}); setDraftSelection(null); setView("templates"); }} />
        )}
        {view === "guide" && <OperationsGuide />}
        {view === "snippets" && <TextSnippets canEdit={canEditSnippets} />}
        {view === "template-samples" && <TemplateSamples />}
        {view === "receivable-map" && <ReceivableMap />}
        {view === "payment-report" && <PaymentReport />}
        {view === "billing-print" && <BillingPrint />}
        {view === "excel-batch" && <ExcelBatchWorkspace canMark={canExcelBatch} />}
        {view === "settings" && adminWorkspace && <SettingsWorkspace canEdit={canEditSettings} />}
        {view === "workflow-rules" && adminWorkspace && <WorkflowRulesWorkspace canEdit={canEditWorkflowRules} />}
        {view === "contract-master" && legalWorkspace && <ContractMasterWorkspace canEdit={canEditContractMaster} canIntake={adminWorkspace} onNavigate={(t) => setView(t as View)} />}
        {view === "conditions" && <ConditionLinesWorkspace
          key={drillConditionId ?? "conditions"} initialSelectedId={drillConditionId}
          onRecordReceipt={canRecordReceipt ? (conditionLineId) => { setDrillReceiptConditionId(conditionLineId); setView("billing"); } : undefined}
          canRepair={canRepairConditions}
          onOpenDocument={(id) => {
            setSearchSelection({ target: "document", id: String(id), title: "" });
            setView("documents");
          }}
          onCreateDocument={(legalWorkspace || requesterWorkspace)
            ? (issueKey) => { setNewDocIssueKey(issueKey ?? ""); setNewDocSeed({}); setDraftSelection(null); setView("templates"); }
            : undefined}
          onNavigate={(target) => {
            if (target === "ledgers-conditions") { setLedgerSeedType("conditions"); setView("ledgers"); }
            else setView(target as View);
          }} />}
        {view === "staff" && adminWorkspace && <StaffWorkspace canEdit={canEditStaff} />}
        {view === "gmail-inbound" && adminWorkspace && <GmailInboundWorkspace />}
        {view === "admin" && <AdminOverview />}
        {view === "documents" && (
          <DocumentRegistry templates={templates} onCreate={() => { setNewDocIssueKey(""); setNewDocSeed({}); setView("templates"); }}
            canGeneratePdf={canGeneratePdf}
            canSaveToDrive={canSaveToDrive}
            canImport={canFinalizeDocuments}
            canGmailNotify={canGmailNotify}
            canCloudSign={canCloudSign}
            canVoidDocument={canVoidDocument}
            canReissueDocument={canReissueDocument}
            initialQuery={deepLinkIssue}
            onOpenMatter={(matterId) => { setSearchSelection({ target: "matter", id: String(matterId), title: "" }); setView("matters"); }}
            selectedId={searchSelection?.target === "document" ? Number(searchSelection.id) : undefined}
            onDuplicate={(document, mode) => void duplicateDocument(document, mode)} />
        )}
        {view === "templates" && (
          <TemplateCatalog templates={templates} compatibility={compatibility} onSelect={openDocumentForm}
            seededIssueKey={newDocIssueKey} />
        )}
        {view === "document" && (
          <DocumentForm
            key={`${schema?.templateKey ?? "loading"}:${draftSelection?.issueKey ?? "new"}:${formNonce}`}
            schema={schema}
            readOnly={readOnly}
            canFinalizeDocuments={canFinalizeDocuments}
            canGeneratePdf={canGeneratePdf}
            canSaveToDrive={canSaveToDrive}
            canGmailNotify={canGmailNotify}
            canCloudSign={canCloudSign}
            initialIssueKey={draftSelection?.issueKey ?? newDocIssueKey}
            seedValues={draftSelection ? undefined : newDocSeed}
            duplicateValues={draftSelection ? undefined : duplicateValues ?? undefined}
            duplicateFrom={draftSelection ? undefined : duplicateFrom ?? undefined}
            duplicateMode={duplicateMode}
            onBack={() => setView(draftSelection ? "drafts" : "templates")}
            onCreateNew={() => setView("templates")}
            onOpenDocuments={() => setView("documents")}
            onOpenMatter={(matterId) => { setSearchSelection({ target: "matter", id: String(matterId), title: "" }); setView("matters"); }}
          />
        )}
      </main>
      {/* 統合カート（課題→案件化／案件の統合）。中身があるときだけ右下に常駐する。 */}
      <CartPanel onOpenMatter={(matterId) => {
        setSearchSelection({ target: "matter", id: String(matterId), title: "" });
        setView("matters");
      }} />
    </div>
  );
}

function TemplateCatalog({
  templates,
  compatibility,
  onSelect,
  seededIssueKey
}: {
  templates: DocumentFormSchema[];
  compatibility: CompatibilityReport | null;
  onSelect: (templateKey: string) => void;
  seededIssueKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("すべて");
  const categories = [
    "すべて",
    ...new Set(templates.map((template) => template.category ?? "未分類"))
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTemplates = templates.filter((template) => {
    const matchesCategory =
      category === "すべて" || (template.category ?? "未分類") === category;
    // 同義語検索（監査W3）：「支払」「請求」で該当テンプレが見つかるように。
    const synonyms: Record<string, string> = {
      payment_notice: "支払 支払通知 請求", invoice: "請求 請求書 支払",
      royalty_statement: "支払 請求 計算書", inspection_certificate: "検収 支払"
    };
    const matchesQuery =
      !normalizedQuery ||
      template.label.toLowerCase().includes(normalizedQuery) ||
      template.templateKey.toLowerCase().includes(normalizedQuery) ||
      (synonyms[template.templateKey] ?? "").includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  });

  return (
    <section className="page template-catalog">
      <div className="page-title">
        <div>
          <p>DOCUMENT TEMPLATES</p>
          <h1>文書を作成</h1>
          <small>DB登録済みの有効な文書template {templates.length}件</small>
        </div>
      </div>
      {seededIssueKey && <div className="context-banner">案件の課題キー <strong>{seededIssueKey}</strong> を引き継いで作成します。テンプレートを選択してください。</div>}
      <div className="template-toolbar">
        <input
          aria-label="templateを検索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="文書名またはtemplate keyで検索"
        />
        <select
          aria-label="カテゴリ"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          {categories.map((item) => <option key={item}>{item}</option>)}
        </select>
        <span>{visibleTemplates.length}件</span>
      </div>
      {compatibility && <div className="compatibility-summary"><strong>Template互換性検査</strong><span className="compat-ok">正常 {compatibility.summary.ok}</span><span className="compat-warning">要確認 {compatibility.summary.warning}</span><span className="compat-error">エラー {compatibility.summary.error}</span></div>}
      {visibleTemplates.length ? (
        <div className="template-grid">
          {visibleTemplates.map((template) => (
            <button
              className="template-card"
              key={template.templateKey}
              onClick={() => onSelect(template.templateKey)}
            >
              <span>{template.category ?? "未分類"}</span>
              <strong>{template.label}</strong>
              <small>{template.templateKey}</small>
              <em>{template.fields.length}項目</em>
              {(() => { const result = compatibility?.reports.find((item) => item.templateKey === template.templateKey); return result && <i className={`compat-badge ${result.status}`} title={[result.renderError, result.missingHelpers.length ? `helper: ${result.missingHelpers.join(", ")}` : "", result.missingPartials.length ? `partial: ${result.missingPartials.join(", ")}` : "", result.unmappedVariables.length ? `未マッピング: ${result.unmappedVariables.join(", ")}` : ""].filter(Boolean).join("\n")}>{result.status === "ok" ? "互換" : result.status === "warning" ? "要確認" : "エラー"}</i>; })()}
            </button>
          ))}
        </div>
      ) : (
        <EmptyState compact icon="▤" title="該当するテンプレートがありません" description="キーワードを変えてお試しください。" />
      )}
    </section>
  );
}

const matterStatusLabels: Record<string, string> = { open: "未着手", in_progress: "進行中", closed: "完了", archived: "保管" };

// 申請者向けホーム（R5）：法務オペレーションの俯瞰ではなく、自分の文書・下書きと
// 作成導線に絞る。依頼自体は Backlog 課題として起票する運用のため案内のみ。
function RequesterHome({ onNavigate, onCreateDocument, showDrafts }:
  { onNavigate: (view: View) => void; onCreateDocument: () => void; showDrafts: boolean }) {
  return (
    <section className="page">
      <div className="page-title">
        <div><p>MY PAGE</p><h1>マイページ</h1>
          <small>自分の文書と下書きを確認します</small></div>
        <button className="primary" onClick={onCreateDocument}>文書を作成</button>
      </div>
      <div className="workflow-rail">
        <button className="workflow-card" onClick={onCreateDocument}>
          <span className="wf-step">＋</span><strong>文書を作成</strong>
          <small>テンプレートから起票</small><span className="wf-metric">開く →</span>
        </button>
        <button className="workflow-card" onClick={() => onNavigate("documents")}>
          <span className="wf-step">▤</span><strong>自分の文書</strong>
          <small>作成した文書の確認・PDF</small><span className="wf-metric">開く →</span>
        </button>
        {showDrafts && <button className="workflow-card" onClick={() => onNavigate("drafts")}>
          <span className="wf-step">✎</span><strong>自分の下書き</strong>
          <small>保存中の下書きを再開</small><span className="wf-metric">開く →</span>
        </button>}
      </div>
      <section className="panel">
        <p className="empty-inline">新しい依頼は Backlog 課題として起票してください。作成済みの文書と下書きはこの画面から確認できます。</p>
      </section>
    </section>
  );
}

function Dashboard({ dashboard, access, onNavigate, onOpenMatter, onCreateDocument }: {
  dashboard: DashboardSummary;
  access: { legalWorkspace: boolean; adminWorkspace: boolean; requesterWorkspace: boolean };
  onNavigate: (view: View) => void;
  onOpenMatter: (id: number, title: string) => void;
  onCreateDocument: () => void;
}) {
  const kpiByLabel = new Map(dashboard.kpis.map((k) => [k.label, k.value]));
  // 業務動線レール（V1準拠）：その日の作業順を①→④で明示する。
  const railCards: Array<{ step: string; label: string; hint: string; view: View; metric?: number; show: boolean }> = [
    { step: "①", label: "案件を確認", hint: "対応中・停滞を把握", view: "matters", metric: kpiByLabel.get("対応中"), show: access.legalWorkspace },
    { step: "②", label: "文書を作成", hint: "テンプレートから起票", view: "templates", metric: undefined, show: access.legalWorkspace || access.requesterWorkspace },
    { step: "③", label: "下書きを再開", hint: "保存中の下書き", view: "drafts", metric: undefined, show: access.legalWorkspace || access.requesterWorkspace },
    { step: "④", label: "アウト条件を追記", hint: "許諾先ごとの条件", view: "outbound", metric: undefined, show: access.legalWorkspace }
  ];
  const rail = railCards.filter((card) => card.show);

  return (
    <section className="page">
      <div className="page-title">
        <div><p>LEGAL OPERATIONS</p><h1>法務オペレーション</h1>
          <small>{dashboard.source === "sample" ? "サンプル表示（本番データ未接続）" : "本番データに基づく現在状況"}</small></div>
        <button className="primary" onClick={onCreateDocument}>文書を作成</button>
      </div>

      {rail.length > 0 && <div className="workflow-rail">
        {rail.map((card) => (
          <button key={card.view} className="workflow-card" onClick={() => onNavigate(card.view)}>
            <span className="wf-step">{card.step}</span>
            <strong>{card.label}</strong>
            <small>{card.hint}</small>
            <span className="wf-metric">{card.metric !== undefined ? `${card.metric}件` : "開く"} →</span>
          </button>
        ))}
      </div>}

      <div className="kpis">
        {dashboard.kpis.map((kpi) => <article key={kpi.label} className={kpi.tone ?? ""}><span>{kpi.label}</span><strong>{kpi.value}</strong></article>)}
      </div>

      {dashboard.settlement && <SettlementBand settlement={dashboard.settlement} />}

      <section className="panel">
        <div className="panel-head"><h2>案件工程</h2>
          <span>全案件 {dashboard.stages.reduce((sum, s) => sum + s.count, 0)}</span></div>
        <div className="stages">
          {dashboard.stages.map((stage, index) => <article key={stage.label}><small>0{index + 1}</small><strong>{stage.count}</strong><span>{stage.label}</span></article>)}
        </div>
      </section>
      <div className="content-grid">
        <section className="panel">
          <div className="panel-head"><h2>優先対応案件</h2>
            {access.legalWorkspace && <button onClick={() => onNavigate("matters")}>すべて表示</button>}</div>
          {dashboard.priorities.length ? (
            <table><thead><tr><th>案件</th><th>相手方</th><th>工程</th><th>期限</th><th>状態</th></tr></thead>
              <tbody>
                {dashboard.priorities.map((matter) => <tr key={matter.id}
                  className={matter.matterId ? "row-link" : ""}
                  onClick={() => matter.matterId && onOpenMatter(matter.matterId, matter.title)}>
                  <td><b>{matter.id}</b><br />{matter.title}</td>
                  <td>{matter.counterparty}</td><td>{matter.stage}</td>
                  <td className={matter.overdue ? "overdue" : ""}>{matter.dueDate || "—"}</td>
                  <td><span className="status">{matterStatusLabels[matter.status] ?? matter.status}</span></td></tr>)}
              </tbody>
            </table>
          ) : <div className="empty-state">対応中の案件はありません。</div>}
        </section>
        <aside className="panel alerts"><div className="panel-head"><h2>本日の次アクション</h2>
          <span>{dashboard.nextActions?.length ?? 0}件</span></div>
          {dashboard.nextActions?.length ? dashboard.nextActions.map((action) => (
            <button key={action.matterId} className="next-action" onClick={() => onOpenMatter(action.matterId, action.title)}>
              <b>{action.taskTitle}</b>
              <small>{action.matterCode}・{action.title}</small>
              <em className={action.overdue ? "overdue" : ""}>{action.dueAt ? formatShortDate(action.dueAt) : "期限未設定"}</em>
            </button>
          )) : <p className="empty-inline">次アクションに設定されたタスクはありません。</p>}
        </aside>
      </div>
    </section>
  );
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function formatPercent(rate: number) {
  return `${Math.round((rate || 0) * 100)}%`;
}
function formatAmount(value: number) {
  return new Intl.NumberFormat("ja-JP").format(Math.round(value || 0));
}

// 決算バンド：消化実績・検収をポートフォリオ全体で俯瞰する。財務テーブルの
// SELECT付与がある環境でのみ dashboard.settlement が入り、ここが描画される。
function SettlementBand({ settlement }: { settlement: NonNullable<DashboardSummary["settlement"]> }) {
  const balance = settlement.plannedTotal - settlement.consumedTotal;
  const consumptionPct = Math.min(100, Math.round((settlement.consumptionRate || 0) * 100));
  const inspectionPct = Math.min(100, Math.round((settlement.inspectionRate || 0) * 100));
  return (
    <section className="settlement-band">
      <div className="panel-head"><h2>決算：消化・検収</h2><span>ポートフォリオ全体</span></div>
      <div className="settlement-kpis">
        <article>
          <span>消化率</span>
          <strong>{formatPercent(settlement.consumptionRate)}</strong>
          <div className="consumption-bar"><div style={{ width: `${consumptionPct}%` }} /><small>{consumptionPct}%</small></div>
          <small>消化 {formatAmount(settlement.consumedTotal)} / 計画 {formatAmount(settlement.plannedTotal)}</small>
        </article>
        <article>
          <span>検収率</span>
          <strong>{formatPercent(settlement.inspectionRate)}</strong>
          <div className="consumption-bar"><div style={{ width: `${inspectionPct}%` }} /><small>{inspectionPct}%</small></div>
          <small>検収 {settlement.linesInspected} / 要検収 {settlement.linesRequiringInspection} 件</small>
        </article>
        <article className={balance > 0 ? "warn" : ""}>
          <span>未消化残</span>
          <strong>{formatAmount(balance)}</strong>
          <small>計画に対する未消化額</small>
        </article>
      </div>
    </section>
  );
}

function DocumentForm({
  schema,
  readOnly,
  canFinalizeDocuments,
  canGeneratePdf = false,
  canSaveToDrive = false,
  canGmailNotify = false,
  canCloudSign = false,
  initialIssueKey,
  seedValues,
  duplicateValues,
  duplicateFrom,
  duplicateMode,
  onBack,
  onCreateNew,
  onOpenDocuments,
  onOpenMatter
}: {
  schema: DocumentFormSchema | null;
  readOnly: boolean;
  canFinalizeDocuments: boolean;
  canGeneratePdf?: boolean;
  canSaveToDrive?: boolean;
  canGmailNotify?: boolean;
  canCloudSign?: boolean;
  initialIssueKey: string;
  seedValues?: Record<string, string>;
  // 複製元の入力内容。空欄補完ではなく丸ごと初期値にする（明細・条件も引き継ぐ）。
  duplicateValues?: DocumentFormData;
  // 複製元の文書番号（案内文に出す）。
  duplicateFrom?: string;
  duplicateMode?: DuplicateMode;
  onBack: () => void;
  onCreateNew?: () => void;
  onOpenDocuments?: () => void;
  onOpenMatter?: (matterId: number) => void;
}) {
  const [issueKey, setIssueKey] = useState(initialIssueKey);
  // 受付番号はデバウンスして文脈取得する（従来は1キー入力ごとに再取得→フォーム全消去だった）。
  const [debouncedIssueKey, setDebouncedIssueKey] = useState(initialIssueKey);
  const [formData, setFormData] = useState<DocumentFormData>({});
  // ユーザーが手入力した後は文脈再取得でフォームを上書きしない（非破壊マージ）。
  const formDirtyRef = useRef(false);
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const [notice, setNotice] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  // 別タブ表示用の Blob URL。サイドの枠は 300px しかなく、A4 の文書を読むには
  // 小さすぎるため、同じ HTML をそのままタブで開けるようにする。
  // アンカーの href に載せる（window.open だとポップアップブロックに当たる）。
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (!previewHtml) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(new Blob([previewHtml], { type: "text/html;charset=utf-8" }));
    setPreviewUrl(url);
    // プレビューを取り直すたびに前の URL を解放する（開いたままのタブは維持される）。
    return () => URL.revokeObjectURL(url);
  }, [previewHtml]);
  const [finalizedDocument, setFinalizedDocument] = useState<{
    id: number;
    documentNumber: string;
    matterId?: number | null;
    integrations: { pdf: string; drive: string; backlog: string };
  } | null>(null);
  const [draftStatus, setDraftStatus] = useState<
    "loading" | "clean" | "dirty" | "saving" | "saved" | "error"
  >("loading");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedIssueKey(issueKey), 500);
    return () => clearTimeout(timer);
  }, [issueKey]);

  useEffect(() => {
    if (!schema || !debouncedIssueKey.trim()) return;
    const controller = new AbortController();
    setDraftStatus("loading");
    setNotice("");
    setFinalizedDocument(null);

    fetch(
      `/api/v2/document-form-context?template_key=${encodeURIComponent(schema.templateKey)}&issue_key=${encodeURIComponent(debouncedIssueKey.trim())}`,
      { signal: controller.signal }
    )
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("context load failed"))
      )
      .then((context) => {
        const restoredDraft = context.draft ?? null;
        if (formDirtyRef.current) {
          // 入力済みの値は保持し、空欄だけ文脈値で補完する（受付番号の後入力・修正でフォームが消えない）。
          const incoming = restoredDraft
            ? (context.formData ?? {})
            : duplicateValues
              ? { ...(context.formData ?? {}), ...duplicateValues }
              : seedFormData(context.formData ?? {}, seedValues ?? {});
          setFormData((current) => ({ ...incoming, ...current }));
          setDraft(restoredDraft);
          setDraftStatus("dirty");
          setNotice(restoredDraft
            ? "この受付番号には下書きがあります。入力中の値を保持しました（復元は下書き一覧から）"
            : "受付番号の文脈を反映しました（入力中の値は保持）");
          return;
        }
        // Backlog抽出変数を非破壊シード（下書き復元時は既存値優先で行わない）。
        setFormData(restoredDraft
          ? (context.formData ?? {})
          : duplicateValues
            // 複製は「同じ内容」が目的なので、文脈値より複製元を優先する。
            ? { ...(context.formData ?? {}), ...duplicateValues }
            : seedFormData(context.formData ?? {}, seedValues ?? {}));
        setDraft(restoredDraft);
        setDraftStatus(restoredDraft ? "saved" : "clean");
        setNotice(
          restoredDraft
            ? `保存済みの下書きを復元しました（${formatDraftTime(restoredDraft.updatedAt)}）`
            : duplicateValues
              ? `${duplicateFrom ?? "元の文書"} を下敷きにしました。`
                + (duplicateMode === "content"
                  ? "相手先・振込先は引き継いでいます — 明細・金額を入れ直してください。"
                  : "明細・金額は引き継いでいます — 相手先・振込先を選び直してください。")
              : "新しい文書として入力できます"
        );
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDraftStatus("error");
        setNotice("初期値または下書きを取得できませんでした");
      });

    return () => controller.abort();
  }, [schema, debouncedIssueKey]);

  if (!schema) {
    return <section className="page"><h1>文書作成</h1><p>フォーム定義を読み込んでいます。</p></section>;
  }
  // showWhen（条件表示）: 取引モデル等の選択に応じて使わない項目群を隠す。
  // 空になったグループはジャンプリンクごと消える（groups が visibleFields 由来のため）。
  const visibleFields = schema.fields.filter((field) =>
    field.type !== "hidden" && !isSpecializedDataField(schema.templateKey, field.name) &&
    !isInspectionFallbackFieldHidden(schema.templateKey, field.name, formData) &&
    isFieldVisible(field, formData)
  );
  const groups = [...new Set(visibleFields.map((field) => field.group ?? "基本情報"))];
  // 関数宣言の中では上の null ガードの絞り込みが効かないので、ここで確定させる。
  const templateKey = schema.templateKey;
  const honorificMismatches = honorificWarnings(formData);

  function updateValue(name: string, value: unknown) {
    if (finalizedDocument) return;
    formDirtyRef.current = true;
    // 発注書の合計金額・納期・支払日は明細から自動集計する（V1 と同じ）。
    // 集計せずに保存すると、手入力欄が空のまま PDF の合計が ¥0 になる。
    setFormData((current) =>
      withPurchaseOrderTotals(templateKey, { ...current, [name]: value }));
    setDraftStatus("dirty");
    setNotice("未保存の変更があります");
  }

  async function saveDraft() {
    if (readOnly) return;
    if (!issueKey.trim()) {
      setDraftStatus("error");
      setNotice("受付番号を入力してください");
      return;
    }

    setDraftStatus("saving");
    setNotice("下書きを保存しています");
    try {
      const response = await fetch(`/api/v2/document-drafts/${encodeURIComponent(issueKey.trim())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateType: schema!.templateKey,
          formData,
          expectedUpdatedAt: draft?.updatedAt ?? null
        })
      });
      const result = await response.json();
      if (response.status === 409) {
        setDraft(result.current);
        setDraftStatus("error");
        setNotice("別の画面で更新されています。受付番号を再入力して最新の下書きを読み込んでください");
        return;
      }
      if (!response.ok) {
        setDraftStatus("error");
        setNotice(result.error ?? "下書き保存に失敗しました");
        return;
      }
      setDraft(result.draft);
      setDraftStatus("saved");
      setNotice(`下書きを保存しました（${formatDraftTime(result.draft.updatedAt)}）`);
    } catch {
      setDraftStatus("error");
      setNotice("通信エラーにより下書きを保存できませんでした");
    }
  }

  async function discardDraft() {
    if (readOnly || !draft) return;
    if (!window.confirm("保存済みの下書きを破棄します。元に戻せません。よろしいですか？")) return;

    setDraftStatus("saving");
    setNotice("下書きを破棄しています");
    try {
      const query = new URLSearchParams({ template_type: schema!.templateKey });
      const response = await fetch(
        `/api/v2/document-drafts/${encodeURIComponent(issueKey.trim())}?${query.toString()}`,
        { method: "DELETE" }
      );
      const result = await response.json();
      if (!response.ok) {
        setDraftStatus("error");
        setNotice(result.error ?? "下書きを破棄できませんでした");
        return;
      }

      const contextQuery = new URLSearchParams({
        template_key: schema!.templateKey,
        issue_key: issueKey.trim()
      });
      const contextResponse = await fetch(`/api/v2/document-form-context?${contextQuery.toString()}`);
      const context = contextResponse.ok ? await contextResponse.json() : { formData: {} };
      setDraft(null);
      setFormData(context.formData ?? {});
      setPreviewHtml("");
      setDraftStatus("clean");
      setNotice("下書きを破棄しました");
    } catch {
      setDraftStatus("error");
      setNotice("通信エラーにより下書きを破棄できませんでした");
    }
  }

  async function finalizeDocument() {
    if (!canFinalizeDocuments || !draft || draftStatus !== "saved") return;
    if (!window.confirm(
      "保存済みの下書きを文書として確定します。確定後はこの下書きを編集できません。よろしいですか？"
    )) return;

    setDraftStatus("saving");
    setNotice("文書を確定しています");
    try {
      const response = await fetch("/api/v2/documents/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueKey: issueKey.trim(),
          templateType: schema!.templateKey,
          templateVersionId: schema!.templateVersionId,
          formData,
          expectedDraftUpdatedAt: draft.updatedAt
        })
      });
      const result = await response.json();
      if (response.status === 409) {
        setDraftStatus("error");
        setNotice("下書きが別の画面で更新されています。再読み込みしてから確定してください");
        return;
      }
      if (!response.ok) {
        setDraftStatus("error");
        setNotice(result.error ?? "文書を確定できませんでした");
        return;
      }

      setFinalizedDocument({
        id: result.document.id,
        documentNumber: result.document.documentNumber,
        matterId: result.document.matterId ?? null,
        integrations: result.integrations
      });
      setDraft(null);
      setDraftStatus("clean");
      setNotice(`文書 ${result.document.documentNumber} を確定しました`);
    } catch {
      setDraftStatus("error");
      setNotice("通信エラーにより文書を確定できませんでした");
    }
  }

  async function validate() {
    const response = await fetch("/api/v2/documents/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateKey: schema!.templateKey,
        templateVersionId: schema!.templateVersionId,
        formData
      })
    });
    const result = await response.json();
    if (!response.ok) {
      setNotice(result.errors?.map((item: { message: string }) => item.message).join("、") ?? result.error);
      return;
    }
    const previewResponse = await fetch("/api/v2/documents/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateKey: schema!.templateKey,
        templateVersionId: schema!.templateVersionId,
        formData
      })
    });
    const preview = await previewResponse.json();
    setPreviewHtml(previewResponse.ok ? preview.html : "");
    setNotice(previewResponse.ok ? "入力検証とプレビュー生成が完了しました" : preview.error);
  }

  return (
    <section className="page">
      <div className="page-title document-form-title">
        <div>
          <button className="text-button" onClick={onBack}>← 前の画面へ戻る</button>
          <p>DOCUMENT CREATION</p>
          <h1>{schema.label}</h1>
          <div className="draft-summary" aria-live="polite">
            <span className={`draft-status ${draftStatus}`}>
              {draftStatus === "loading" ? "読込中" :
                draftStatus === "clean" ? "未保存" :
                draftStatus === "dirty" ? "変更あり" :
                draftStatus === "saving" ? "処理中" :
                draftStatus === "saved" ? "保存済み" : "要確認"}
            </span>
            <small>テンプレート：{schema.templateKey}</small>
            {notice && <small>{notice}</small>}
          </div>
          <label className="draft-key">受付番号（Backlog課題キー）
            <input
              value={issueKey}
              onChange={(event) => {
                setIssueKey(event.target.value);
                setDraft(null);
                setDraftStatus("loading");
              }}
              disabled={draftStatus === "saving" || Boolean(finalizedDocument)}
              placeholder="例：LEGAL-123"
            />
          </label>
        </div>
        <div className="actions">
          <button onClick={validate}>内容をプレビュー</button>
          {/* 横の枠は 300px、狭い画面では非表示になるので、拡大導線はボタン側に置く。 */}
          {previewUrl && <a className="button-link" href={previewUrl} target="_blank" rel="noreferrer">別タブで大きく表示</a>}
          {!readOnly && (
            <>
              {draft && (
                <button
                  className="danger-button"
                  onClick={discardDraft}
                  disabled={draftStatus === "saving"}
                >
                  下書きを破棄
                </button>
              )}
              <button
                className="primary"
                onClick={saveDraft}
                disabled={draftStatus === "saving" || draftStatus === "loading" || !issueKey.trim() || Boolean(finalizedDocument)}
              >
                {draftStatus === "saving" ? "処理中…" : draft ? "下書きを更新" : "下書きを保存"}
              </button>
              {canFinalizeDocuments && (
                <button
                  className="finalize-button"
                  onClick={finalizeDocument}
                  disabled={!draft || draftStatus !== "saved"}
                  title={!draft || draftStatus !== "saved" ? "保存済みで未変更の下書きが必要です" : undefined}
                >
                  文書を確定
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {finalizedDocument && (
        <div className="finalization-result" role="status">
          <div>
            <span>DOCUMENT FINALIZED</span>
            <strong>{finalizedDocument.documentNumber}</strong>
            <small>文書ID: {finalizedDocument.id}</small>
          </div>
          <p>文書番号の発番とDB確定が完了しました。この画面から PDF 生成・Drive 保存・送信まで行えます。</p>
          <DocumentOutputActions
            documentId={finalizedDocument.id}
            documentNumber={finalizedDocument.documentNumber}
            matterId={finalizedDocument.matterId}
            canGeneratePdf={canGeneratePdf}
            canSaveToDrive={canSaveToDrive}
            canGmailNotify={canGmailNotify}
            canCloudSign={canCloudSign} />
          <div className="finalization-next">
            <span className="next-label">次の操作</span>
            {onCreateNew && <button className="primary" onClick={onCreateNew}>新しい文書を作成</button>}
            {finalizedDocument.matterId != null && onOpenMatter &&
              <button onClick={() => onOpenMatter(finalizedDocument.matterId!)}>案件を開く（送付記録へ）</button>}
            {onOpenDocuments && <button onClick={onOpenDocuments}>文書一覧へ</button>}
            <button onClick={onBack}>閉じる</button>
          </div>
        </div>
      )}
      {readOnly && (
        <div className="form-readonly-note">
          読取専用環境では入力確認とプレビューのみ利用できます。下書きは保存されません。
        </div>
      )}
      {/* 区分と敬称の食い違いはフォームでは見えにくい（別のグループに並ぶ）。
          PDF 側は区分を優先して出すが、入力自体を直せるようここで知らせる。 */}
      {honorificMismatches.length > 0 && (
        <div className="form-mismatch-note" role="status">
          {honorificMismatches.map((warning) => (
            <p key={warning.label}>{warning.message}敬称欄を直すか、区分を選び直してください。</p>
          ))}
        </div>
      )}
      <div className="form-layout">
        <nav className="form-nav">
          {groups.map((group, index) => <a key={group} href={`#group-${index}`}>{group}</a>)}
          {hasSpecializedForm(schema.templateKey) && <a href="#specialized-fields">明細・条件</a>}
        </nav>
        <form className="form-panel">
          <MasterDataPicker schema={schema} formData={formData}
            onApply={(patch, message) => {
              if (finalizedDocument) return;
              setFormData((current) => ({ ...current, ...patch }));
              setDraftStatus("dirty");
              setNotice(message);
            }} />
          {groups.map((group, index) => <section id={`group-${index}`} key={group}><h2>{group}</h2>
            {isPurchaseOrderTemplate(schema.templateKey) && group.startsWith("IV. ") &&
              <PurchaseOrderTotals formData={formData} />}
            <div className="field-grid">{visibleFields.filter((field) => (field.group ?? "基本情報") === group).map((field) => <label key={field.name}><span>{field.label ?? field.name}{field.required && <em>必須</em>}{field.type === "textarea" && <a className="field-snippets" href="/?view=snippets" target="_blank" rel="noreferrer" title="定型文を別タブで開く">定型文</a>}</span>{field.type === "textarea" ? <textarea value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, event.target.value)} placeholder={field.placeholder} /> : field.type === "select" ? <select value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, event.target.value)}><option value="">選択してください</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : field.type === "boolean" ? <input type="checkbox" checked={Boolean(formData[field.name])} onChange={(event) => updateValue(field.name, event.target.checked)} /> : <input value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, field.type === "number" ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value)} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} placeholder={field.placeholder} />}{field.helpText && <small>{field.helpText}</small>}</label>)}</div>
          </section>)}
          {schema.templateKey === "individual_license_terms_v3" && (
            <IndividualLicenseV3Form formData={formData} onChange={updateValue} />
          )}
          <SpecializedDocumentForms templateKey={schema.templateKey} formData={formData} onChange={updateValue} />
        </form>
        <aside className="preview">
          <strong>文書プレビュー</strong>
          {previewHtml
            ? <iframe title="文書プレビュー" sandbox="" srcDoc={previewHtml} />
            : <div>「内容をプレビュー」を押すと、現在の入力内容を文書形式で確認できます。</div>}
          <small>Template version: {schema.templateVersionId}</small>
        </aside>
      </div>
    </section>
  );
}


// 発注書の自動集計を入力中に見せる。合計金額の欄は「明細から自動集計」と書いてあるのに
// ただの空の数値入力で、明細を何行入れても 0 のままだった（PDF も同様）。
// 集計は updateValue が formData へ書き戻すので、ここは同じ値を読むだけにする。
function PurchaseOrderTotals({ formData }: { formData: DocumentFormData }) {
  const totals = purchaseOrderTotals(formData);
  const rows = Array.isArray(formData.items) ? formData.items.length : 0;
  const fees = Array.isArray(formData.other_fees) ? formData.other_fees.length : 0;
  if (!rows && !fees) {
    return <p className="muted-note">
      明細を追加すると、合計金額・納期・支払日を自動集計します。
      明細を使わない場合だけ、下の合計金額に直接入力してください。
    </p>;
  }
  const yen = (value: number) => `¥ ${value.toLocaleString("ja-JP")}`;
  const dateOrDash = (value: unknown) => String(value ?? "").trim() || "明細の日付が未入力";
  return <dl className="po-totals">
    <div><dt>確定額 小計（税抜）</dt><dd>{yen(totals.itemsSubtotalExTax)}<small>明細 {rows} 件</small></dd></div>
    <div><dt>手数料 小計（税抜）</dt><dd>{yen(totals.otherFeesTotal)}<small>その他手数料 {fees} 件</small></dd></div>
    <div><dt>合計金額（税抜）</dt><dd><strong>{yen(totals.grandTotalExTax)}</strong><small>業務委託＋手数料</small></dd></div>
    <div><dt>納期</dt><dd>{dateOrDash(formData.summaryDeliveryDate)}<small>明細の納期から集約</small></dd></div>
    <div><dt>支払日</dt><dd>{dateOrDash(formData.summaryPaymentDate)}<small>明細の支払日から集約</small></dd></div>
  </dl>;
}

function formatDraftTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function isSpecializedDataField(templateKey: string, fieldName: string) {
  const specializedFields: Record<string, string[]> = {
    purchase_order: ["items", "expenses", "other_fees", "financial_conditions"],
    intl_purchase_order: ["items", "expenses", "other_fees", "financial_conditions"],
    individual_license_terms: ["financial_conditions", "サブライセンシー一覧"],
    individual_license_terms_v3: ["v3_conds", "v3_lcs", "v3_sublicensees", "v3_calc_base_rows", "v3_special_extras"],
    royalty_statement: ["lines"],
    inspection_certificate: ["delivery_line_items", "other_fees", "expenses", "changeLogs"]
  };
  return specializedFields[templateKey]?.includes(fieldName) ?? false;
}

function hasSpecializedForm(templateKey: string) {
  return [
    "purchase_order",
    "intl_purchase_order",
    "individual_license_terms",
    "individual_license_terms_v3",
    "royalty_statement",
    "inspection_certificate"
  ].includes(templateKey);
}

type V3Row = Record<string, unknown>;

function IndividualLicenseV3Form({ formData, onChange }: { formData: DocumentFormData; onChange: (name: string, value: unknown) => void }) {
  const rows = (key: string): V3Row[] => Array.isArray(formData[key]) ? formData[key] as V3Row[] : [];
  const conditions = rows("v3_conds");
  const materials = rows("v3_lcs");
  const replaceRow = (key: string, index: number, patch: V3Row) => onChange(key, rows(key).map((row, i) => i === index ? { ...row, ...patch } : row));
  const addRow = (key: string, row: V3Row) => onChange(key, [...rows(key), row]);
  const removeRow = (key: string, index: number) => onChange(key, rows(key).filter((_, i) => i !== index));
  const field = (label: string, value: unknown, set: (value: string) => void, type: "text" | "number" = "text") =>
    <label><span>{label}</span><input type={type} value={String(value ?? "")} onChange={(event) => set(event.target.value)} /></label>;
  return <div id="specialized-fields" className="v3-editor">
    <section>
      <div className="repeater-title"><div><h2>V. 取引形態</h2><small>製造販売、サブライセンス等の条件を追加します。</small></div><button type="button" onClick={() => addRow("v3_conds", { id: String(Date.now()), addon: true, cur: "JPY", qty: "1", ag: "0", mg: "0" })}>＋ 取引形態</button></div>
      {!conditions.length && <p className="inline-empty">取引形態を追加してください。</p>}
      {conditions.map((condition, index) => <article className="repeater-card" key={String(condition.id ?? index)}>
        <div className="repeater-card-head"><strong>条件{index + 1}</strong><button type="button" onClick={() => removeRow("v3_conds", index)}>削除</button></div>
        <div className="field-grid">
          {field("取引形態名", condition.name, (value) => replaceRow("v3_conds", index, { name: value }))}
          <label><span>料率方式</span><select value={condition.addon ? "addon" : "fixed"} onChange={(event) => replaceRow("v3_conds", index, { addon: event.target.value === "addon" })}><option value="addon">加算型（構成要素の料率合計）</option><option value="fixed">非加算型（実効料率）</option></select></label>
          {!condition.addon && field("実効料率（%）", condition.fixedRate, (value) => replaceRow("v3_conds", index, { fixedRate: value }), "number")}
          <label><span>計算モデル</span><select value={String(condition.calc_type ?? "")} onChange={(event) => replaceRow("v3_conds", index, { calc_type: event.target.value })}><option value="">選択してください</option><option value="BASE_QTY_RATE">基準価格×個数×料率</option><option value="BASE_RATE">実効料率</option><option value="FIXED">固定額</option><option value="SUBSCRIPTION">サブスク</option><option value="SUPPLY_QTY">供給価格×個数×料率</option></select></label>
          {field("製造者", condition.manufacturer, (v) => replaceRow("v3_conds", index, { manufacturer: v }))}
          {field("販売者", condition.seller, (v) => replaceRow("v3_conds", index, { seller: v }))}
          {field("基準価格", condition.basePrice, (v) => replaceRow("v3_conds", index, { basePrice: v }))}
          {field("今回地域", condition.reg, (v) => replaceRow("v3_conds", index, { reg: v }))}
          {field("今回言語", condition.lang, (v) => replaceRow("v3_conds", index, { lang: v }))}
          {field("数量", condition.qty, (v) => replaceRow("v3_conds", index, { qty: v }))}
          {field("AG", condition.ag, (v) => replaceRow("v3_conds", index, { ag: v }), "number")}
          {field("MG", condition.mg, (v) => replaceRow("v3_conds", index, { mg: v }), "number")}
          {field("通貨", condition.cur, (v) => replaceRow("v3_conds", index, { cur: v }))}
        </div>
      </article>)}
    </section>
    <section>
      <div className="repeater-title"><div><h2>VI. 構成要素・料率マトリクス</h2><small>権利台帳の構成要素と取引形態別料率を入力します。</small></div><button type="button" onClick={() => addRow("v3_lcs", { rates: {} })}>＋ 構成要素</button></div>
      {!materials.length && <p className="inline-empty">構成要素を追加してください。</p>}
      {materials.map((material, index) => {
        const rates = material.rates && typeof material.rates === "object" ? material.rates as V3Row : {};
        return <article className="repeater-card" key={index}>
          <div className="repeater-card-head"><strong>構成要素{index + 1}</strong><button type="button" onClick={() => removeRow("v3_lcs", index)}>削除</button></div>
          <div className="field-grid">
            {field("素材コード", material.material_code, (v) => replaceRow("v3_lcs", index, { material_code: v }))}
            {field("構成要素名", material.name, (v) => replaceRow("v3_lcs", index, { name: v }))}
            {field("権利元", material.holder, (v) => replaceRow("v3_lcs", index, { holder: v }))}
            {field("根拠文書番号", material.source_doc, (v) => replaceRow("v3_lcs", index, { source_doc: v }))}
            {field("許諾地域", material.region, (v) => replaceRow("v3_lcs", index, { region: v }))}
            {field("許諾言語", material.language, (v) => replaceRow("v3_lcs", index, { language: v }))}
            {conditions.filter((condition) => Boolean(condition.addon)).map((condition, ci) => {
              const key = String(condition.id ?? ci);
              return field(`${String(condition.name || `条件${ci + 1}`)} 料率（%）`, rates[key], (v) => replaceRow("v3_lcs", index, { rates: { ...rates, [key]: v } }), "number");
            })}
          </div>
        </article>;
      })}
    </section>
    <SimpleRepeater title="VII. サブライセンシー" itemLabel="サブライセンシー" rows={rows("v3_sublicensees")} fields={[["slPartner","相手方"],["slRegion","地域"],["slLang","言語"],["slCond","条件"],["slRate","料率"],["slDate","開始日"],["slNote","備考"]]} onAdd={() => addRow("v3_sublicensees", {})} onChange={(i,p) => replaceRow("v3_sublicensees",i,p)} onRemove={(i) => removeRow("v3_sublicensees",i)} />
    <SimpleRepeater title="VIII. 計算基準日" itemLabel="基準日" rows={rows("v3_calc_base_rows")} fields={[["edition","版"],["trigger","起点事由"],["note","備考"]]} onAdd={() => addRow("v3_calc_base_rows", {})} onChange={(i,p) => replaceRow("v3_calc_base_rows",i,p)} onRemove={(i) => removeRow("v3_calc_base_rows",i)} />
    <SimpleRepeater title="IX. 特記事項" itemLabel="特記事項" rows={rows("v3_special_extras")} fields={[["seId","項番"],["seText","内容"]]} onAdd={() => addRow("v3_special_extras", {})} onChange={(i,p) => replaceRow("v3_special_extras",i,p)} onRemove={(i) => removeRow("v3_special_extras",i)} />
  </div>;
}
function SimpleRepeater({ title, itemLabel, rows, fields, onAdd, onChange, onRemove }: { title: string; itemLabel: string; rows: V3Row[]; fields: string[][]; onAdd: () => void; onChange: (index: number, patch: V3Row) => void; onRemove: (index: number) => void }) {
  return <section><div className="repeater-title"><h2>{title}</h2><button type="button" onClick={onAdd}>＋ 追加</button></div>{rows.map((row,index) => <article className="repeater-card" key={index}><div className="repeater-card-head"><strong>{itemLabel}{index+1}</strong><button type="button" onClick={() => onRemove(index)}>削除</button></div><div className="field-grid">{fields.map(([name,label]) => <label key={name}><span>{label}</span><input value={String(row[name] ?? "")} onChange={(event) => onChange(index,{[name]:event.target.value})} /></label>)}</div></article>)}</section>;
}

function roleLabel(role: "admin" | "legal" | "requester") {
  if (role === "admin") return "管理者";
  if (role === "legal") return "法務担当";
  return "依頼者";
}
