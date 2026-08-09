import { Router } from "express";
import { z } from "zod";
import type { MatterRepository } from "./repository.js";
import type { MatterDriveRepository } from "./matter-drive-repository.js";
import { MatterWriteError } from "./write-repository.js";
import {
  matterFolderName, type MatterDriveFolderService
} from "../documents/drive-folder.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

export interface MatterDriveSettings {
  enabled: boolean;       // Drive フォルダサービス設定済み（読取可）
  writeEnabled: boolean;  // 案件編集権限（フォルダ作成可）
  parentFolderId: string;
}

export interface MatterDriveDeps {
  matters: MatterRepository | undefined;
  drive: MatterDriveRepository | undefined;
  folders: MatterDriveFolderService;
  settings: MatterDriveSettings;
}

export function createMatterDriveRouter(deps: MatterDriveDeps) {
  const router = Router();

  // 案件フォルダの作成/取得（冪等）。案件編集権限＋Drive設定が必要。
  router.post("/matters/:id/drive-folder", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "MATTER_DRIVE_FORBIDDEN" });
      }
      if (!deps.settings.writeEnabled || !deps.settings.enabled || !deps.folders.configured ||
          !deps.matters || !deps.drive || !deps.settings.parentFolderId) {
        return response.status(409).json({ error: "Drive連携が有効ではありません", code: "MATTER_DRIVE_DISABLED" });
      }
      const { id } = idPath.parse(request.params);
      const existing = await deps.drive.getFolder(id);
      if (existing?.folderId) {
        return response.status(200).json({ folder: { id: existing.folderId, url: existing.url }, created: false });
      }
      const detail = await deps.matters.find(id);
      if (!detail) return response.status(404).json({ error: "案件が見つかりません", code: "MATTER_NOT_FOUND" });
      const name = matterFolderName({ matterCode: detail.matter.matterCode, matterId: detail.matter.id, title: detail.matter.title });
      const folder = await deps.folders.ensureFolder({ name, parentFolderId: deps.settings.parentFolderId });
      await deps.drive.setFolder(id, { folderId: folder.id, url: folder.url });
      return response.status(201).json({ folder: { id: folder.id, url: folder.url }, created: true });
    } catch (error) {
      if (error instanceof MatterWriteError) {
        const status = error.code === "MATTER_DRIVE_GRANT_MISSING" ? 503 : error.code === "MATTER_NOT_FOUND" ? 404 : 400;
        return response.status(status).json({ error: error.message, code: error.code });
      }
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 案件フォルダ内のファイル一覧（read）。フォルダ未作成なら folder:null。
  router.get("/matters/:id/drive-files", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが操作できます", code: "MATTER_DRIVE_FORBIDDEN" });
      }
      const { id } = idPath.parse(request.params);
      if (!deps.settings.enabled || !deps.folders.configured || !deps.drive) {
        return response.status(200).json({ enabled: false, folder: null, files: [] });
      }
      const ref = await deps.drive.getFolder(id);
      if (!ref?.folderId) return response.status(200).json({ enabled: true, folder: null, files: [] });
      const files = await deps.folders.listFiles(ref.folderId);
      return response.status(200).json({ enabled: true, folder: { id: ref.folderId, url: ref.url }, files });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
