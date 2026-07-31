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

export class GoogleDriveStorage implements DriveStorage {
  constructor(
    private readonly folderId: string,
    private readonly metadataBaseUrl =
      process.env.GCE_METADATA_HOST
        ? `http://${process.env.GCE_METADATA_HOST}/computeMetadata/v1`
        : "http://metadata.google.internal/computeMetadata/v1"
  ) {
    if (!folderId.trim()) throw new Error("GOOGLE_DRIVE_FOLDER_ID is required");
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
    return body.files?.[0] ?? null;
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
        legalbridgeEnvironment: "validation"
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
    return await response.json() as StoredDriveFile;
  }

  private async accessToken() {
    const response = await fetch(
      `${this.metadataBaseUrl}/instance/service-accounts/default/token`,
      { headers: { "Metadata-Flavor": "Google" } }
    );
    if (!response.ok) throw new Error(`metadata token request failed: ${response.status}`);
    const body = await response.json() as { access_token?: string };
    if (!body.access_token) throw new Error("metadata token response did not include access_token");
    return body.access_token;
  }
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
