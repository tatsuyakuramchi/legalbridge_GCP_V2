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
import { config } from "./config.js";
import {
  MemoryMasterDataRepository,
  PgMasterDataRepository,
  type MasterDataRepository
} from "./master-data/repository.js";
import { createMasterDataRouter } from "./master-data/routes.js";
import { MemoryMatterRepository, PgMatterRepository, type MatterRepository } from "./matters/repository.js";
import { createMatterRouter } from "./matters/routes.js";
import { MemoryLedgerRepository, PgLedgerRepository, type LedgerRepository } from "./ledgers/repository.js";
import { createLedgerRouter } from "./ledgers/routes.js";
import { createOutboundConditionRouter } from "./ledgers/outbound-conditions.js";
import { createContractIntakeRouter } from "./contracts/intake.js";
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

const dashboard: DashboardSummary = {
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
  masterData?: MasterDataRepository;
  documentRegistry?: DocumentRegistryRepository;
  matters?: MatterRepository;
  ledgers?: LedgerRepository;
  search?: GlobalSearchRepository;
  admin?: AdminRepository;
  finalizations?: DocumentFinalizationRepository;
  pdfRenderer?: PdfRenderer;
  driveStorage?: DriveStorage | null;
  slackHistory?: SlackNotificationHistoryRepository;
  slackApprovals?: SlackNotificationApprovalRepository;
  outboundConditions?: OutboundConditionRepository;
}

export interface AppOptions {
  accessMode: "readonly" | "readwrite";
  requireDatabase: boolean;
  writeFeaturesEnabled?: boolean;
  writeScopes?: Set<string>;
  outboundConditionWritesEnabled?: boolean;
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
    masterData: database
      ? new PgMasterDataRepository(database)
      : new MemoryMasterDataRepository(),
    documentRegistry: database
      ? new PgDocumentRegistryRepository(database)
      : new MemoryDocumentRegistryRepository(),
    matters: database ? new PgMatterRepository(database) : new MemoryMatterRepository(),
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
    finalizations: database
      ? new PgDocumentFinalizationRepository(database)
      : new MemoryDocumentFinalizationRepository(),
    pdfRenderer: new ChromiumPdfRenderer(),
    driveStorage: config.googleDriveFolderId
      ? new GoogleDriveStorage(config.googleDriveFolderId)
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
  const outboundConditionWriteEnabled =
    options.accessMode === "readwrite" &&
    options.writeFeaturesEnabled === true &&
    options.outboundConditionWritesEnabled === true &&
    options.writeScopes?.has("outbound-conditions") === true &&
    Boolean(dependencies.outboundConditions);
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
      (draftWriteEnabled || documentFinalizeEnabled || driveStorageEnabled || slackApprovalWriteEnabled) &&
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
        ...(outboundConditionWriteEnabled ? ["outbound-conditions"] : [])
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
        draftWriteEnabled || documentFinalizeEnabled || pdfGenerationEnabled || driveStorageEnabled || slackApprovalWriteEnabled || outboundConditionWriteEnabled,
      writeCapabilities: [
        ...(draftWriteEnabled ? ["drafts"] : []),
        ...(documentFinalizeEnabled ? ["documents"] : []),
        ...(pdfGenerationEnabled ? ["pdf"] : []),
        ...(driveStorageEnabled ? ["drive"] : []),
        ...(slackApprovalWriteEnabled ? ["slack-approvals"] : []),
        ...(outboundConditionWriteEnabled ? ["outbound-conditions"] : [])
      ],
      integrations: config.integrationMode,
      authMode: (options.auth ?? config.auth).mode,
      slackNotificationHistory: Boolean(dependencies.slackHistory),
      slackNotificationApprovals: Boolean(dependencies.slackApprovals)
    });
  });

  app.get("/api/v2/dashboard", (_request, response) => {
    response.json(dashboard);
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
      "/outbound-conditions/validate",
      "/contract-intakes/validate"
    ]);
    if (safeMethods.has(request.method)) return next();
    if (request.method === "POST" && safePostPaths.has(request.path)) return next();
    const isDraftWrite =
      ["PUT", "DELETE"].includes(request.method) &&
      /^\/document-drafts\/[^/]+$/.test(request.path);
    if (draftWriteEnabled && isDraftWrite) return next();
    const isDocumentFinalize =
      request.method === "POST" && request.path === "/documents/finalize";
    if (documentFinalizeEnabled && isDocumentFinalize) return next();
    const isDriveStorage =
      request.method === "POST" && /^\/documents\/[^/]+\/drive$/.test(request.path);
    if (driveStorageEnabled && isDriveStorage) return next();
    const isSlackApproval =
      request.method === "POST" &&
      request.path === "/admin/slack-notification-approvals";
    if (slackApprovalWriteEnabled && isSlackApproval) return next();
    const isOutboundConditionWrite =
      request.method === "POST" && request.path === "/outbound-conditions";
    if (outboundConditionWriteEnabled && isOutboundConditionWrite) return next();

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
  app.use("/api/v2", createLedgerRouter(
    dependencies.ledgers ?? new MemoryLedgerRepository()
  ));
  app.use("/api/v2", createOutboundConditionRouter(
    dependencies.outboundConditions,
    outboundConditionWriteEnabled
  ));
  app.use("/api/v2", createContractIntakeRouter());
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
      slackCapabilityEnabled:
        options.writeFeaturesEnabled === true &&
        options.writeScopes?.has("slack") === true,
      adapterConfigured: false
    },
    slackApprovalWriteEnabled
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
