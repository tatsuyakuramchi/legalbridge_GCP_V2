import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";

export interface StoredDriveFile {
  id: string;
  webViewLink: string;
}

export interface DriveStorage {
  findByDocumentId(documentId: number): Promise<StoredDriveFile | null>;
  uploadPdf(input: {
    documentId: number;
    filename: string;
    pdf: Buffer;
  }): Promise<StoredDriveFile>;
}

// フル drive スコープ。drive.file だと「人が作成して共有しただけの
// 既存フォルダ」を parents に指定できず 404 になる（V1で確認済み）。
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export interface GoogleDriveStorageOptions {
  keyFilePath?: string;
  environmentTag?: string;
}

export class GoogleDriveStorage implements DriveStorage {
  private readonly auth: GoogleAuth;
  private readonly environmentTag: string;

  constructor(
    private readonly folderId: string,
    options: GoogleDriveStorageOptions = {}
  ) {
    if (!folderId.trim()) throw new Error("GOOGLE_DRIVE_FOLDER_ID is required");
    this.environmentTag = options.environmentTag?.trim() || "validation";

    // V1と同じ認証優先順位:
    //   1. GOOGLE_SERVICE_ACCOUNT_KEY_PATH（実在する鍵ファイル）—
    //      Secret Managerからマウントした専用Workspace SA。ランタイムSAが
    //      Drive未許可のときの本命。フル drive スコープでトークンを発行。
    //   2/3. ADC / メタデータ（ランタイムSA）へフォールバック。
    // 鍵ファイルのパスが設定されていても実在しなければ、googleapisが
    // ENOENTを投げて本当の失敗を隠すため、存在確認してからkeyFileを渡す。
    const keyFile = options.keyFilePath?.trim();
    const keyFileUsable = Boolean(keyFile && fs.existsSync(keyFile));
    if (keyFile && !keyFileUsable) {
      console.warn(
        `[GoogleDriveStorage] GOOGLE_SERVICE_ACCOUNT_KEY_PATH=${keyFile} ` +
          "is set but the file is missing on disk. Falling back to ADC."
      );
    }
    this.auth = new GoogleAuth({
      ...(keyFileUsable ? { keyFile } : {}),
      scopes: [DRIVE_SCOPE]
    });
  }

  async findByDocumentId(documentId: number) {
    const token = await this.accessToken();
    const q = [
      `'${escapeQuery(this.folderId)}' in parents`,
      "trashed = false",
      `appProperties has { key='legalbridgeDocumentId' and value='${documentId}' }`
    ].join(" and ");
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "files(id,webViewLink)");
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw await driveError("search", response);
    const body = await response.json() as { files?: StoredDriveFile[] };
    const file = body.files?.[0];
    if (!file) return null;
    return { id: file.id, webViewLink: driveViewLink(file.id, file.webViewLink) };
  }

  async uploadPdf(input: { documentId: number; filename: string; pdf: Buffer }) {
    const token = await this.accessToken();
    const boundary = `legalbridge-${crypto.randomUUID()}`;
    const metadata = {
      name: input.filename,
      mimeType: "application/pdf",
      parents: [this.folderId],
      appProperties: {
        legalbridgeDocumentId: String(input.documentId),
        legalbridgeEnvironment: this.environmentTag
      }
    };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      input.pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "id,webViewLink");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length)
      },
      body
    });
    if (!response.ok) throw await driveError("upload", response);
    const file = await response.json() as StoredDriveFile;
    // 共有ドライブ内のバイナリ + SAでは webViewLink が空で返ることがある
    // （V1 Phase 9e）。file id から閲覧リンクを合成する。
    return { id: file.id, webViewLink: driveViewLink(file.id, file.webViewLink) };
  }

  private async accessToken() {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new Error("Google Drive access token could not be obtained");
    }
    return token;
  }
}

export function driveViewLink(id: string | undefined, webViewLink?: string) {
  if (webViewLink && webViewLink.trim()) return webViewLink;
  return id ? `https://drive.google.com/file/d/${id}/view` : "";
}

export class MemoryDriveStorage implements DriveStorage {
  private readonly files = new Map<number, StoredDriveFile>();
  uploads = 0;

  async findByDocumentId(documentId: number) {
    return this.files.get(documentId) ?? null;
  }

  async uploadPdf(input: { documentId: number; filename: string; pdf: Buffer }) {
    this.uploads += 1;
    const file = {
      id: `drive-${input.documentId}`,
      webViewLink: `https://drive.google.com/file/d/drive-${input.documentId}/view`
    };
    this.files.set(input.documentId, file);
    return file;
  }
}

function escapeQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveError(operation: string, response: Response) {
  const detail = (await response.text()).slice(0, 1000);
  return new Error(`Google Drive ${operation} failed (${response.status}): ${detail}`);
}
