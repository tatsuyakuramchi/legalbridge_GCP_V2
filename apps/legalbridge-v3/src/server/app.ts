import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { authenticate } from "./auth.js";
import { checkDatabase, getPool } from "./db/pool.js";
import type { Transactable } from "./core/db.js";
import { createRoutes, errorHandler } from "./routes.js";

export function createApp(database: Transactable | null = getPool() as Transactable | null) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", async (_request, response) => {
    response.json({
      status: "ok",
      service: "legalbridge-v3",
      readOnly: config.readOnly,
      database: await checkDatabase(database as never)
    });
  });

  app.use(authenticate);

  app.get("/api/v3/me", (_request, response) => {
    response.json({ user: response.locals.currentUser, readOnly: config.readOnly });
  });

  if (database) {
    app.use("/api/v3", createRoutes(database));
  } else {
    app.use("/api/v3", (_request, response) => {
      response.status(503).json({ error: "データベースが設定されていません", code: "DB_UNCONFIGURED" });
    });
  }

  // 本番はビルド済みUIを同じサービスから配る（V2 と同じ構成）。
  const clientDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../client");
  app.use(express.static(clientDir));
  app.get(/^(?!\/api|\/health).*/, (_request, response) => {
    response.sendFile(path.join(clientDir, "index.html"), (error) => {
      if (error) response.status(404).json({ error: "not found" });
    });
  });

  app.use(errorHandler);
  return app;
}
