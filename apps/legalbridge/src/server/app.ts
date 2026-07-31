import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardSummary, DocumentFormSchema } from "../types.js";
import { checkDatabase, getPool } from "./db/pool.js";
import {
  MemoryDraftRepository,
  PgDraftRepository,
  type DraftRepository
} from "./documents/draft-repository.js";
import { createDocumentRouter } from "./documents/routes.js";
import {
  MemoryDocumentRegistryRepository,
  PgDocumentRegistryRepository,
  type DocumentRegistryRepository
} from "./documents/registry-repository.js";
import { createDocumentRegistryRouter } from "./documents/registry-routes.js";
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
}

export interface AppOptions {
  accessMode: "readonly" | "readwrite";
  requireDatabase: boolean;
}

function createDefaultDependencies(): AppDependencies {
  const database = getPool();
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
    ledgers: database ? new PgLedgerRepository(database) : new MemoryLedgerRepository()
  };
}

export function createApp(
  dependencies: AppDependencies = createDefaultDependencies(),
  options: AppOptions = {
    accessMode: config.databaseAccessMode,
    requireDatabase: config.requireDatabase
  }
) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", async (_request, response) => {
    const database = await checkDatabase(getPool());
    const databaseUnavailable =
      (options.requireDatabase && !database.configured) ||
      (database.configured && !database.reachable);
    const readOnlyMismatch =
      options.accessMode === "readonly" &&
      database.reachable &&
      database.readOnly !== true;
    const status = databaseUnavailable || readOnlyMismatch ? 503 : 200;
    response.status(status).json({
      ok: status === 200,
      service: "legalbridge-v2",
      accessMode: options.accessMode,
      database
    });
  });

  app.get("/api/v2/runtime", (_request, response) => {
    response.json({
      service: "legalbridge-v2",
      accessMode: options.accessMode,
      integrations: config.integrationMode
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
    if (options.accessMode !== "readonly") return next();

    const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
    const safePostPaths = new Set([
      "/documents/validate",
      "/documents/preview"
    ]);
    if (safeMethods.has(request.method)) return next();
    if (request.method === "POST" && safePostPaths.has(request.path)) return next();

    return response.status(403).json({
      error: "read-only environment",
      code: "READ_ONLY_MODE"
    });
  });

  app.use("/api/v2", createDocumentRouter(dependencies.templates, dependencies.drafts));
  app.use("/api/v2", createDocumentRegistryRouter(
    dependencies.documentRegistry ?? new MemoryDocumentRegistryRepository()
  ));
  app.use("/api/v2", createMatterRouter(
    dependencies.matters ?? new MemoryMatterRepository()
  ));
  app.use("/api/v2", createLedgerRouter(
    dependencies.ledgers ?? new MemoryLedgerRepository()
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
