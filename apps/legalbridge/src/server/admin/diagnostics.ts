import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { Router } from "express";
import type { DatabasePool } from "../db/pool.js";
import { checkDatabase } from "../db/pool.js";
import type { TemplateRepository } from "../documents/template-repository.js";
import { runTemplateRegression } from "../documents/template-regression.js";
import type { IntegrationAdapter } from "../integrations/index.js";

type DiagnosticStatus = "ok" | "warning" | "error" | "disabled";

export interface OperationalDiagnosticsOptions {
  accessMode: "readonly" | "readwrite";
  requireDatabase: boolean;
  writeFeaturesEnabled: boolean;
  writeScopes: Set<string>;
  integrationMode: "local" | "live";
  driveEnabled: boolean;
}

export function createOperationalDiagnosticsRouter(
  database: DatabasePool | null,
  templates: TemplateRepository,
  integrations: IntegrationAdapter[],
  options: OperationalDiagnosticsOptions
) {
  const router = Router();

  router.get("/admin/diagnostics", async (_request, response, next) => {
    try {
      const [databaseState, templateState, integrationState, pdfRuntime] = await Promise.all([
        checkDatabase(database),
        runTemplateRegression(templates),
        Promise.all(integrations.map(async (adapter) => ({
          name: adapter.name,
          mode: adapter.mode,
          ...(await adapter.check())
        }))),
        inspectPdfRuntime(options.writeScopes.has("pdf"))
      ]);

      const databaseModeMatches =
        !databaseState.reachable ||
        (options.accessMode === "readonly"
          ? databaseState.readOnly === true
          : databaseState.readOnly === false);
      const checks = {
        database: {
          status: databaseState.reachable
            ? databaseModeMatches ? "ok" : "error"
            : options.requireDatabase ? "error" : "warning",
          configured: databaseState.configured,
          reachable: databaseState.reachable,
          currentDatabase: databaseState.currentDatabase,
          expectedMode: options.accessMode,
          actualMode: databaseState.readOnly === null
            ? "unknown"
            : databaseState.readOnly ? "readonly" : "readwrite",
          modeMatches: databaseModeMatches
        },
        templates: {
          status: templateState.summary.failed > 0
            ? "error"
            : templateState.summary.warnings > 0 ? "warning" : "ok",
          ...templateState.summary
        },
        pdfRuntime,
        integrations: {
          status: options.integrationMode === "local" &&
            integrationState.every((item) => item.mode === "local" && item.ok)
            ? "ok"
            : integrationState.every((item) => item.ok) ? "warning" : "error",
          externalWritesDisabled: options.integrationMode === "local",
          adapters: integrationState
        },
        writeSafety: {
          status: options.integrationMode === "local" && !options.driveEnabled
            ? "ok"
            : "warning",
          writeFeaturesEnabled: options.writeFeaturesEnabled,
          scopes: [...options.writeScopes].sort(),
          driveEnabled: options.driveEnabled,
          externalWritesDisabled: options.integrationMode === "local"
        }
      } satisfies Record<string, { status: DiagnosticStatus }>;

      const statuses = Object.values(checks).map((check) => check.status);
      const status: Exclude<DiagnosticStatus, "disabled"> = statuses.includes("error")
        ? "error"
        : statuses.includes("warning") ? "warning" : "ok";

      response.json({
        generatedAt: new Date().toISOString(),
        status,
        checks
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function inspectPdfRuntime(enabled: boolean) {
  if (!enabled) {
    return {
      status: "disabled" as const,
      enabled: false,
      executableAvailable: null
    };
  }
  const executable = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser";
  try {
    await access(executable, constants.X_OK);
    return {
      status: "ok" as const,
      enabled: true,
      executableAvailable: true
    };
  } catch {
    return {
      status: "error" as const,
      enabled: true,
      executableAvailable: false
    };
  }
}
