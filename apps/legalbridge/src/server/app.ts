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
  type IntegrationAdapter
} from "./integrations/index.js";
import {
  BacklogWebApiClient, type BacklogReadClient, type BacklogWriteClient
} from "./integrations/backlog-web-api.js";
import { createBacklogRequestRouter, createBacklogCommentRouter } from "./integrations/backlog-routes.js";

function newBacklogClient(): BacklogWebApiClient | undefined {
  if (!config.backlogHost || !config.backlogProjectKey || !config.backlogApiKey) return undefined;
  try {
    return new BacklogWebApiClient({
      host: config.backlogHost, projectKey: config.backlogProjectKey, apiKey: config.backlogApiKey
    });
  } catch { return undefined; }
}
// BACKLOG_MODE=readonly＋接続情報がある時のみ読取クライアントを構築（依頼取込・Phase 3）。
function defaultBacklogClient(): BacklogReadClient | undefined {
  return config.backlogMode === "readonly" ? newBacklogClient() : undefined;
}
// コメント書き戻し用クライアント（capabilityゲートは app 側・BACKLOG_MODE=live には依存しない）。
function defaultBacklogWriteClient(): BacklogWriteClient | undefined {
  return newBacklogClient();
}
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
import {
  SlackWebApiDeliveryAdapter,
  FetchSlackWebApiClient
} from "./integrations/slack-web-api-adapter.js";
import {
  LocalGmailDeliveryAdapter, type GmailDeliveryAdapter
} from "./integrations/gmail-delivery-adapter.js";
import {
  GmailApiDeliveryAdapter, FetchGmailApiClient
} from "./integrations/gmail-api-adapter.js";
import { createGmailNotificationRouter } from "./documents/gmail-notification-routes.js";
import {
  LocalCloudSignAdapter, type CloudSignAdapter
} from "./integrations/cloudsign-adapter.js";
import {
  CloudSignApiAdapter, FetchCloudSignApiClient
} from "./integrations/cloudsign-api-adapter.js";
import { createCloudSignRouter } from "./documents/cloudsign-routes.js";
import {
  LocalGmailInboundAdapter, type GmailInboundAdapter
} from "./integrations/gmail-inbound-adapter.js";
import { GmailInboundApiAdapter, FetchGmailInboundApiClient } from "./integrations/gmail-inbound-api-adapter.js";
import { createGmailInboundRouter } from "./documents/gmail-inbound-routes.js";
import {
  PgSlackNotificationApprovalRepository,
  type SlackNotificationApprovalRepository
} from "./integrations/slack-approval-repository.js";
import {
  PgSlackNotificationHistoryRepository,
  type SlackNotificationHistoryRepository
} from "./integrations/slack-history-repository.js";
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
  matters?: MatterRepository;
  matterWrites?: MatterWriteRepository;
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
    backlogClient: defaultBacklogClient(),
    backlogWriteClient: defaultBacklogWriteClient(),
    masterData: database
      ? new PgMasterDataRepository(database)
      : new MemoryMasterDataRepository(),
    documentRegistry: database
      ? new PgDocumentRegistryRepository(database)
      : new MemoryDocumentRegistryRepository(),
    matters: database ? new PgMatterRepository(database) : new MemoryMatterRepository(),
    matterWrites: database
      ? new PgMatterWriteRepository(database)
      : new MemoryMatterWriteRepository(),
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
    backlogCommentWriteEnabled: config.backlogCommentWriteEnabled,
    royaltyEventWritesEnabled: config.royaltyEventWritesEnabled,
    receiptWritesEnabled: config.receiptWritesEnabled,
    paymentLedgerWritesEnabled: config.paymentLedgerWritesEnabled,
    auth: config.auth
  }
) {
  const app = express();
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
      ? new SlackWebApiDeliveryAdapter(new FetchSlackWebApiClient(config.slackBotToken))
      : new DisabledSlackDeliveryAdapter();
  const slackDispatchEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.writeScopes?.has("slack-dispatch") === true &&
    slackCapabilityEnabled &&
    config.slackDeliveryMode === "live" &&
    slackDeliveryAdapter.configured &&
    Boolean(dependencies.slackHistory) &&
    Boolean(dependencies.slackApprovals);
  const gmailDeliveryAdapter: GmailDeliveryAdapter =
    config.gmailDeliveryMode === "live" && config.gmailSenderEmail
      ? new GmailApiDeliveryAdapter(
          new FetchGmailApiClient(config.gmailSenderEmail, { keyFilePath: config.gmailServiceAccountKeyPath }))
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
    senderEmail: config.gmailSenderEmail
  };
  const cloudSignAdapter: CloudSignAdapter =
    config.cloudSignMode === "live" && config.cloudSignClientId && config.cloudSignBaseUrl
      ? new CloudSignApiAdapter(new FetchCloudSignApiClient(config.cloudSignBaseUrl, config.cloudSignClientId))
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
          new FetchGmailInboundApiClient(config.gmailInboundMailbox, { keyFilePath: config.gmailServiceAccountKeyPath }))
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
  const backlogCommentWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.backlogCommentWriteEnabled === true &&
    options.writeScopes?.has("backlog-comment") === true &&
    Boolean(dependencies.backlogWriteClient);
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
        ...(backlogCommentWriteEnabled ? ["backlog-comment"] : []),
        ...(royaltyEventWriteEnabled ? ["royalty-events"] : []),
        ...(receiptWriteEnabled ? ["receipts"] : []),
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
        materialWriteEnabled || rightsSourceWriteEnabled || vendorMergeEnabled || backlogCommentWriteEnabled || royaltyEventWriteEnabled || receiptWriteEnabled ||
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
        ...(backlogCommentWriteEnabled ? ["backlog-comment"] : []),
        ...(royaltyEventWriteEnabled ? ["royalty-events"] : []),
        ...(receiptWriteEnabled ? ["receipts"] : []),
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
      request.method === "POST" && /^\/documents\/[^/]+\/drive$/.test(request.path);
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
      (request.method === "PATCH" && /^\/matters\/\d+\/tasks\/\d+$/.test(request.path));
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
    const isBacklogComment = request.method === "POST" && /^\/backlog\/issues\/[^/]+\/comments$/.test(request.path);
    if (backlogCommentWriteEnabled && isBacklogComment) return next();
    const isRoyaltyEventWrite =
      request.method === "POST" && request.path === "/royalty/events";
    if (royaltyEventWriteEnabled && isRoyaltyEventWrite) return next();
    const isReceiptWrite =
      (request.method === "POST" && request.path === "/condition-receipts") ||
      (request.method === "PUT" && /^\/condition-receipts\/\d+$/.test(request.path));
    if (receiptWriteEnabled && isReceiptWrite) return next();

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
  app.use("/api/v2", createDocumentFinalizationRouter(
    dependencies.templates,
    dependencies.drafts,
    dependencies.finalizations ?? new MemoryDocumentFinalizationRepository()
  ));
  const documentRegistry =
    dependencies.documentRegistry ?? new MemoryDocumentRegistryRepository();
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
  app.use("/api/v2", createMatterWriteRouter(
    dependencies.matterWrites,
    matterWriteEnabled
  ));
  app.use("/api/v2", createConditionLineRouter(dependencies.conditionLines));
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
  app.use("/api/v2", createBacklogRequestRouter(dependencies.backlogClient));
  // Backlogコメント書き戻し（guarded・既定OFF・確認トークン・scope 'backlog-comment'）。
  app.use("/api/v2", createBacklogCommentRouter(dependencies.backlogWriteClient, backlogCommentWriteEnabled));
  app.use("/api/v2", createWorkWriteRouter(dependencies.workWrites, workWriteEnabled));
  app.use("/api/v2", createMaterialWriteRouter(dependencies.materialWrites, materialWriteEnabled));
  // 権利ソース書込（guarded-write・既定OFF・scope 'rights-sources'・grant 017）。
  app.use("/api/v2", createRightsSourceWriteRouter(dependencies.rightsSourceWrites, rightsSourceWriteEnabled));
  // 取引先マージ（名寄せ）。プレビュー読取＋guarded-write実行（既定OFF・grant 018）。
  app.use("/api/v2", createVendorMergeRouter(dependencies.vendorMerge, vendorMergeEnabled));
  app.use("/api/v2", createDocumentImportRouter(dependencies.documentImports, documentFinalizeEnabled));
  app.use("/api/v2", createGmailNotificationRouter(documentRegistry, gmailDeliveryAdapter, gmailGateSettings));
  app.use("/api/v2", createCloudSignRouter(
    documentRegistry, dependencies.templates, pdfRenderer, cloudSignAdapter, cloudSignGateSettings));
  app.use("/api/v2", createGmailInboundRouter(gmailInboundAdapter, {
    enabled: gmailInboundEnabled, query: config.gmailInboundQuery, mailbox: config.gmailInboundMailbox
  }));
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
    contractIntakeDocumentBridgeEnabled
  ));
  app.use("/api/v2", createContractOutboundRouter(
    dependencies.contractOutbound,
    contractOutboundWriteEnabled
  ));
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
