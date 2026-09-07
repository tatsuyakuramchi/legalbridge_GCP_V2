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
  // 既存 Drive ファイルの中身を差し替える（PDF 再生成・Phase 10-3）。リンク/ID は維持。
  updatePdf(input: { fileId: string; pdf: Buffer }): Promise<StoredDriveFile>;
  // 任意 MIME の生ファイル格納（Phase 16-4・添付アップロード）。optional：
  // 既存のテスト用スタブ実装を壊さないため。未実装のストレージでは添付機能を無効化する。
  uploadFile?(input: {
    filename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<StoredDriveFile>;
  // Drive 上の実体を取り出す（システム外で作った契約書を CloudSign へ送るため）。
  // uploadFile と同じく optional：未実装なら添付からの送信だけが無効になる。
  downloadFile?(fileId: string): Promise<{ data: Buffer; mimeType: string }>;
}

// Drive の閲覧リンクからファイル ID を取り出す。documents.drive_link は
// webViewLink をそのまま持っており、形式が数種類あるので純関数にして固定する。
//   https://drive.google.com/file/d/<id>/view?usp=drivesdk
//   https://drive.google.com/open?id=<id>
//   https://docs.google.com/document/d/<id>/edit
export function driveFileIdFromLink(link: string | null | undefined): string | null {
  const value = String(link ?? "").trim();
  if (!value) return null;
  const path = value.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (path) return path[1];
  const query = value.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (query) return query[1];
  // リンクではなく ID がそのまま入っている場合。
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  return null;
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

  async uploadFile(input: { filename: string; mimeType: string; data: Buffer }) {
    const token = await this.accessToken();
    const boundary = `legalbridge-${crypto.randomUUID()}`;
    const metadata = {
      name: input.filename,
      mimeType: input.mimeType || "application/octet-stream",
      parents: [this.folderId],
      appProperties: { legalbridgeEnvironment: this.environmentTag }
    };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`),
      input.data,
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
    return { id: file.id, webViewLink: driveViewLink(file.id, file.webViewLink) };
  }

  async downloadFile(fileId: string) {
    const token = await this.accessToken();
    // MIME はメタデータ側から取る（alt=media の Content-Type は Drive 側の
    // 変換で変わることがあり、添付時に記録した種別と食い違うため）。
    const metaUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    metaUrl.searchParams.set("supportsAllDrives", "true");
    metaUrl.searchParams.set("fields", "mimeType");
    const meta = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!meta.ok) throw await driveError("download", meta);
    const { mimeType } = await meta.json() as { mimeType?: string };

    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await driveError("download", response);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: String(mimeType ?? "application/octet-stream")
    };
  }

  async updatePdf(input: { fileId: string; pdf: Buffer }) {
    const token = await this.accessToken();
    // 既存ファイルの中身のみ差し替える（media アップロード・メタデータ据え置き）。
    const url = new URL(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(input.fileId)}`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "id,webViewLink");
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/pdf",
        "Content-Length": String(input.pdf.length)
      },
      body: new Uint8Array(input.pdf)
    });
    if (!response.ok) throw await driveError("update", response);
    const file = await response.json() as StoredDriveFile;
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

  updates = 0;
  async updatePdf(input: { fileId: string; pdf: Buffer }) {
    this.updates += 1;
    return { id: input.fileId, webViewLink: `https://drive.google.com/file/d/${input.fileId}/view` };
  }

  fileUploads: Array<{ filename: string; mimeType: string; size: number }> = [];
  async uploadFile(input: { filename: string; mimeType: string; data: Buffer }) {
    this.fileUploads.push({ filename: input.filename, mimeType: input.mimeType, size: input.data.length });
    const id = `drive-file-${this.fileUploads.length}`;
    this.contents.set(id, { data: input.data, mimeType: input.mimeType });
    return { id, webViewLink: `https://drive.google.com/file/d/${id}/view` };
  }

  // downloadFile 用の中身。テストからは seedFile で直接置ける。
  readonly contents = new Map<string, { data: Buffer; mimeType: string }>();
  seedFile(fileId: string, data: Buffer, mimeType: string) {
    this.contents.set(fileId, { data, mimeType });
  }
  downloads: string[] = [];
  async downloadFile(fileId: string) {
    this.downloads.push(fileId);
    const found = this.contents.get(fileId);
    if (!found) throw new Error(`Google Drive download failed: ${fileId} not found`);
    return found;
  }
}

function escapeQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveError(operation: string, response: Response) {
  const detail = (await response.text()).slice(0, 1000);
  return new Error(`Google Drive ${operation} failed (${response.status}): ${detail}`);
}
