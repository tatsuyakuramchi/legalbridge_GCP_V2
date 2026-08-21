import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardSummary, DocumentFormSchema } from "../types.js";
import { checkDatabase, getOutboundPool, getPool } from "./db/pool.js";
import {
  MemoryDraftRepository,
  PgDraftRepository,
  type DraftRepository
} from "./documents/draft-repository.js";
import { createDocumentRouter } from "./documents/routes.js";
import { createTemplateSampleRouter } from "./documents/sample-preview-routes.js";
import { createTemplateRegressionRouter } from "./documents/template-regression.js";
import {
  MemoryDocumentFinalizationRepository,
  PgDocumentFinalizationRepository,
  type DocumentFinalizationRepository
} from "./documents/finalization-repository.js";
import { createDocumentFinalizationRouter } from "./documents/finalization-routes.js";
import {
  MemoryDocumentRegistryRepository,
  PgDocumentRegistryRepository,
  type DocumentRegistryRepository
} from "./documents/registry-repository.js";
import { createDocumentRegistryRouter } from "./documents/registry-routes.js";
import { createDocumentLookupRouter } from "./documents/document-lookup-routes.js";
import {
  PgDocumentLookupRepository,
  MemoryDocumentLookupRepository,
  type DocumentLookupRepository
} from "./documents/document-lookup-repository.js";
import { createDocumentPdfRouter } from "./documents/pdf-routes.js";
import { createDocumentDriveRouter } from "./documents/drive-routes.js";
import {
  GoogleDriveStorage,
  type DriveStorage
} from "./documents/drive-storage.js";
import {
  ChromiumPdfRenderer,
  type PdfRenderer
} from "./documents/pdf-renderer.js";
import {
  MemoryTemplateRepository,
  PgTemplateRepository,
  type TemplateRepository
} from "./documents/template-repository.js";
import {
  createIntegrationAdapters,
  backlogReadEnabled,
  type IntegrationAdapter
} from "./integrations/index.js";
import {
  type BacklogReadClient, type BacklogWriteClient
} from "./integrations/backlog-web-api.js";
import { createBacklogRequestRouter, createBacklogCommentRouter } from "./integrations/backlog-routes.js";

// Backlog クライアントは createApp 内で DynamicBacklogClient として構築する
// （host/projectKey を連携設定からランタイム解決・apiKey は Secret/env のまま）。
import { config } from "./config.js";
import {
  MemoryMasterDataRepository,
  PgMasterDataRepository,
  type MasterDataRepository
} from "./master-data/repository.js";
import { createMasterDataRouter } from "./master-data/routes.js";
import { MemoryMatterRepository, PgMatterRepository, type MatterRepository } from "./matters/repository.js";
import { createMatterRouter } from "./matters/routes.js";
import {
  MemoryMatterWriteRepository, PgMatterWriteRepository, type MatterWriteRepository
} from "./matters/write-repository.js";
import { createMatterWriteRouter } from "./matters/write-routes.js";
import {
  PgMatterIssueWriteRepository,
  type MatterIssueWriteRepository
} from "./matters/matter-issue-write-repository.js";
import {
  PgMatterDocumentWriteRepository,
  type MatterDocumentWriteRepository
} from "./matters/matter-document-write-repository.js";
import {
  PgMatterSendRepository,
  type MatterSendRepository
} from "./matters/matter-send-repository.js";
import { createMatterSendRouter } from "./matters/matter-send-routes.js";
import {
  PgMatterDriveRepository,
  type MatterDriveRepository
} from "./matters/matter-drive-repository.js";
import { createMatterDriveRouter } from "./matters/matter-drive-routes.js";
import {
  PgMatterMergeRepository,
  type MatterMergeRepository
} from "./matters/matter-merge-repository.js";
import { createMatterMergeRouter } from "./matters/matter-merge-routes.js";
import {
  PgMatterDeleteRepository,
  type MatterDeleteRepository
} from "./matters/matter-delete-repository.js";
import { createMatterDeleteRouter } from "./matters/matter-delete-routes.js";
import { PgDocumentVoidRepository, type DocumentVoidRepository } from "./documents/document-void-repository.js";
import { createDocumentVoidRouter } from "./documents/document-void-routes.js";
import { PgDocumentReissueRepository, type DocumentReissueRepository } from "./documents/document-reissue-repository.js";
import { createDocumentReissueRouter } from "./documents/document-reissue-routes.js";
import { PgExcelBatchRepository, type ExcelBatchRepository } from "./documents/excel-batch-repository.js";
import { createExcelBatchRouter } from "./documents/excel-batch-routes.js";
import { PgAppSettingsRepository, type AppSettingsRepository } from "./settings/settings-repository.js";
import { loadCompanyProfile } from "./settings/company-profile.js";
import { loadEmailSettings } from "./settings/email-settings.js";
import { createEmailSettingsRouter } from "./settings/email-settings-routes.js";
import { createSettingsRouter } from "./settings/settings-routes.js";
import { PgWorkflowRulesRepository, type WorkflowRulesRepository } from "./settings/workflow-rules-repository.js";
import { createWorkflowRulesRouter } from "./settings/workflow-rules-routes.js";
import { PgContractMasterRepository, type ContractMasterRepository } from "./contracts/contract-master-repository.js";
import { PgContractCheckRepository, type ContractCheckRepository } from "./contract-check/repository.js";
import { PgSnippetsRepository, type SnippetsRepository } from "./snippets/snippets-repository.js";
import { createSnippetsRouter } from "./snippets/snippets-routes.js";
import { PgAttachmentsRepository, type AttachmentsRepository } from "./documents/attachments-repository.js";
import { RuntimeIntegrationSettings } from "./settings/runtime-settings.js";
import { RuntimeSecrets } from "./settings/runtime-secrets.js";
import type { SecretKey } from "./settings/secrets-fields.js";
import { GcpSecretStore, type SecretStore } from "./settings/secret-store.js";
import { createSecretsRouter } from "./settings/secrets-routes.js";
import {
  DynamicBacklogClient, DynamicGmailApiClient, DynamicGmailInboundClient, DynamicSlackWebApiClient
} from "./integrations/dynamic-clients.js";
import { createAttachmentsRouter } from "./documents/attachments-routes.js";
import { createPortalAttachmentRouter, PgPortalIssueResolver } from "./documents/portal-attachment-routes.js";
import { createContractCheckRouter } from "./contract-check/routes.js";
import { createContractMasterRouter } from "./contracts/contract-master-routes.js";
import { createJobsRouter, type JobRunner } from "./internal/jobs-routes.js";
import { PgDailyChecksRepository } from "./jobs/daily-checks-repository.js";
import { runDailyChecks, DryRunDailyChecksNotifier, jstTodayYmd } from "./jobs/daily-checks-runner.js";
import { LiveDailyChecksNotifier } from "./jobs/daily-checks-live-notifier.js";
import { runInspectionDigest } from "./jobs/inspection-digest-runner.js";
import { runCloudSignSync } from "./jobs/cloudsign-sync-runner.js";
import { createWebhooksRouter, type WebhookHandler } from "./internal/webhooks-routes.js";
import { createSlackIntakeRouter } from "./internal/slack-intake-routes.js";
import { createSlackIntakeHandler } from "./slack-intake/handler.js";
import { PgSlackIntakeRepository } from "./slack-intake/intake-repository.js";
import { PgWebhookReceiptsRepository } from "./internal/webhook-receipts-repository.js";
import { PgContractStatusWriter } from "./documents/contract-status-writer.js";
import { createCloudSignWebhookHandler, createBacklogWebhookHandler } from "./integrations/webhook-handlers.js";
import {
  GoogleMatterDriveFolderService,
  LocalMatterDriveFolderService,
  type MatterDriveFolderService
} from "./documents/drive-folder.js";
import {
  LiveMatterSlackNotifier,
  NoopMatterSlackNotifier,
  type MatterSlackNotifier
} from "./matters/matter-slack-notifier.js";
import { buildMatterDashboard } from "./matters/dashboard.js";
import {
  MemoryConditionLineRepository, PgConditionLineRepository, type ConditionLineRepository
} from "./conditions/repository.js";
import { createConditionLineRouter } from "./conditions/routes.js";
import { createRoyaltyRouter } from "./royalty/routes.js";
import {
  MemoryPendingInspectionRepository, PgPendingInspectionRepository, type PendingInspectionRepository
} from "./inspections/repository.js";
import { createPendingInspectionRouter } from "./inspections/routes.js";
import {
  MemoryVendorWriteRepository, PgVendorWriteRepository, type VendorWriteRepository
} from "./vendors/write-repository.js";
import { createVendorWriteRouter } from "./vendors/write-routes.js";
import {
  MemoryStaffRepository, PgStaffRepository, type StaffRepository
} from "./staff/repository.js";
import { createStaffRouter } from "./staff/routes.js";
import {
  MemoryWorkWriteRepository, PgWorkWriteRepository, type WorkWriteRepository
} from "./works/write-repository.js";
import { createWorkWriteRouter } from "./works/write-routes.js";
import {
  MemoryWorkReadRepository, PgWorkReadRepository, type WorkReadRepository
} from "./works/read-repository.js";
import { createWorkReadRouter } from "./works/read-routes.js";
import {
  MemoryDataQualityRepository, PgDataQualityRepository, type DataQualityRepository
} from "./data-quality/repository.js";
import { createDataQualityRouter } from "./data-quality/routes.js";
import {
  MemoryVendorMergeRepository, PgVendorMergeRepository, type VendorMergeRepository
} from "./vendors/merge-repository.js";
import { createVendorMergeRouter } from "./vendors/merge-routes.js";
import {
  MemoryMaterialWriteRepository, PgMaterialWriteRepository, type MaterialWriteRepository
} from "./materials/write-repository.js";
import { createMaterialWriteRouter } from "./materials/write-routes.js";
import {
  MemoryRightsSourceWriteRepository, PgRightsSourceWriteRepository, type RightsSourceWriteRepository
} from "./works/rights-source-write-repository.js";
import { createRightsSourceWriteRouter } from "./works/rights-source-write-routes.js";
import {
  MemoryRoyaltyEventRepository, PgRoyaltyEventRepository, type RoyaltyEventRepository
} from "./royalty/event-repository.js";
import { createRoyaltyEventRouter } from "./royalty/event-routes.js";
import {
  MemoryReceiptRepository, PgReceiptRepository, type ReceiptRepository
} from "./royalty/receipt-repository.js";
import { createReceiptRouter } from "./royalty/receipt-routes.js";
import {
  MemoryReceiptDashboardRepository, PgReceiptDashboardRepository, type ReceiptDashboardRepository
} from "./royalty/receipt-dashboard-repository.js";
import { createReceiptDashboardRouter } from "./royalty/receipt-dashboard-routes.js";
import {
  MemoryReceivableMapRepository, PgReceivableMapRepository, type ReceivableMapRepository
} from "./royalty/receivable-map-repository.js";
import { createReceivableMapRouter } from "./royalty/receivable-map-routes.js";
import {
  MemoryPaymentReportRepository, PgPaymentReportRepository, type PaymentReportRepository
} from "./royalty/payment-report-repository.js";
import { createPaymentReportRouter } from "./royalty/payment-report-routes.js";
import {
  MemoryDocumentImportRepository, PgDocumentImportRepository, type DocumentImportRepository
} from "./documents/import-repository.js";
import { createDocumentImportRouter } from "./documents/import-routes.js";
import { MemoryLedgerRepository, PgLedgerRepository, type LedgerRepository } from "./ledgers/repository.js";
import { createLedgerRouter } from "./ledgers/routes.js";
import { createOutboundConditionRouter } from "./ledgers/outbound-conditions.js";
import { createContractIntakeRouter } from "./contracts/intake.js";
import {
  PgContractIntakeRepository,
  type ContractIntakeRepository
} from "./contracts/intake-repository.js";
import {
  PgContractIntakeDocumentSourceRepository,
  type ContractIntakeDocumentSourceRepository
} from "./contracts/intake-document-repository.js";
import { createContractIntakeDocumentRouter } from "./contracts/intake-document-routes.js";
import {
  PgContractOutboundRepository,
  type ContractOutboundRepository
} from "./contracts/intake-outbound-repository.js";
import { createContractOutboundRouter } from "./contracts/intake-outbound-routes.js";
import {
  PgOutboundConditionRepository,
  type OutboundConditionRepository
} from "./ledgers/outbound-condition-repository.js";
import { MemoryGlobalSearchRepository, PgGlobalSearchRepository, type GlobalSearchRepository } from "./search/repository.js";
import { createGlobalSearchRouter } from "./search/routes.js";
import { MemoryAdminRepository, PgAdminRepository, type AdminRepository } from "./admin/repository.js";
import { createAdminRouter } from "./admin/routes.js";
import { createOperationalDiagnosticsRouter } from "./admin/diagnostics.js";
import { createSlackRecipientDirectory } from "./integrations/slack-recipient-resolver.js";
import {
  DisabledSlackDeliveryAdapter,
  type SlackDeliveryAdapter
} from "./integrations/slack-delivery-adapter.js";
import { SlackWebApiDeliveryAdapter } from "./integrations/slack-web-api-adapter.js";
import { SlackChannelDirectory } from "./integrations/slack-channel-directory.js";
import {
  SlackWebApiConversationReader, DisabledSlackConversationReader,
  type SlackConversationReader
} from "./integrations/slack-conversation-reader.js";
import { createMatterSlackHistoryRouter } from "./matters/matter-slack-history-routes.js";
import {
  WebApiMatterSlackChannelAdapter,
  LocalMatterSlackChannelAdapter,
  type MatterSlackChannelAdapter
} from "./integrations/slack-matter-channel.js";
import { createMatterSlackRouter } from "./matters/matter-slack-routes.js";
import {
  GoogleDrivePermissionGranter,
  LocalDrivePermissionGranter,
  type DrivePermissionGranter
} from "./documents/drive-permission.js";
import {
  PgMatterSlackThreadRepository,
  PgMatterMentionRepository,
  type MatterSlackThreadRepository,
  type MatterMentionRepository
} from "./matters/matter-slack-thread-repository.js";
import {
  LocalGmailDeliveryAdapter, type GmailDeliveryAdapter
} from "./integrations/gmail-delivery-adapter.js";
import {
  GmailApiDeliveryAdapter
} from "./integrations/gmail-api-adapter.js";
import { createGmailNotificationRouter } from "./documents/gmail-notification-routes.js";
import { createSendHistoryRouter, PgRecipientSuggestionSource } from "./documents/send-history-routes.js";
import {
  LocalCloudSignAdapter, parseAllowedRecipients, type CloudSignAdapter
} from "./integrations/cloudsign-adapter.js";
import {
  CloudSignApiAdapter, FetchCloudSignApiClient
} from "./integrations/cloudsign-api-adapter.js";
import { createCloudSignRouter } from "./documents/cloudsign-routes.js";
import {
  PgCloudSignRequestRepository,
  type CloudSignRequestRepository
} from "./integrations/cloudsign-request-repository.js";
import {
  LocalGmailInboundAdapter, type GmailInboundAdapter
} from "./integrations/gmail-inbound-adapter.js";
import { GmailInboundApiAdapter } from "./integrations/gmail-inbound-api-adapter.js";
import { createGmailInboundRouter } from "./documents/gmail-inbound-routes.js";
import {
  PgInboundContractRepository,
  type InboundContractRepository
} from "./integrations/inbound-contract-repository.js";
import {
  PgSlackNotificationApprovalRepository,
  type SlackNotificationApprovalRepository
} from "./integrations/slack-approval-repository.js";
import {
  PgSlackNotificationHistoryRepository,
  type SlackNotificationHistoryRepository
} from "./integrations/slack-history-repository.js";
import {
  PgGmailSendHistoryRepository,
  type GmailSendHistoryRepository
} from "./integrations/gmail-send-history-repository.js";
import {
  createApiAuthorization,
  createAuthentication,
  publicUser,
  type AuthSettings
} from "./auth.js";

const sampleDashboard: DashboardSummary = {
  source: "sample",
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
  priorities: [
    {
      id: "LB-2026-0148",
      title: "海外ライセンス契約更新",
      counterparty: "North Star Games",
      owner: "法務 田中",
      stage: "審査",
      dueDate: "2026-07-28",
      status: "要確認"
    },
    {
      id: "LB-2026-0144",
      title: "制作業務委託基本契約",
      counterparty: "青空スタジオ",
      owner: "法務 佐藤",
      stage: "ドラフト",
      dueDate: "2026-07-30",
      status: "作成中"
    }
  ]
};

const sampleSchema: DocumentFormSchema = {
  templateKey: "purchase_order",
  templateVersionId: 1,
  label: "発注書（国内）",
  fields: [
    {
      name: "PROJECT_TITLE",
      label: "件名",
      group: "I. 発注概要",
      required: true,
      dbField: "backlog.summary"
    },
    {
      name: "ORDER_DATE",
      label: "発行日",
      type: "date",
      group: "I. 発注概要",
      required: true,
      dbField: "auto.today"
    },
    {
      name: "VENDOR_NAME",
      label: "発注先名称",
      group: "II. 発注先",
      required: true,
      dbField: "vendor.vendor_name"
    },
    {
      name: "SPECIAL_TERMS",
      label: "特約事項",
      type: "textarea",
      group: "III. 特約・備考"
    }
  ]
};

export interface AppDependencies {
  templates: TemplateRepository;
  drafts: DraftRepository;
  integrations: IntegrationAdapter[];
  backlogClient?: BacklogReadClient;
  backlogWriteClient?: BacklogWriteClient;
  masterData?: MasterDataRepository;
  documentRegistry?: DocumentRegistryRepository;
  documentLookup?: DocumentLookupRepository;
  matters?: MatterRepository;
  matterWrites?: MatterWriteRepository;
  matterIssueWrites?: MatterIssueWriteRepository;
  matterDocumentWrites?: MatterDocumentWriteRepository;
  matterSends?: MatterSendRepository;
  matterDrive?: MatterDriveRepository;
  matterMerge?: MatterMergeRepository;
  matterDelete?: MatterDeleteRepository;
  documentVoid?: DocumentVoidRepository;
  documentReissue?: DocumentReissueRepository;
  excelBatch?: ExcelBatchRepository;
  appSettings?: AppSettingsRepository;
  // APIキー投入画面＋ランタイム秘密情報解決の保存先（Secret Manager）。未設定＝画面は閲覧のみ・env固定。
  secretStore?: SecretStore;
  workflowRules?: WorkflowRulesRepository;
  contractMaster?: ContractMasterRepository;
  contractCheck?: ContractCheckRepository;
  snippets?: SnippetsRepository;
  attachments?: AttachmentsRepository;
  // Phase 9 自動化基盤：ジョブ本体・Webhook ハンドラの注入口（既定は空＝無効）。
  jobRunners?: Record<string, JobRunner>;
  cloudSignWebhookHandler?: WebhookHandler;
  backlogWebhookHandler?: WebhookHandler;
  conditionLines?: ConditionLineRepository;
  pendingInspections?: PendingInspectionRepository;
  vendorWrites?: VendorWriteRepository;
  staff?: StaffRepository;
  documentImports?: DocumentImportRepository;
  workWrites?: WorkWriteRepository;
  worksRead?: WorkReadRepository;
  dataQuality?: DataQualityRepository;
  vendorMerge?: VendorMergeRepository;
  materialWrites?: MaterialWriteRepository;
  rightsSourceWrites?: RightsSourceWriteRepository;
  ledgers?: LedgerRepository;
  search?: GlobalSearchRepository;
  admin?: AdminRepository;
  finalizations?: DocumentFinalizationRepository;
  pdfRenderer?: PdfRenderer;
  driveStorage?: DriveStorage | null;
  slackHistory?: SlackNotificationHistoryRepository;
  slackApprovals?: SlackNotificationApprovalRepository;
  gmailSendHistory?: GmailSendHistoryRepository;
  inboundContracts?: InboundContractRepository;
  cloudSignRequests?: CloudSignRequestRepository;
  matterSlackThreads?: MatterSlackThreadRepository;
  matterMentions?: MatterMentionRepository;
  outboundConditions?: OutboundConditionRepository;
  contractIntakes?: ContractIntakeRepository;
  contractIntakeDocuments?: ContractIntakeDocumentSourceRepository;
  contractOutbound?: ContractOutboundRepository;
  royaltyEvents?: RoyaltyEventRepository;
  receipts?: ReceiptRepository;
  receiptDashboard?: ReceiptDashboardRepository;
  receivableMap?: ReceivableMapRepository;
  paymentReport?: PaymentReportRepository;
}

export interface AppOptions {
  accessMode: "readonly" | "readwrite";
  requireDatabase: boolean;
  writeFeaturesEnabled?: boolean;
  writeScopes?: Set<string>;
  outboundConditionWritesEnabled?: boolean;
  contractIntakeWritesEnabled?: boolean;
  matterWritesEnabled?: boolean;
  vendorWritesEnabled?: boolean;
  staffWritesEnabled?: boolean;
  workWritesEnabled?: boolean;
  royaltyEventWritesEnabled?: boolean;
  receiptWritesEnabled?: boolean;
  paymentLedgerWritesEnabled?: boolean;
  materialWritesEnabled?: boolean;
  rightsSourceWritesEnabled?: boolean;
  vendorMergeEnabled?: boolean;
  matterMergeEnabled?: boolean;
  matterDeleteEnabled?: boolean;
  conditionLineRepairEnabled?: boolean;
  documentVoidEnabled?: boolean;
  documentReissueEnabled?: boolean;
  excelBatchEnabled?: boolean;
  appSettingsWriteEnabled?: boolean;
  workflowRulesWriteEnabled?: boolean;
  contractMasterWriteEnabled?: boolean;
  snippetsWriteEnabled?: boolean;
  attachmentUploadEnabled?: boolean;
  backlogCommentWriteEnabled?: boolean;
  auth?: AuthSettings;
}

function createDefaultDependencies(): AppDependencies {
  const database = getPool();
  const outboundDatabase = getOutboundPool();
  return {
    templates: database
      ? new PgTemplateRepository(database)
      : new MemoryTemplateRepository([sampleSchema]),
    drafts: database
      ? new PgDraftRepository(database)
      : new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    // Backlog クライアントは createApp 側で動的構築（連携設定のランタイム反映）。
    masterData: database
      ? new PgMasterDataRepository(database, new PgAppSettingsRepository(database))
      : new MemoryMasterDataRepository(),
    documentRegistry: database
      ? new PgDocumentRegistryRepository(database)
      : new MemoryDocumentRegistryRepository(),
    matters: database ? new PgMatterRepository(database) : new MemoryMatterRepository(),
    matterWrites: database
      ? new PgMatterWriteRepository(database)
      : new MemoryMatterWriteRepository(),
    matterIssueWrites: database ? new PgMatterIssueWriteRepository(database) : undefined,
    matterDocumentWrites: database ? new PgMatterDocumentWriteRepository(database) : undefined,
    matterSends: database ? new PgMatterSendRepository(database) : undefined,
    matterDrive: database ? new PgMatterDriveRepository(database) : undefined,
    matterMerge: database ? new PgMatterMergeRepository(database) : undefined,
    matterDelete: database ? new PgMatterDeleteRepository(database) : undefined,
    documentVoid: database ? new PgDocumentVoidRepository(database) : undefined,
    documentReissue: database ? new PgDocumentReissueRepository(database) : undefined,
    excelBatch: database ? new PgExcelBatchRepository(database) : undefined,
    appSettings: database ? new PgAppSettingsRepository(database) : undefined,
    // Cloud Run 上（K_SERVICE あり）でのみ Secret Manager に接続。ローカル・テストは未設定。
    secretStore: process.env.K_SERVICE ? new GcpSecretStore() : undefined,
    workflowRules: database ? new PgWorkflowRulesRepository(database) : undefined,
    contractMaster: database ? new PgContractMasterRepository(database) : undefined,
    contractCheck: database ? new PgContractCheckRepository(database) : undefined,
    snippets: database ? new PgSnippetsRepository(database) : undefined,
    attachments: database ? new PgAttachmentsRepository(database) : undefined,
    conditionLines: database
      ? new PgConditionLineRepository(database)
      : new MemoryConditionLineRepository(),
    pendingInspections: database
      ? new PgPendingInspectionRepository(database)
      : new MemoryPendingInspectionRepository(),
    vendorWrites: database
      ? new PgVendorWriteRepository(database)
      : new MemoryVendorWriteRepository(),
    staff: database ? new PgStaffRepository(database) : new MemoryStaffRepository(),
    documentImports: database
      ? new PgDocumentImportRepository(database)
      : new MemoryDocumentImportRepository(),
    workWrites: database
      ? new PgWorkWriteRepository(database)
      : new MemoryWorkWriteRepository(),
    worksRead: database
      ? new PgWorkReadRepository(database)
      : new MemoryWorkReadRepository(),
    dataQuality: database
      ? new PgDataQualityRepository(database)
      : new MemoryDataQualityRepository(),
    vendorMerge: database
      ? new PgVendorMergeRepository(database)
      : new MemoryVendorMergeRepository(),
    materialWrites: database
      ? new PgMaterialWriteRepository(database)
      : new MemoryMaterialWriteRepository(),
    rightsSourceWrites: database
      ? new PgRightsSourceWriteRepository(database)
      : new MemoryRightsSourceWriteRepository(),
    royaltyEvents: database
      ? new PgRoyaltyEventRepository(database)
      : new MemoryRoyaltyEventRepository(),
    receipts: database
      ? new PgReceiptRepository(database)
      : new MemoryReceiptRepository(),
    receiptDashboard: database
      ? new PgReceiptDashboardRepository(database)
      : new MemoryReceiptDashboardRepository(),
    receivableMap: database
      ? new PgReceivableMapRepository(database)
      : new MemoryReceivableMapRepository(),
    paymentReport: database
      ? new PgPaymentReportRepository(database)
      : new MemoryPaymentReportRepository(),
    ledgers: database ? new PgLedgerRepository(database) : new MemoryLedgerRepository(),
    search: database ? new PgGlobalSearchRepository(database) : new MemoryGlobalSearchRepository(),
    admin: database ? new PgAdminRepository(database) : new MemoryAdminRepository(),
    slackHistory: database && config.slackNotificationHistoryEnabled
      ? new PgSlackNotificationHistoryRepository(database)
      : undefined,
    slackApprovals: database && config.slackNotificationApprovalsEnabled
      ? new PgSlackNotificationApprovalRepository(database)
      : undefined,
    gmailSendHistory: database && config.gmailSendHistoryEnabled
      ? new PgGmailSendHistoryRepository(database)
      : undefined,
    inboundContracts: database && config.gmailInboundIntakeEnabled
      ? new PgInboundContractRepository(database)
      : undefined,
    cloudSignRequests: database && config.cloudSignRequestHistoryEnabled
      ? new PgCloudSignRequestRepository(database)
      : undefined,
    matterSlackThreads: database ? new PgMatterSlackThreadRepository(database) : undefined,
    matterMentions: database ? new PgMatterMentionRepository(database) : undefined,
    outboundConditions: outboundDatabase
      ? new PgOutboundConditionRepository(outboundDatabase)
      : undefined,
    contractIntakes: database
      ? new PgContractIntakeRepository(database)
      : undefined,
    contractIntakeDocuments: database
      ? new PgContractIntakeDocumentSourceRepository(database)
      : undefined,
    contractOutbound: database
      ? new PgContractOutboundRepository(database)
      : undefined,
    finalizations: database
      ? new PgDocumentFinalizationRepository(database)
      : new MemoryDocumentFinalizationRepository(),
    pdfRenderer: new ChromiumPdfRenderer(),
    driveStorage: config.googleDriveFolderId
      ? new GoogleDriveStorage(config.googleDriveFolderId, {
          keyFilePath: config.googleServiceAccountKeyPath || undefined,
          environmentTag: config.driveEnvironmentTag
        })
      : null
  };
}

export function createApp(
  dependencies: AppDependencies = createDefaultDependencies(),
  options: AppOptions = {
    accessMode: config.databaseAccessMode,
    requireDatabase: config.requireDatabase,
    writeFeaturesEnabled: config.writeFeaturesEnabled,
    writeScopes: config.writeScopes,
    outboundConditionWritesEnabled: config.outboundConditionWritesEnabled,
    contractIntakeWritesEnabled: config.contractIntakeWritesEnabled,
    matterWritesEnabled: config.matterWritesEnabled,
    vendorWritesEnabled: config.vendorWritesEnabled,
    staffWritesEnabled: config.staffWritesEnabled,
    workWritesEnabled: config.workWritesEnabled,
    materialWritesEnabled: config.materialWritesEnabled,
    rightsSourceWritesEnabled: config.rightsSourceWritesEnabled,
    vendorMergeEnabled: config.vendorMergeEnabled,
    matterMergeEnabled: config.matterMergeEnabled,
    matterDeleteEnabled: config.matterDeleteEnabled,
    conditionLineRepairEnabled: config.conditionLineRepairEnabled,
    documentVoidEnabled: config.documentVoidEnabled,
    documentReissueEnabled: config.documentReissueEnabled,
    excelBatchEnabled: config.excelBatchEnabled,
    appSettingsWriteEnabled: config.appSettingsWriteEnabled,
    workflowRulesWriteEnabled: config.workflowRulesWriteEnabled,
    contractMasterWriteEnabled: config.contractMasterWriteEnabled,
    snippetsWriteEnabled: config.snippetsWriteEnabled,
    attachmentUploadEnabled: config.attachmentUploadEnabled,
    backlogCommentWriteEnabled: config.backlogCommentWriteEnabled,
    royaltyEventWritesEnabled: config.royaltyEventWritesEnabled,
    receiptWritesEnabled: config.receiptWritesEnabled,
    paymentLedgerWritesEnabled: config.paymentLedgerWritesEnabled,
    auth: config.auth
  }
) {
  const app = express();

  // 連携設定のランタイム解決（設定画面の保存を再デプロイなしで反映・TTL 60秒＋保存時即時リフレッシュ）。
  // 初期値は env（index.ts の起動時上書き後）。DB 不通は env のまま。
  const runtimeSettings = new RuntimeIntegrationSettings({
    backlogHost: config.backlogHost,
    backlogProjectKey: config.backlogProjectKey,
    slackLegalConsultChannel: config.slackLegalConsultChannel,
    gmailSenderEmail: config.gmailSenderEmail,
    gmailInboundMailbox: config.gmailInboundMailbox,
    gmailInboundQuery: config.gmailInboundQuery,
    cloudSignAllowedRecipients: config.cloudSignAllowedRecipients
  }, dependencies.appSettings);
  const rt = () => runtimeSettings.current();

  // 秘密情報のランタイム解決（APIキー投入画面の即時反映・TTL 60秒＋保存時即時リフレッシュ）。
  // Secret Manager に値が無い／ストア未設定のキーは env（起動時の値）のまま。
  // 有効/無効ゲートは従来どおり起動時 config（差し替わるのは有効な連携が使う値のみ）。
  const runtimeSecrets = new RuntimeSecrets({
    BACKLOG_API_KEY: config.backlogApiKey,
    SLACK_BOT_TOKEN: config.slackBotToken,
    SLACK_SIGNING_SECRET: config.slackSigningSecret,
    CLOUDSIGN_CLIENT_ID: config.cloudSignClientId,
    CLOUDSIGN_WEBHOOK_TOKEN: config.cloudSignWebhookToken,
    BACKLOG_WEBHOOK_TOKEN: config.backlogWebhookToken,
    JOBS_TRIGGER_TOKEN: config.jobsTriggerToken,
    LB_PORTAL_SECRET: config.lbPortalSecret
  }, dependencies.secretStore);
  const sec = (key: SecretKey) => runtimeSecrets.get(key);

  // Backlog クライアント（動的）。存在条件（＝各機能の有効判定）は起動時 config で固定し、
  // 接続先の値だけをランタイム解決する（apiKey は Secret/env・設定画面では扱わない）。
  const backlogConfigured = Boolean(config.backlogHost && config.backlogProjectKey && config.backlogApiKey);
  const dynamicBacklog = backlogConfigured
    ? new DynamicBacklogClient(
        () => ({ host: rt().backlogHost, projectKey: rt().backlogProjectKey }), () => sec("BACKLOG_API_KEY"))
    : undefined;
  // 課題一覧の読取は readonly でも live でも使う。live を「書けるモード」としか扱わないと、
  // live へ上げた瞬間に依頼画面の課題一覧が黙って空になる。
  const backlogReadClient: BacklogReadClient | undefined =
    dependencies.backlogClient ?? (backlogReadEnabled(config.backlogMode) ? dynamicBacklog : undefined);
  const backlogWriteClient: BacklogWriteClient | undefined =
    dependencies.backlogWriteClient ?? dynamicBacklog;

  const draftWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("drafts") === true;
  const documentFinalizeEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("documents") === true;
  const pdfGenerationEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("pdf") === true;
  const slackApprovalWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("slack-approvals") === true &&
    Boolean(dependencies.slackApprovals);
  const slackCapabilityEnabled =
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("slack") === true;
  const slackDeliveryAdapter: SlackDeliveryAdapter =
    config.slackDeliveryMode === "live" && /^xoxb-[A-Za-z0-9-]+$/.test(config.slackBotToken)
      ? new SlackWebApiDeliveryAdapter(new DynamicSlackWebApiClient(() => sec("SLACK_BOT_TOKEN")))
      : new DisabledSlackDeliveryAdapter();
  // 案件 Slack 会話読取（読取専用・SLACK_CONVERSATION_READ_MODE=live のときだけ実接続）。
  // 送信系とは独立させ、read が落ちても送信・案件詳細に波及させない。
  const slackConversationReader: SlackConversationReader =
    config.slackConversationReadMode === "live" &&
    /^xoxb-[A-Za-z0-9-]+$/.test(config.slackBotToken)
      ? new SlackWebApiConversationReader(
          new DynamicSlackWebApiClient(() => sec("SLACK_BOT_TOKEN")),
          config.slackBotUserId || null)
      : new DisabledSlackConversationReader();
  const slackDispatchEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("slack-dispatch") === true &&
    slackCapabilityEnabled &&
    config.slackDeliveryMode === "live" &&
    slackDeliveryAdapter.configured &&
    Boolean(dependencies.slackHistory) &&
    Boolean(dependencies.slackApprovals);
  // 案件 Slack スレッド（法務相談・チャンネル投稿＋thread_ts＋<@id>メンション）。
  const matterSlackChannelAdapter: MatterSlackChannelAdapter =
    config.slackDeliveryMode === "live" && /^xoxb-[A-Za-z0-9-]+$/.test(config.slackBotToken)
      ? new WebApiMatterSlackChannelAdapter(new DynamicSlackWebApiClient(() => sec("SLACK_BOT_TOKEN")))
      : new LocalMatterSlackChannelAdapter();
  // 通知の宛先チャンネル選択UI用の一覧（conversations.list・要 channels:read）。
  // Slack が live でなければ未提供＝設定画面はチャンネルID直接入力になる。
  const slackChannelDirectory =
    config.slackDeliveryMode === "live" && /^xoxb-[A-Za-z0-9-]+$/.test(config.slackBotToken)
      ? new SlackChannelDirectory(new DynamicSlackWebApiClient(() => sec("SLACK_BOT_TOKEN")))
      : undefined;
  const matterSlackEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("matter-slack") === true &&
    config.matterSlackEnabled &&
    config.integrationMode === "live" &&
    config.slackDeliveryMode === "live" &&
    matterSlackChannelAdapter.configured &&
    Boolean(config.slackLegalConsultChannel);
  const gmailDeliveryAdapter: GmailDeliveryAdapter =
    config.gmailDeliveryMode === "live" && config.gmailSenderEmail
      ? new GmailApiDeliveryAdapter(
          new DynamicGmailApiClient(() => rt().gmailSenderEmail, { keyFilePath: config.gmailServiceAccountKeyPath }))
      : new LocalGmailDeliveryAdapter();
  const gmailDispatchEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("gmail") === true &&
    config.gmailDeliveryMode === "live" &&
    gmailDeliveryAdapter.configured;
  const gmailGateSettings = {
    integrationMode: config.integrationMode,
    gmailCapabilityEnabled: options.writeScopes?.has("gmail") === true,
    adapterConfigured: gmailDeliveryAdapter.configured,
    get senderEmail() { return rt().gmailSenderEmail; }
  };
  const cloudSignAdapter: CloudSignAdapter =
    config.cloudSignMode === "live" && config.cloudSignClientId && config.cloudSignBaseUrl
      ? new CloudSignApiAdapter(new FetchCloudSignApiClient(
          config.cloudSignBaseUrl, () => sec("CLOUDSIGN_CLIENT_ID")))
      : new LocalCloudSignAdapter();
  const cloudSignDispatchEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("cloudsign") === true &&
    config.cloudSignMode === "live" &&
    cloudSignAdapter.configured;
  const cloudSignGateSettings = {
    integrationMode: config.integrationMode,
    cloudSignCapabilityEnabled: options.writeScopes?.has("cloudsign") === true,
    adapterConfigured: cloudSignAdapter.configured
  };
  const gmailInboundAdapter: GmailInboundAdapter =
    config.gmailInboundMode === "live" && config.gmailInboundMailbox
      ? new GmailInboundApiAdapter(
          new DynamicGmailInboundClient(() => rt().gmailInboundMailbox, { keyFilePath: config.gmailServiceAccountKeyPath }))
      : new LocalGmailInboundAdapter();
  const gmailInboundEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("gmail-inbound") === true &&
    config.gmailInboundMode === "live" &&
    gmailInboundAdapter.configured;
  const outboundConditionWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.outboundConditionWritesEnabled === true &&
    options.writeScopes?.has("outbound-conditions") === true &&
    Boolean(dependencies.outboundConditions);
  const contractIntakeWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.contractIntakeWritesEnabled === true &&
    options.writeScopes?.has("contract-intake") === true &&
    Boolean(dependencies.contractIntakes);
  const contractIntakeDocumentBridgeEnabled =
    contractIntakeWriteEnabled &&
    draftWriteEnabled &&
    Boolean(dependencies.contractIntakeDocuments);
  const contractOutboundWriteEnabled =
    contractIntakeWriteEnabled &&
    Boolean(dependencies.contractOutbound);
  const matterWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.matterWritesEnabled === true &&
    options.writeScopes?.has("matters") === true &&
    Boolean(dependencies.matterWrites);
  const vendorWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.vendorWritesEnabled === true &&
    options.writeScopes?.has("vendors") === true &&
    Boolean(dependencies.vendorWrites);
  const staffWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.staffWritesEnabled === true &&
    options.writeScopes?.has("staff") === true &&
    Boolean(dependencies.staff);
  const workWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.workWritesEnabled === true &&
    options.writeScopes?.has("works") === true &&
    Boolean(dependencies.workWrites);
  const materialWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.materialWritesEnabled === true &&
    options.writeScopes?.has("materials") === true &&
    Boolean(dependencies.materialWrites);
  const rightsSourceWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.rightsSourceWritesEnabled === true &&
    options.writeScopes?.has("rights-sources") === true &&
    Boolean(dependencies.rightsSourceWrites);
  const vendorMergeEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.vendorMergeEnabled === true &&
    options.writeScopes?.has("vendor-merge") === true &&
    Boolean(dependencies.vendorMerge);
  const matterMergeEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.matterMergeEnabled === true &&
    options.writeScopes?.has("matter-merge") === true &&
    Boolean(dependencies.matterMerge);
  const matterDeleteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.matterDeleteEnabled === true &&
    options.writeScopes?.has("matter-delete") === true &&
    Boolean(dependencies.matterDelete);
  const conditionLineRepairEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.conditionLineRepairEnabled === true &&
    options.writeScopes?.has("condition-repair") === true &&
    Boolean(dependencies.conditionLines);
  // 案件Slack の書込ガード通過はスコープのみで判定する（Slack ライブ設定の有無は
  // ルート側が 409「Slack連携が有効ではありません」で説明する。ここで matterSlackEnabled を
  // 使うと未設定時に誤解を招く 403 WRITE_SCOPE_DISABLED になる）。
  const matterSlackWriteAllowed =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("matter-slack") === true;
  const documentVoidEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.documentVoidEnabled === true &&
    options.writeScopes?.has("document-void") === true &&
    Boolean(dependencies.documentVoid);
  const documentReissueEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.documentReissueEnabled === true &&
    options.writeScopes?.has("document-reissue") === true &&
    Boolean(dependencies.documentReissue);
  const excelBatchEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.excelBatchEnabled === true &&
    options.writeScopes?.has("excel-batch") === true &&
    Boolean(dependencies.excelBatch);
  const appSettingsWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.appSettingsWriteEnabled === true &&
    options.writeScopes?.has("settings") === true &&
    Boolean(dependencies.appSettings);
  const workflowRulesWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.workflowRulesWriteEnabled === true &&
    options.writeScopes?.has("workflow-rules") === true &&
    Boolean(dependencies.workflowRules);
  const contractMasterWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.contractMasterWriteEnabled === true &&
    options.writeScopes?.has("contract-master") === true &&
    Boolean(dependencies.contractMaster);
  const snippetsWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.snippetsWriteEnabled === true &&
    options.writeScopes?.has("snippets") === true &&
    Boolean(dependencies.snippets);
  const backlogCommentWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.backlogCommentWriteEnabled === true &&
    options.writeScopes?.has("backlog-comment") === true &&
    Boolean(backlogWriteClient);
  // 添付アップロード（Phase 16-4）。DB grant は既存 006 で足りるが、生ファイルの
  // 格納先（Drive ストレージの uploadFile）が使えることが前提。
  const attachmentUploadEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.attachmentUploadEnabled === true &&
    options.writeScopes?.has("attachments") === true &&
    Boolean(dependencies.attachments) &&
    typeof dependencies.driveStorage?.uploadFile === "function";
  const royaltyEventWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.royaltyEventWritesEnabled === true &&
    options.writeScopes?.has("royalty-events") === true &&
    Boolean(dependencies.royaltyEvents);
  const receiptWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.receiptWritesEnabled === true &&
    options.writeScopes?.has("receipts") === true &&
    Boolean(dependencies.receipts);
  const paymentLedgerWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.paymentLedgerWritesEnabled === true &&
    options.writeScopes?.has("payments") === true;
  const driveStorageEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("drive") === true &&
    Boolean(config.googleDriveFolderId || dependencies.driveStorage);
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));
  app.use(createAuthentication(options.auth ?? config.auth));
  app.use(createApiAuthorization());

  app.get("/health", async (_request, response) => {
    const [database, outboundDatabase] = await Promise.all([
      checkDatabase(getPool()),
      checkDatabase(getOutboundPool())
    ]);
    const databaseUnavailable =
      (options.requireDatabase && !database.configured) ||
      (database.configured && !database.reachable);
    const readOnlyMismatch =
      options.accessMode === "readonly" &&
      database.reachable &&
      database.readOnly !== true;
    const writeModeMismatch =
      (draftWriteEnabled || documentFinalizeEnabled || driveStorageEnabled ||
        slackApprovalWriteEnabled || contractIntakeWriteEnabled) &&
      database.reachable && database.readOnly === true;
    const outboundDatabaseMismatch =
      outboundConditionWriteEnabled &&
      (!outboundDatabase.reachable ||
        outboundDatabase.readOnly === true ||
        outboundDatabase.currentDatabase !== "legalbridge");
    const status = databaseUnavailable || readOnlyMismatch || writeModeMismatch || outboundDatabaseMismatch ? 503 : 200;
    response.status(status).json({
      ok: status === 200,
      service: "legalbridge-v2",
      accessMode: options.accessMode,
      writeCapabilities: [
        ...(draftWriteEnabled ? ["drafts"] : []),
        ...(documentFinalizeEnabled ? ["documents"] : []),
        ...(pdfGenerationEnabled ? ["pdf"] : []),
        ...(driveStorageEnabled ? ["drive"] : []),
        ...(slackApprovalWriteEnabled ? ["slack-approvals"] : []),
        ...(outboundConditionWriteEnabled ? ["outbound-conditions"] : []),
        ...(contractIntakeWriteEnabled ? ["contract-intake"] : []),
        ...(matterWriteEnabled ? ["matters"] : []),
        ...(vendorWriteEnabled ? ["vendors"] : []),
        ...(staffWriteEnabled ? ["staff"] : []),
        ...(workWriteEnabled ? ["works"] : []),
        ...(materialWriteEnabled ? ["materials"] : []),
        ...(rightsSourceWriteEnabled ? ["rights-sources"] : []),
        ...(vendorMergeEnabled ? ["vendor-merge"] : []),
        ...(matterMergeEnabled ? ["matter-merge"] : []),
        ...(matterDeleteEnabled ? ["matter-delete"] : []),
        ...(documentVoidEnabled ? ["document-void"] : []),
        ...(documentReissueEnabled ? ["document-reissue"] : []),
        ...(excelBatchEnabled ? ["excel-batch"] : []),
        ...(appSettingsWriteEnabled ? ["settings"] : []),
        ...(workflowRulesWriteEnabled ? ["workflow-rules"] : []),
        ...(contractMasterWriteEnabled ? ["contract-master"] : []),
        ...(snippetsWriteEnabled ? ["snippets"] : []),
        ...(attachmentUploadEnabled ? ["attachments"] : []),
        ...(backlogCommentWriteEnabled ? ["backlog-comment"] : []),
        ...(royaltyEventWriteEnabled ? ["royalty-events"] : []),
        ...(receiptWriteEnabled ? ["receipts"] : []),
        ...(conditionLineRepairEnabled ? ["condition-repair"] : []),
        ...(paymentLedgerWriteEnabled ? ["payments"] : []),
        ...(gmailDispatchEnabled ? ["gmail"] : []),
        ...(cloudSignDispatchEnabled ? ["cloudsign"] : []),
        ...(gmailInboundEnabled ? ["gmail-inbound"] : []),
        ...(slackDispatchEnabled ? ["slack-dispatch"] : [])
      ],
      database,
      outboundDatabase
    });
  });

  app.get("/api/v2/me", (_request, response) => {
    response.json({ user: publicUser(response.locals.currentUser!) });
  });

  app.get("/api/v2/runtime", (_request, response) => {
    response.json({
      service: "legalbridge-v2",
      accessMode: options.accessMode,
      writeFeaturesEnabled:
        draftWriteEnabled || documentFinalizeEnabled || pdfGenerationEnabled ||
        driveStorageEnabled || slackApprovalWriteEnabled ||
        outboundConditionWriteEnabled || contractIntakeWriteEnabled ||
        matterWriteEnabled || vendorWriteEnabled || staffWriteEnabled || workWriteEnabled ||
        materialWriteEnabled || rightsSourceWriteEnabled || vendorMergeEnabled || matterMergeEnabled || matterDeleteEnabled || documentVoidEnabled || documentReissueEnabled || excelBatchEnabled || appSettingsWriteEnabled || workflowRulesWriteEnabled || contractMasterWriteEnabled || snippetsWriteEnabled || attachmentUploadEnabled || backlogCommentWriteEnabled || royaltyEventWriteEnabled || receiptWriteEnabled ||
        conditionLineRepairEnabled ||
        paymentLedgerWriteEnabled || gmailDispatchEnabled || cloudSignDispatchEnabled || gmailInboundEnabled,
      writeCapabilities: [
        ...(draftWriteEnabled ? ["drafts"] : []),
        ...(documentFinalizeEnabled ? ["documents"] : []),
        ...(pdfGenerationEnabled ? ["pdf"] : []),
        ...(driveStorageEnabled ? ["drive"] : []),
        ...(slackApprovalWriteEnabled ? ["slack-approvals"] : []),
        ...(outboundConditionWriteEnabled ? ["outbound-conditions"] : []),
        ...(contractIntakeWriteEnabled ? ["contract-intake"] : []),
        ...(matterWriteEnabled ? ["matters"] : []),
        ...(vendorWriteEnabled ? ["vendors"] : []),
        ...(staffWriteEnabled ? ["staff"] : []),
        ...(workWriteEnabled ? ["works"] : []),
        ...(materialWriteEnabled ? ["materials"] : []),
        ...(rightsSourceWriteEnabled ? ["rights-sources"] : []),
        ...(vendorMergeEnabled ? ["vendor-merge"] : []),
        ...(matterMergeEnabled ? ["matter-merge"] : []),
        ...(matterDeleteEnabled ? ["matter-delete"] : []),
        ...(documentVoidEnabled ? ["document-void"] : []),
        ...(documentReissueEnabled ? ["document-reissue"] : []),
        ...(excelBatchEnabled ? ["excel-batch"] : []),
        ...(appSettingsWriteEnabled ? ["settings"] : []),
        ...(workflowRulesWriteEnabled ? ["workflow-rules"] : []),
        ...(contractMasterWriteEnabled ? ["contract-master"] : []),
        ...(snippetsWriteEnabled ? ["snippets"] : []),
        ...(attachmentUploadEnabled ? ["attachments"] : []),
        ...(backlogCommentWriteEnabled ? ["backlog-comment"] : []),
        ...(royaltyEventWriteEnabled ? ["royalty-events"] : []),
        ...(receiptWriteEnabled ? ["receipts"] : []),
        ...(conditionLineRepairEnabled ? ["condition-repair"] : []),
        ...(paymentLedgerWriteEnabled ? ["payments"] : []),
        ...(gmailDispatchEnabled ? ["gmail"] : []),
        ...(cloudSignDispatchEnabled ? ["cloudsign"] : []),
        ...(gmailInboundEnabled ? ["gmail-inbound"] : []),
        ...(slackDispatchEnabled ? ["slack-dispatch"] : [])
      ],
      integrations: config.integrationMode,
      authMode: (options.auth ?? config.auth).mode,
      slackNotificationHistory: Boolean(dependencies.slackHistory),
      slackNotificationApprovals: Boolean(dependencies.slackApprovals)
    });
  });

  app.get("/api/v2/dashboard", async (_request, response) => {
    // Real cockpit from matter_overview_v (read-only). Fall back to the static
    // sample when no repository/data is available so the UI still renders.
    try {
      // Settlement (消化/検収) is best-effort: it degrades to null when the
      // finance tables are not granted, so a failure here must not drop the
      // matter cockpit.
      const [matters, settlement] = await Promise.all([
        matterRepository.list("", undefined, 500),
        dependencies.conditionLines?.settlement().catch(() => null) ?? Promise.resolve(null)
      ]);
      if (matters.length) {
        return response.json(buildMatterDashboard(matters, new Date(), settlement));
      }
    } catch (error) {
      console.error("dashboard aggregation failed", error);
    }
    return response.json(sampleDashboard);
  });

  app.get("/api/v2/integrations/status", async (_request, response) => {
    const integrations = await Promise.all(
      dependencies.integrations.map(async (adapter) => ({
        name: adapter.name,
        mode: adapter.mode,
        ...(await adapter.check())
      }))
    );
    response.json({ integrations });
  });

  app.use("/api/v2", (request, response, next) => {
    const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
    const safePostPaths = new Set([
      "/documents/validate",
      "/documents/preview",
      "/documents/import/validate",
      "/matters/validate",
      "/vendors/validate",
      "/staff/validate",
      "/works/validate",
      "/work-relations/validate",
      "/materials/validate",
      "/rights-sources/validate",
      "/outbound-conditions/validate",
      "/contract-intakes/validate",
      "/contract-intakes/preflight",
      "/contract-intakes/outbound-conditions/validate",
      // 計算専用（DB書込みなし）のロイヤリティ試算。
      "/royalty/preview"
    ]);
    if (safeMethods.has(request.method)) return next();
    if (request.method === "POST" && safePostPaths.has(request.path)) return next();
    const isDraftWrite =
      (["PUT", "DELETE"].includes(request.method) && /^\/document-drafts\/[^/]+$/.test(request.path)) ||
      (request.method === "POST" && request.path === "/document-drafts/purge");
    if (draftWriteEnabled && isDraftWrite) return next();
    const isDocumentFinalize =
      request.method === "POST" && request.path === "/documents/finalize";
    if (documentFinalizeEnabled && isDocumentFinalize) return next();
    const isDocumentImport =
      request.method === "POST" && request.path === "/documents/import";
    if (documentFinalizeEnabled && isDocumentImport) return next();
    const isDriveStorage =
      request.method === "POST" && /^\/documents\/[^/]+\/drive(\/regenerate)?$/.test(request.path);
    if (driveStorageEnabled && isDriveStorage) return next();
    const isSlackApproval =
      request.method === "POST" &&
      request.path === "/admin/slack-notification-approvals";
    if (slackApprovalWriteEnabled && isSlackApproval) return next();
    const isSlackDispatch =
      request.method === "POST" &&
      (request.path === "/admin/slack-notifications/dispatch" ||
        request.path === "/admin/slack-notifications/test-dispatch");
    if (slackDispatchEnabled && isSlackDispatch) return next();
    const isGmailPreview =
      request.method === "POST" && /^\/documents\/\d+\/gmail-notification\/preview$/.test(request.path);
    if (documentFinalizeEnabled && isGmailPreview) return next();
    const isGmailDispatch =
      request.method === "POST" && /^\/documents\/\d+\/gmail-notification\/dispatch$/.test(request.path);
    if (gmailDispatchEnabled && isGmailDispatch) return next();
    const isCloudSignPreview =
      request.method === "POST" && /^\/documents\/\d+\/cloudsign\/preview$/.test(request.path);
    if (documentFinalizeEnabled && isCloudSignPreview) return next();
    const isCloudSignDispatch =
      request.method === "POST" && /^\/documents\/\d+\/cloudsign\/dispatch$/.test(request.path);
    if (cloudSignDispatchEnabled && isCloudSignDispatch) return next();
    const isOutboundConditionWrite =
      request.method === "POST" && request.path === "/outbound-conditions";
    if (outboundConditionWriteEnabled && isOutboundConditionWrite) return next();
    const isContractIntakeWrite =
      request.method === "POST" && request.path === "/contract-intakes";
    if (contractIntakeWriteEnabled && isContractIntakeWrite) return next();
    const isContractIntakeDocumentDraft =
      request.method === "POST" &&
      /^\/contract-intakes\/\d+\/document-drafts$/.test(request.path);
    if (contractIntakeDocumentBridgeEnabled &&
        isContractIntakeDocumentDraft) return next();
    const isContractOutboundAppend =
      request.method === "POST" &&
      /^\/contract-intakes\/\d+\/outbound-conditions$/.test(request.path);
    if (contractOutboundWriteEnabled &&
        isContractOutboundAppend) return next();
    const isMatterWrite =
      (request.method === "POST" && request.path === "/matters") ||
      (request.method === "PATCH" && /^\/matters\/\d+$/.test(request.path)) ||
      (request.method === "POST" && /^\/matters\/\d+\/tasks$/.test(request.path)) ||
      (request.method === "PATCH" && /^\/matters\/\d+\/tasks\/\d+$/.test(request.path)) ||
      (request.method === "POST" && /^\/matters\/\d+\/issues$/.test(request.path)) ||
      (request.method === "DELETE" && /^\/matters\/\d+\/issues\/[^/]+$/.test(request.path)) ||
      (request.method === "POST" && /^\/matters\/\d+\/documents$/.test(request.path)) ||
      (request.method === "POST" && /^\/matters\/\d+\/documents\/from-drive$/.test(request.path)) ||
      (request.method === "DELETE" && /^\/matters\/\d+\/documents\/\d+$/.test(request.path)) ||
      (request.method === "POST" && /^\/matters\/\d+\/sends$/.test(request.path)) ||
      (request.method === "POST" && /^\/matters\/\d+\/drive-folder$/.test(request.path));
    if (matterWriteEnabled && isMatterWrite) return next();
    const isVendorWrite =
      (request.method === "POST" && (request.path === "/vendors" || request.path === "/vendors/import")) ||
      (request.method === "PATCH" && /^\/vendors\/\d+$/.test(request.path));
    if (vendorWriteEnabled && isVendorWrite) return next();
    const isStaffWrite =
      (request.method === "POST" && (request.path === "/staff" || request.path === "/staff/import")) ||
      (request.method === "PATCH" && /^\/staff\/\d+$/.test(request.path));
    if (staffWriteEnabled && isStaffWrite) return next();
    const isWorkWrite =
      (request.method === "POST" && (request.path === "/works" || request.path === "/works/import" || request.path === "/work-relations")) ||
      (request.method === "PATCH" && /^\/works\/\d+$/.test(request.path));
    if (workWriteEnabled && isWorkWrite) return next();
    const isMaterialWrite =
      (request.method === "POST" && (request.path === "/materials" || request.path === "/materials/import")) ||
      (request.method === "PATCH" && /^\/materials\/\d+$/.test(request.path));
    if (materialWriteEnabled && isMaterialWrite) return next();
    const isRightsSourceWrite =
      (request.method === "POST" && (request.path === "/rights-sources" || request.path === "/rights-sources/import")) ||
      (request.method === "PATCH" && /^\/rights-sources\/\d+$/.test(request.path));
    if (rightsSourceWriteEnabled && isRightsSourceWrite) return next();
    const isVendorMerge = request.method === "POST" && request.path === "/vendor-merge";
    if (vendorMergeEnabled && isVendorMerge) return next();
    const isMatterMerge = request.method === "POST" && request.path === "/matter-merge";
    if (matterMergeEnabled && isMatterMerge) return next();
    const isMatterDelete = request.method === "DELETE" && /^\/matters\/\d+$/.test(request.path);
    const isMatterTaskDelete = request.method === "DELETE" && /^\/matters\/\d+\/tasks\/\d+$/.test(request.path);
    if (matterDeleteEnabled && (isMatterDelete || isMatterTaskDelete)) return next();
    const isDocumentVoid = request.method === "POST" &&
      (/^\/documents\/\d+\/void$/.test(request.path) || request.path === "/documents/void-bulk");
    if (documentVoidEnabled && isDocumentVoid) return next();
    const isDocumentReissue = request.method === "POST" && /^\/documents\/\d+\/reissue$/.test(request.path);
    if (documentReissueEnabled && isDocumentReissue) return next();
    const isExcelBatchMark = request.method === "POST" && request.path === "/documents/excel-batches/mark";
    if (excelBatchEnabled && isExcelBatchMark) return next();
    const isSettingsWrite = request.method === "POST" &&
      (request.path === "/settings" || request.path === "/settings/secrets");
    if (appSettingsWriteEnabled && isSettingsWrite) return next();
    const isWorkflowRulesWrite = request.method === "POST" && request.path === "/workflow-rules";
    if (workflowRulesWriteEnabled && isWorkflowRulesWrite) return next();
    const isContractMasterWrite = request.method === "PATCH" && /^\/contracts\/\d+(\/status)?$/.test(request.path);
    if (contractMasterWriteEnabled && isContractMasterWrite) return next();
    const isSnippetsWrite = request.method === "POST" && /^\/snippets(\/\d+\/deactivate)?$/.test(request.path);
    if (snippetsWriteEnabled && isSnippetsWrite) return next();
    const isAttachmentUpload = request.method === "POST" && /^\/matters\/\d+\/attachments$/.test(request.path);
    if (attachmentUploadEnabled && isAttachmentUpload) return next();
    const isBacklogComment = request.method === "POST" && /^\/backlog\/issues\/[^/]+\/comments$/.test(request.path);
    if (backlogCommentWriteEnabled && isBacklogComment) return next();
    const isRoyaltyEventWrite =
      request.method === "POST" && request.path === "/royalty/events";
    if (royaltyEventWriteEnabled && isRoyaltyEventWrite) return next();
    const isReceiptWrite =
      (request.method === "POST" && request.path === "/condition-receipts") ||
      (request.method === "PUT" && /^\/condition-receipts\/\d+$/.test(request.path));
    if (receiptWriteEnabled && isReceiptWrite) return next();
    const isConditionRepair =
      request.method === "PATCH" && /^\/condition-lines\/\d+\/counterparty$/.test(request.path);
    if (conditionLineRepairEnabled && isConditionRepair) return next();

    // 案件Slack（スレッド作成・投稿・定型文）。許可リスト漏れで一律 403 になっていた（回帰修正）。
    const isMatterSlackWrite = request.method === "POST" &&
      /^\/matters\/\d+\/slack\/(thread|messages|template)$/.test(request.path);
    if (matterSlackWriteAllowed && isMatterSlackWrite) return next();

    return response.status(403).json({
      error: options.accessMode === "readonly"
        ? "read-only environment"
        : "write capability is not enabled for this operation",
      code: options.accessMode === "readonly" ? "READ_ONLY_MODE" : "WRITE_SCOPE_DISABLED"
    });
  });

  app.use("/api/v2", createDocumentRouter(
    dependencies.templates,
    dependencies.drafts,
    draftWriteEnabled
  ));
  // ひな形プレビュー（サンプル値入りのテンプレ出力・読み取り専用・全ロール）。
  app.use("/api/v2", createTemplateSampleRouter(dependencies.templates));
  app.use("/api/v2", createDocumentFinalizationRouter(
    dependencies.templates,
    dependencies.drafts,
    dependencies.finalizations ?? new MemoryDocumentFinalizationRepository()
  ));
  const documentRegistry =
    dependencies.documentRegistry ?? new MemoryDocumentRegistryRepository();
  // 文書ルックアップ（読取・10-6）。/documents/:id より前に評価させるため registry より先にマウント。
  const lookupDatabase = getPool();
  const documentLookup = dependencies.documentLookup
    ?? (lookupDatabase ? new PgDocumentLookupRepository(lookupDatabase) : new MemoryDocumentLookupRepository());
  app.use("/api/v2", createDocumentLookupRouter(documentRegistry, documentLookup));
  // Excel 一括出力（10-5）。/documents/excel-batches は /documents/:id より前に評価させる。
  app.use("/api/v2", createExcelBatchRouter(dependencies.excelBatch, excelBatchEnabled));
  app.use("/api/v2", createDocumentRegistryRouter(documentRegistry));
  const pdfRenderer = dependencies.pdfRenderer ?? new ChromiumPdfRenderer();
  app.use("/api/v2", createDocumentPdfRouter(
    documentRegistry,
    dependencies.templates,
    pdfRenderer,
    pdfGenerationEnabled
  ));
  app.use("/api/v2", createDocumentDriveRouter(
    documentRegistry,
    dependencies.templates,
    pdfRenderer,
    dependencies.driveStorage ?? null,
    driveStorageEnabled
  ));
  const matterRepository = dependencies.matters ?? new MemoryMatterRepository();
  app.use("/api/v2", createMatterRouter(matterRepository));
  // 案件イベント連動の自動 Slack 通知（案件Slack有効時のみ・best-effort）。
  const matterSlackNotifier: MatterSlackNotifier =
    matterSlackEnabled && dependencies.matterSlackThreads && dependencies.matterMentions
      ? new LiveMatterSlackNotifier({
          enabled: true,
          threads: dependencies.matterSlackThreads,
          mentions: dependencies.matterMentions,
          channel: matterSlackChannelAdapter
        })
      : new NoopMatterSlackNotifier();
  app.use("/api/v2", createMatterWriteRouter(
    dependencies.matterWrites,
    matterWriteEnabled,
    matterSlackNotifier,
    dependencies.matterIssueWrites,
    dependencies.matterDocumentWrites
  ));
  app.use("/api/v2", createMatterSendRouter(dependencies.matterSends, matterWriteEnabled));
  // 案件 Drive フォルダ（作成/一覧）。Drive SA を drive-storage と共有。
  const matterDriveFolderService: MatterDriveFolderService =
    config.googleDriveFolderId
      ? new GoogleMatterDriveFolderService({ keyFilePath: config.googleServiceAccountKeyPath || undefined })
      : new LocalMatterDriveFolderService();
  const matterDriveReadEnabled = driveStorageEnabled && matterDriveFolderService.configured;
  app.use("/api/v2", createMatterDriveRouter({
    matters: matterRepository,
    drive: dependencies.matterDrive,
    folders: matterDriveFolderService,
    settings: {
      enabled: matterDriveReadEnabled,
      writeEnabled: matterDriveReadEnabled && matterWriteEnabled,
      parentFolderId: config.googleDriveFolderId
    }
  }));
  // 案件 Slack スレッド（法務相談・メンション・定型文）。
  const drivePermissionGranter: DrivePermissionGranter =
    config.googleDriveFolderId
      ? new GoogleDrivePermissionGranter({ keyFilePath: config.googleServiceAccountKeyPath || undefined })
      : new LocalDrivePermissionGranter();
  app.use("/api/v2", createMatterSlackRouter({
    matters: matterRepository,
    threads: dependencies.matterSlackThreads,
    mentions: dependencies.matterMentions,
    channel: matterSlackChannelAdapter,
    settings: { enabled: matterSlackEnabled, get legalChannelId() { return rt().slackLegalConsultChannel; } },
    granter: drivePermissionGranter
  }));
  app.use("/api/v2", createConditionLineRouter(dependencies.conditionLines, conditionLineRepairEnabled));
  // 計算専用（read-only・DB非依存）のロイヤリティ試算。
  app.use("/api/v2", createRoyaltyRouter());
  // ロイヤリティ消化イベント書込（guarded-write・既定OFF）。
  app.use("/api/v2", createRoyaltyEventRouter(dependencies.royaltyEvents, royaltyEventWriteEnabled));
  // 再許諾料の受領記録 書込（guarded-write・既定OFF）。payments台帳同期は
  // 追加capability（scope 'payments'・grant 016）が有効な時のみ。
  app.use("/api/v2", createReceiptRouter(dependencies.receipts, receiptWriteEnabled, paymentLedgerWriteEnabled));
  // 請求ダッシュボード（読み取り・admin/legal限定）。
  app.use("/api/v2", createReceiptDashboardRouter(dependencies.receiptDashboard));
  // 債権マップ（読み取り・admin/legal限定）。
  app.use("/api/v2", createReceivableMapRouter(dependencies.receivableMap));
  // 支払報告書（読み取り・admin/legal限定）。
  app.use("/api/v2", createPaymentReportRouter(dependencies.paymentReport));
  app.use("/api/v2", createPendingInspectionRouter(dependencies.pendingInspections));
  app.use("/api/v2", createVendorWriteRouter(dependencies.vendorWrites, vendorWriteEnabled));
  app.use("/api/v2", createStaffRouter(dependencies.staff, staffWriteEnabled));
  // 作品集約リード（読み取り・admin/legal限定・Phase 2）。書込みなし。
  app.use("/api/v2", createWorkReadRouter(dependencies.worksRead));
  // データ品質センター（読み取り・admin/legal限定・Phase 4）。書込みなし。
  app.use("/api/v2", createDataQualityRouter(dependencies.dataQuality));
  // Backlog課題一覧（依頼取込・読み取り・admin/legal限定・Phase 3）。書込みなし。
  // 課題本文の Slack メンション（V1 が書いた `依頼者: <@U…>`）は担当者マスタで氏名へ解決する。
  app.use("/api/v2", createBacklogRequestRouter(backlogReadClient, () => rt().backlogHost, dependencies.matterMentions));
  // Backlogコメント書き戻し（guarded・既定OFF・確認トークン・scope 'backlog-comment'）。
  app.use("/api/v2", createBacklogCommentRouter(backlogWriteClient, backlogCommentWriteEnabled));
  app.use("/api/v2", createWorkWriteRouter(dependencies.workWrites, workWriteEnabled));
  app.use("/api/v2", createMaterialWriteRouter(dependencies.materialWrites, materialWriteEnabled));
  // 権利ソース書込（guarded-write・既定OFF・scope 'rights-sources'・grant 017）。
  app.use("/api/v2", createRightsSourceWriteRouter(dependencies.rightsSourceWrites, rightsSourceWriteEnabled));
  // 取引先マージ（名寄せ）。プレビュー読取＋guarded-write実行（既定OFF・grant 018）。
  app.use("/api/v2", createVendorMergeRouter(dependencies.vendorMerge, vendorMergeEnabled));
  // 案件マージ（名寄せ）。プレビュー読取＋guarded-write実行（既定OFF・scope 'matter-merge'・grant 025/026/028/008）。
  app.use("/api/v2", createMatterMergeRouter(dependencies.matterMerge, matterMergeEnabled));
  // 案件・タスク削除（破壊的）。プレビュー読取＋guarded-write実行（既定OFF・scope 'matter-delete'・grant 029）。
  app.use("/api/v2", createMatterDeleteRouter(dependencies.matterDelete, matterDeleteEnabled));
  // 文書 void（破壊的・Phase 10-2）。guarded-write（既定OFF・scope 'document-void'・grant 033）。
  //   Backlog 書き戻しは backlog-comment 有効時のみ（ベストエフォート）。
  const documentVoidNotifier =
    backlogCommentWriteEnabled && backlogWriteClient
      ? (issueKey: string, text: string) =>
          backlogWriteClient.addComment(issueKey, text).then(() => undefined)
      : undefined;
  app.use("/api/v2", createDocumentVoidRouter(dependencies.documentVoid, documentVoidEnabled, documentVoidNotifier));
  // 文書再発行（破壊的・Phase 10-1b）。guarded-write（既定OFF・scope 'document-reissue'・grant 034）。
  //   Backlog 書き戻しは backlog-comment 有効時のみ（旧版の issue_key を registry から解決）。
  app.use("/api/v2", createDocumentReissueRouter(
    dependencies.documentReissue,
    documentReissueEnabled,
    documentVoidNotifier,
    documentVoidNotifier ? async (sourceId) => (await documentRegistry.find(sourceId))?.issueKey ?? null : undefined
  ));
  // システム設定（会社プロファイル・Phase 11-1）。読取 admin・保存 guarded（scope 'settings'・grant 036）。
  app.use("/api/v2", createSettingsRouter(dependencies.appSettings, appSettingsWriteEnabled, {
    // 連携設定タブの実効値表示（ランタイム解決後の現在値・非秘密のみ）。
    get BACKLOG_HOST() { return rt().backlogHost; },
    get BACKLOG_PROJECT_KEY() { return rt().backlogProjectKey; },
    get SLACK_LEGAL_CONSULT_CHANNEL() { return rt().slackLegalConsultChannel; },
    get GMAIL_SENDER() { return rt().gmailSenderEmail; },
    get GMAIL_INBOUND_MAILBOX() { return rt().gmailInboundMailbox; },
    get GMAIL_INBOUND_QUERY() { return rt().gmailInboundQuery; },
    get CLOUDSIGN_ALLOWED_RECIPIENTS() { return rt().cloudSignAllowedRecipients; }
  }, () => runtimeSettings.refresh(), {
    fallbackChannel: () => rt().slackLegalConsultChannel,
    channels: slackChannelDirectory
  }));
  // APIキー投入（Phase 2-5）。読取 admin（登録状況のみ）・保存 guarded（scope 'settings'）。
  // 値は Secret Manager にのみ保存（DB・応答・ログに出さない）。保存成功で runtimeSecrets を即時リフレッシュ。
  app.use("/api/v2", createSecretsRouter(dependencies.secretStore, appSettingsWriteEnabled, () => runtimeSecrets.refresh()));
  // 承認ルート（部門別・Phase 11-2）。読取 admin・保存 guarded（scope 'workflow-rules'・grant 037）。
  app.use("/api/v2", createWorkflowRulesRouter(dependencies.workflowRules, workflowRulesWriteEnabled));
  // 契約マスタ（Phase 11-4）。読取 admin/legal・更新/状態変更 guarded（scope 'contract-master'・grant 038）。
  app.use("/api/v2", createContractMasterRouter(dependencies.contractMaster, contractMasterWriteEnabled));
  // 契約チェック（Phase 16-2・読取専用・全ロール）。用途×スコープ判定＝/法務検索(16-3b)の中核。
  app.use("/api/v2", createContractCheckRouter(dependencies.contractCheck));
  // スニペット（Phase 16-1）。読取 全ロール・保存/無効化 guarded（scope 'snippets'・grant 045）。
  app.use("/api/v2", createSnippetsRouter(dependencies.snippets, snippetsWriteEnabled));

  // 案件への資料アップロード（Phase 16-4・guarded scope 'attachments'・grant は既存 006）。
  // Backlog 課題への気づきコメントは backlog-comment 点火時のみベストエフォート。
  app.use("/api/v2", createAttachmentsRouter({
    repository: dependencies.attachments,
    storage: dependencies.driveStorage ?? null,
    postComment: backlogCommentWriteEnabled && backlogWriteClient
      ? (issueKey, text) =>
          backlogWriteClient.addComment(issueKey, text).then(() => undefined)
      : undefined,
    writeEnabled: attachmentUploadEnabled
  }));

  // 検索ポータル互換の資料アップロード受け口（V1停止・案A）。search-api の
  // DOCUMENT_WORKER_URL をこのサービスへ向けると、ポータルの資料アップロードページが
  // V2 経由で Drive 格納＋ATT 登録される。LB_PORTAL_SECRET 未設定なら 404（fail-closed）。
  app.use(createPortalAttachmentRouter({
    repository: dependencies.attachments,
    resolver: getPool() ? new PgPortalIssueResolver(getPool()!) : undefined,
    storage: dependencies.driveStorage ?? null,
    postComment: backlogCommentWriteEnabled && backlogWriteClient
      ? (issueKey, text) =>
          backlogWriteClient.addComment(issueKey, text).then(() => undefined)
      : undefined,
    writeEnabled: attachmentUploadEnabled,
    portalSecret: () => sec("LB_PORTAL_SECRET")
  }));

  // 内部自動化基盤（Phase 9）。ユーザー認証をバイパスし共有シークレットで保護（既定OFF）。
  //   /internal/jobs/:name … Cloud Scheduler 起動口（runners は 9-1 以降で注入）
  //   /internal/webhooks/{cloudsign,backlog} … 外部 Webhook 受信口（handler は 9-5/9-7 で注入）
  const jobRunners: Record<string, JobRunner> = { ...(dependencies.jobRunners ?? {}) };
  // daily-checks（納期・契約更新通告アラート・9-1b/9-2）。DB があれば登録。
  // 既定は dry-run ノーティファイア（送信せず件数のみ返す・台帳へ記録しない）＝安全。
  // 実送信は後続スライスで live ノーティファイアを注入する。
  const jobsDatabase = getPool();
  if (jobsDatabase && !jobRunners["daily-checks"]) {
    const dailyChecksRepo = new PgDailyChecksRepository(jobsDatabase);
    // Slack が live 設定（配信live＋Botトークン＋法務相談チャンネル）なら実送信、
    // それ以外は dry-run（送信・台帳記録せず件数のみ）＝安全既定。
    const dailyChecksLive =
      config.slackDeliveryMode === "live" &&
      /^xoxb-[A-Za-z0-9-]+$/.test(config.slackBotToken) &&
      Boolean(config.slackLegalConsultChannel);
    // 宛先・ON/OFF は設定画面（通知ごと）から実行時に解決する。未設定は「ON・法務相談チャンネル」＝従来どおり。
    const dailyChecksNotifier = dailyChecksLive
      ? new LiveDailyChecksNotifier(matterSlackChannelAdapter, (id) => runtimeSettings.notification(id))
      : new DryRunDailyChecksNotifier();
    jobRunners["daily-checks"] = () => runDailyChecks({
      repo: dailyChecksRepo,
      notifier: dailyChecksNotifier,
      todayYmd: jstTodayYmd(Date.now()),
      nowMs: Date.now(),
      expiryTransitionEnabled: config.contractExpiryTransitionEnabled
    });
    // 検収待ちダイジェスト（9-4）。Slack live なら投稿、それ以外は dry-run（件数のみ）。
    if (dependencies.pendingInspections && !jobRunners["inspection-digest"]) {
      const inspectionsRepo = dependencies.pendingInspections;
      // 宛先・ON/OFF は実行のたびに解決する。OFF／宛先未設定なら dry-run（件数のみ・投稿しない）。
      jobRunners["inspection-digest"] = () => {
        const setting = runtimeSettings.notification("inspection_digest");
        const post = dailyChecksLive && setting.enabled && setting.channelId
          ? (text: string) => matterSlackChannelAdapter
              .postMessage({ channel: setting.channelId, text })
              .then(() => true).catch(() => false)
          : undefined;
        return runInspectionDigest({ repo: inspectionsRepo, post });
      };
    }
    // CloudSign 一括ステータス同期（9-6）。live 構成かつ送信履歴台帳がある時のみ登録。
    // Webhook(9-5)の取りこぼし・遅延の保険。締結判明時は契約 executed（grant 031 再利用）。
    if (cloudSignAdapter.configured && dependencies.cloudSignRequests && !jobRunners["cloudsign-sync"]) {
      const cloudSignRequests = dependencies.cloudSignRequests;
      const contractWriter = new PgContractStatusWriter(jobsDatabase);
      jobRunners["cloudsign-sync"] = () => runCloudSignSync({
        requests: cloudSignRequests,
        adapter: cloudSignAdapter,
        contract: contractWriter
      });
    }
  }
  app.use(createJobsRouter({ enabled: config.jobsEnabled, token: () => sec("JOBS_TRIGGER_TOKEN"), runners: jobRunners }));
  // 外部 Webhook ハンドラ（9-5 CloudSign / 9-7 Backlog）。DB があり handler 未注入なら既定を構築。
  //   CloudSign 締結→送付履歴 updateStatus＋契約 executed（grant 031 未整備なら forbidden で受信は成功）。
  //   Backlog 課題追加→Slack live 時のみ法務相談チャンネルへ通知。いずれも lb_v2_webhook_receipts でべき等。
  let cloudSignWebhookHandler = dependencies.cloudSignWebhookHandler;
  let backlogWebhookHandler = dependencies.backlogWebhookHandler;
  if (jobsDatabase) {
    const receipts = new PgWebhookReceiptsRepository(jobsDatabase);
    if (!cloudSignWebhookHandler) {
      const requests = dependencies.cloudSignRequests ?? new PgCloudSignRequestRepository(jobsDatabase);
      cloudSignWebhookHandler = createCloudSignWebhookHandler({
        receipts,
        requests,
        contract: new PgContractStatusWriter(jobsDatabase)
      });
    }
    if (!backlogWebhookHandler) {
      const webhookSlackLive =
        config.slackDeliveryMode === "live" &&
        /^xoxb-[A-Za-z0-9-]+$/.test(config.slackBotToken) &&
        Boolean(config.slackLegalConsultChannel);
      const notify = webhookSlackLive
        ? (text: string) => matterSlackChannelAdapter
            .postMessage({ channel: rt().slackLegalConsultChannel, text })
            .then(() => true).catch(() => false)
        : undefined;
      // 9-7 完成形：BACKLOG_INTAKE_ENABLED かつ readwrite のときのみ自動起票／状態同期を注入
      // （legal_requests INSERT=grant 044・issue_workflows UPDATE=grant 046）。
      const backlogIntake =
        config.backlogIntakeEnabled && options.accessMode === "readwrite"
          ? new PgSlackIntakeRepository(jobsDatabase)
          : null;
      backlogWebhookHandler = createBacklogWebhookHandler({
        receipts, notify, intake: backlogIntake,
        log: (message) => console.warn(`[backlog-webhook] ${message}`)
      });
    }
  }
  app.use(createWebhooksRouter({
    cloudsign: { token: () => sec("CLOUDSIGN_WEBHOOK_TOKEN"), handler: cloudSignWebhookHandler },
    backlog: { token: () => sec("BACKLOG_WEBHOOK_TOKEN"), handler: backlogWebhookHandler }
  }));
  // Slack 法務依頼インテーク（Phase 16-3a）。署名検証（fail-closed）で保護・既定 OFF。
  //   有効条件：フラグ＋signing secret＋Bot トークン（views.open 用）＋DB＋readwrite。
  //   Backlog は live 構成のときのみ起票（それ以外は dry-run＝隔離台帳のみ・共有表を触らない）。
  if (
    config.slackIntakeEnabled && config.slackSigningSecret &&
    /^xoxb-[A-Za-z0-9-]+$/.test(config.slackBotToken) &&
    options.accessMode === "readwrite" && jobsDatabase
  ) {
    const intakeBacklog = config.backlogMode === "live" ? dynamicBacklog : undefined;
    const intakeHandler = createSlackIntakeHandler({
      repository: new PgSlackIntakeRepository(jobsDatabase),
      slack: new DynamicSlackWebApiClient(() => sec("SLACK_BOT_TOKEN")),
      backlog: intakeBacklog ?? null,
      get backlogHost() { return rt().backlogHost || null; },
      get backlogProjectKey() { return rt().backlogProjectKey || null; },
      contractCheck: dependencies.contractCheck ?? null,
      uploadPageUrl: config.slackIntakeUploadUrl || null,
      vendorSearchUrl: config.slackIntakeVendorSearchUrl || null,
      log: (message) => console.warn(`[slack-intake] ${message}`)
    });
    app.use(createSlackIntakeRouter({
      signingSecret: () => sec("SLACK_SIGNING_SECRET"),
      onCommand: intakeHandler.handleCommand,
      onInteractivity: intakeHandler.handleInteractivity
    }));
  }
  app.use("/api/v2", createDocumentImportRouter(dependencies.documentImports, documentFinalizeEnabled));
  app.use("/api/v2", createGmailNotificationRouter(
    documentRegistry, gmailDeliveryAdapter, gmailGateSettings,
    dependencies.gmailSendHistory, dependencies.matterSends,
    // PDF添付（V1同等）：CloudSign送信と同じ調達経路（テンプレート描画 or Drive実体）を使う。
    // 文面の会社名・住所は会社プロフィール設定から差し込む（未整備なら既定へ縮退）。
    {
      templates: dependencies.templates, pdfRenderer, driveStorage: dependencies.driveStorage ?? undefined,
      companyProfile: () => loadCompanyProfile(dependencies.appSettings),
      emailSettings: () => loadEmailSettings(dependencies.appSettings)
    }));
  // メール設定（文面テンプレート・既定CC・テスト送信）。保存は app_settings（grant 036）と
  // 同じゲート（SETTINGS_WRITE_ENABLED）。テスト送信は gmail ゲート・admin のみ。
  app.use("/api/v2", createEmailSettingsRouter({
    repository: dependencies.appSettings,
    writeEnabled: appSettingsWriteEnabled,
    gmail: gmailDeliveryAdapter,
    gateSettings: gmailGateSettings,
    companyProfile: () => loadCompanyProfile(dependencies.appSettings)
  }));
  // 送信・署名履歴＋宛先候補（W3）。リロード後も送信済みかどうか文書詳細から確認できる読み口。
  app.use("/api/v2", createSendHistoryRouter(
    dependencies.gmailSendHistory, dependencies.cloudSignRequests,
    getPool() ? new PgRecipientSuggestionSource(getPool()!) : undefined));
  app.use("/api/v2", createCloudSignRouter(
    documentRegistry, dependencies.templates, pdfRenderer, cloudSignAdapter, cloudSignGateSettings,
    {
      allowedRecipients: () => parseAllowedRecipients(rt().cloudSignAllowedRecipients),
      requestHistory: dependencies.cloudSignRequests,
      matterSends: dependencies.matterSends,
      consoleBaseUrl: () => config.cloudSignBaseUrl,
      // 添付（テンプレートを持たない文書）を送るために Drive の実体を読む。
      driveStorage: dependencies.driveStorage ?? undefined
    }));
  app.use("/api/v2", createGmailInboundRouter(gmailInboundAdapter, {
    enabled: gmailInboundEnabled,
    get query() { return rt().gmailInboundQuery; },
    get mailbox() { return rt().gmailInboundMailbox; }
  }, dependencies.inboundContracts));
  app.use("/api/v2", createLedgerRouter(
    dependencies.ledgers ?? new MemoryLedgerRepository()
  ));
  app.use("/api/v2", createOutboundConditionRouter(
    dependencies.outboundConditions,
    outboundConditionWriteEnabled
  ));
  app.use("/api/v2", createContractIntakeRouter(
    dependencies.contractIntakes,
    contractIntakeWriteEnabled
  ));
  app.use("/api/v2", createContractIntakeDocumentRouter(
    dependencies.contractIntakeDocuments,
    dependencies.templates,
    dependencies.drafts,
    contractIntakeDocumentBridgeEnabled,
    dependencies.appSettings
  ));
  app.use("/api/v2", createContractOutboundRouter(
    dependencies.contractOutbound,
    contractOutboundWriteEnabled
  ));
  // 案件の Slack 会話履歴（読取専用・admin/legal・Matter 詳細とは独立）。
  app.use("/api/v2", createMatterSlackHistoryRouter({
    history: dependencies.slackHistory,
    reader: slackConversationReader,
    mentions: dependencies.matterMentions
  }));
  app.use("/api/v2", createGlobalSearchRouter(
    dependencies.search ?? new MemoryGlobalSearchRepository()
  ));
  app.use("/api/v2", createAdminRouter(
    dependencies.admin ?? new MemoryAdminRepository(),
    matterRepository,
    dependencies.slackHistory,
    dependencies.slackApprovals,
    createSlackRecipientDirectory(config.slackDryRunUserMap),
    {
      integrationMode: config.integrationMode,
      slackCapabilityEnabled,
      adapterConfigured: slackDeliveryAdapter.configured
    },
    slackApprovalWriteEnabled,
    { adapter: slackDeliveryAdapter, enabled: slackDispatchEnabled }
  ));
  app.use("/api/v2", createTemplateRegressionRouter(dependencies.templates));
  app.use("/api/v2", createOperationalDiagnosticsRouter(
    getPool(),
    dependencies.templates,
    dependencies.integrations,
    {
      accessMode: options.accessMode,
      requireDatabase: options.requireDatabase,
      writeFeaturesEnabled: options.writeFeaturesEnabled === true,
      writeScopes: options.writeScopes ?? new Set(),
      integrationMode: config.integrationMode,
      driveEnabled: driveStorageEnabled
    }
  ));
  app.use("/api/v2", createMasterDataRouter(
    dependencies.masterData ?? new MemoryMasterDataRepository()
  ));

  app.use((
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(error);
    response.status(500).json({ error: "internal server error" });
  });

  if (process.env.NODE_ENV === "production") {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const clientRoot = path.resolve(here, "../../client");
    app.use(express.static(clientRoot));
    app.get(/.*/, (_request, response) => {
      response.sendFile(path.join(clientRoot, "index.html"));
    });
  }

  return app;
}
