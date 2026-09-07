import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";

// 案件ごとの Drive フォルダ連携（作成/一覧）。drive-storage.ts と同じ Workspace SA 認証を用い、
// 親フォルダ配下に案件フォルダを作成（同名があれば再利用＝冪等）し、中のファイルを一覧する。

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface MatterFolder { id: string; url: string; }
export interface MatterFolderFile {
  id: string; name: string; link: string; mimeType: string; isFolder: boolean; modifiedTime: string | null;
}

export interface MatterDriveFolderService {
  readonly configured: boolean;
  ensureFolder(input: { name: string; parentFolderId: string }): Promise<MatterFolder>;
  listFiles(folderId: string): Promise<MatterFolderFile[]>;
}

// 案件フォルダ名。Drive のクエリを壊す ' と \ は避ける。
export function matterFolderName(input: { matterCode: string | null; matterId: number; title: string }): string {
  const label = input.matterCode ?? `MTR-${input.matterId}`;
  const title = (input.title ?? "").replace(/[\\']/g, " ").trim();
  return `${label} ${title}`.trim().slice(0, 200);
}

function folderUrl(id: string) { return `https://drive.google.com/drive/folders/${id}`; }

export class LocalMatterDriveFolderService implements MatterDriveFolderService {
  readonly configured = false;
  async ensureFolder(): Promise<MatterFolder> { throw new Error("Drive folder service is not configured"); }
  async listFiles(): Promise<MatterFolderFile[]> { throw new Error("Drive folder service is not configured"); }
}

export class GoogleMatterDriveFolderService implements MatterDriveFolderService {
  readonly configured = true;
  private readonly auth: GoogleAuth;
  constructor(options: { keyFilePath?: string } = {}) {
    const keyFile = options.keyFilePath?.trim();
    const keyFileUsable = Boolean(keyFile && fs.existsSync(keyFile));
    this.auth = new GoogleAuth({ ...(keyFileUsable ? { keyFile } : {}), scopes: [DRIVE_SCOPE] });
  }

  private async token(): Promise<string> {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Google Drive access token could not be obtained");
    return token;
  }

  async ensureFolder(input: { name: string; parentFolderId: string }): Promise<MatterFolder> {
    const token = await this.token();
    const escaped = input.name.replace(/'/g, "\\'");
    // 既存の同名サブフォルダを探す（重複作成を避ける）。
    const q = [
      `name = '${escaped}'`,
      `mimeType = '${FOLDER_MIME}'`,
      `'${input.parentFolderId.replace(/'/g, "\\'")}' in parents`,
      "trashed = false"
    ].join(" and ");
    const searchUrl = new URL("https://www.googleapis.com/drive/v3/files");
    searchUrl.searchParams.set("q", q);
    searchUrl.searchParams.set("fields", "files(id)");
    searchUrl.searchParams.set("pageSize", "1");
    searchUrl.searchParams.set("supportsAllDrives", "true");
    searchUrl.searchParams.set("includeItemsFromAllDrives", "true");
    const searchRes = await this.fetchJson(searchUrl, { headers: { Authorization: `Bearer ${token}` } }, "folder search");
    const existing = (searchRes.files as Array<{ id?: string }> | undefined)?.[0]?.id;
    if (existing) return { id: existing, url: folderUrl(existing) };

    const createUrl = new URL("https://www.googleapis.com/drive/v3/files");
    createUrl.searchParams.set("fields", "id");
    createUrl.searchParams.set("supportsAllDrives", "true");
    const created = await this.fetchJson(createUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, mimeType: FOLDER_MIME, parents: [input.parentFolderId] })
    }, "folder create");
    const id = created.id as string;
    if (!id) throw new Error("Google Drive folder create returned no id");
    return { id, url: folderUrl(id) };
  }

  async listFiles(folderId: string): Promise<MatterFolderFile[]> {
    const token = await this.token();
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`);
    url.searchParams.set("fields", "files(id,name,mimeType,webViewLink,modifiedTime)");
    url.searchParams.set("orderBy", "folder,modifiedTime desc");
    url.searchParams.set("pageSize", "200");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    const body = await this.fetchJson(url, { headers: { Authorization: `Bearer ${token}` } }, "folder list");
    const files = (body.files as Array<Record<string, unknown>> | undefined) ?? [];
    return files.map((f) => ({
      id: String(f.id ?? ""), name: String(f.name ?? ""),
      mimeType: String(f.mimeType ?? ""), isFolder: f.mimeType === FOLDER_MIME,
      link: typeof f.webViewLink === "string" && f.webViewLink ? f.webViewLink : folderUrl(String(f.id ?? "")),
      modifiedTime: typeof f.modifiedTime === "string" ? f.modifiedTime : null
    }));
  }

  private async fetchJson(url: URL, init: RequestInit, op: string): Promise<Record<string, any>> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Google Drive ${op} failed (${response.status}): ${detail}`);
    }
    return await response.json() as Record<string, any>;
  }
}

export class MemoryMatterDriveFolderService implements MatterDriveFolderService {
  readonly configured = true;
  private folders = new Map<string, MatterFolder>();   // name -> folder
  filesByFolder = new Map<string, MatterFolderFile[]>();
  ensureCount = 0;

  async ensureFolder(input: { name: string; parentFolderId: string }) {
    this.ensureCount += 1;
    const existing = this.folders.get(input.name);
    if (existing) return existing;
    const id = `folder-${this.folders.size + 1}`;
    const folder = { id, url: folderUrl(id) };
    this.folders.set(input.name, folder);
    return folder;
  }

  async listFiles(folderId: string) {
    return this.filesByFolder.get(folderId) ?? [];
  }
}
