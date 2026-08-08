import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";

// Drive 閲覧権限の付与（案件 Slack テンプレのメンション先へ文書共有）。
// drive-storage.ts と同じ Workspace SA 認証を用い、permissions.create で
// role=reader / type=user を付与する。best-effort（失敗は呼び出し側で握る）。

export interface DrivePermissionGranter {
  readonly configured: boolean;
  grantView(fileId: string, email: string): Promise<void>;
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// Drive リンクからファイルIDを取り出す。/d/{id}、?id={id}、/folders/{id} に対応。
export function extractDriveFileId(link: string): string | null {
  const value = String(link ?? "").trim();
  if (!value) return null;
  const byPath = value.match(/\/(?:file\/d|folders|d)\/([A-Za-z0-9_-]{10,})/);
  if (byPath) return byPath[1];
  const byQuery = value.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (byQuery) return byQuery[1];
  // すでにIDそのものが渡された場合。
  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) return value;
  return null;
}

export class LocalDrivePermissionGranter implements DrivePermissionGranter {
  readonly configured = false;
  async grantView(): Promise<void> {
    throw new Error("Drive permission granting is not configured");
  }
}

export class GoogleDrivePermissionGranter implements DrivePermissionGranter {
  readonly configured = true;
  private readonly auth: GoogleAuth;

  constructor(options: { keyFilePath?: string } = {}) {
    const keyFile = options.keyFilePath?.trim();
    const keyFileUsable = Boolean(keyFile && fs.existsSync(keyFile));
    this.auth = new GoogleAuth({
      ...(keyFileUsable ? { keyFile } : {}),
      scopes: [DRIVE_SCOPE]
    });
  }

  async grantView(fileId: string, email: string): Promise<void> {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Google Drive access token could not be obtained");
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`
    );
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("sendNotificationEmail", "false");
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "user", emailAddress: email })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Drive permission grant failed (${response.status}): ${detail}`);
    }
  }
}

export class MemoryDrivePermissionGranter implements DrivePermissionGranter {
  readonly configured = true;
  grants: Array<{ fileId: string; email: string }> = [];
  constructor(private readonly failFor: Set<string> = new Set()) {}
  async grantView(fileId: string, email: string): Promise<void> {
    if (this.failFor.has(email)) throw new Error(`grant failed for ${email}`);
    this.grants.push({ fileId, email });
  }
}
