import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterDriveRouter, type MatterDriveSettings } from "./matter-drive-routes.js";
import { MemoryMatterRepository, type MatterDetail } from "./repository.js";
import { MemoryMatterDriveRepository } from "./matter-drive-repository.js";
import {
  MemoryMatterDriveFolderService, matterFolderName, type MatterFolderFile
} from "../documents/drive-folder.js";

const detail: MatterDetail = {
  matter: {
    id: 5, matterCode: "MTR-2026-00005", title: "ライセンス契約", status: "in_progress",
    counterparty: "株式会社甲", primaryIssueKey: "LB-5", lifecycleStage: "drafting",
    ownerName: null, targetDueDate: null, blockedReason: null, issueCount: 0, documentCount: 0,
    openTaskCount: 0, nextTaskTitle: null, nextTaskDueAt: null, updatedAt: "2026-08-08T00:00:00.000Z",
    remarks: null, driveFolderUrl: null
  },
  issues: [], tasks: [], documents: []
};

function appFor(options: {
  role?: "admin" | "legal" | "requester"; enabled?: boolean; writeEnabled?: boolean;
  drive?: MemoryMatterDriveRepository; folders?: MemoryMatterDriveFolderService;
}) {
  const drive = options.drive ?? new MemoryMatterDriveRepository();
  const folders = options.folders ?? new MemoryMatterDriveFolderService();
  const settings: MatterDriveSettings = {
    enabled: options.enabled ?? true, writeEnabled: options.writeEnabled ?? true, parentFolderId: "PARENT1"
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createMatterDriveRouter({ matters: new MemoryMatterRepository([detail]), drive, folders, settings }));
  return { app, drive, folders };
}

test("matterFolderName は matter_code＋title、code無しは MTR-id", () => {
  assert.equal(matterFolderName({ matterCode: "MTR-2026-00005", matterId: 5, title: "契約" }), "MTR-2026-00005 契約");
  assert.equal(matterFolderName({ matterCode: null, matterId: 5, title: "契約" }), "MTR-5 契約");
});

test("フォルダ作成→保存し、再実行は冪等(created:false・再作成なし)", async () => {
  const { app, drive, folders } = appFor({});
  const first = await request(app).post("/api/v2/matters/5/drive-folder").send({});
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.match(first.body.folder.url, /drive\.google\.com\/drive\/folders\//);
  assert.equal((await drive.getFolder(5))?.folderId, first.body.folder.id);
  const second = await request(app).post("/api/v2/matters/5/drive-folder").send({});
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(folders.ensureCount, 1); // 2回目は Drive を叩かない
});

test("フォルダ一覧: 作成後はファイルを返す（未作成は folder:null）", async () => {
  const drive = new MemoryMatterDriveRepository();
  const folders = new MemoryMatterDriveFolderService();
  const { app } = appFor({ drive, folders });
  const none = await request(app).get("/api/v2/matters/5/drive-files");
  assert.equal(none.body.folder, null);
  await request(app).post("/api/v2/matters/5/drive-folder").send({});
  const folderId = (await drive.getFolder(5))!.folderId!;
  const files: MatterFolderFile[] = [{ id: "f1", name: "契約書.pdf", link: "https://drive/f1", mimeType: "application/pdf", isFolder: false, modifiedTime: null }];
  folders.filesByFolder.set(folderId, files);
  const res = await request(app).get("/api/v2/matters/5/drive-files");
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.files[0].name, "契約書.pdf");
});

test("Drive無効時: 作成は409、一覧は enabled=false", async () => {
  const create = await request(appFor({ enabled: false }).app).post("/api/v2/matters/5/drive-folder").send({});
  assert.equal(create.status, 409);
  assert.equal(create.body.code, "MATTER_DRIVE_DISABLED");
  const list = await request(appFor({ enabled: false }).app).get("/api/v2/matters/5/drive-files");
  assert.equal(list.body.enabled, false);
});

test("案件編集権限が無い（writeEnabled=false）と作成は409", async () => {
  const res = await request(appFor({ writeEnabled: false }).app).post("/api/v2/matters/5/drive-folder").send({});
  assert.equal(res.status, 409);
});

test("依頼者ロールは操作できない", async () => {
  const res = await request(appFor({ role: "requester" }).app).get("/api/v2/matters/5/drive-files");
  assert.equal(res.status, 403);
});
