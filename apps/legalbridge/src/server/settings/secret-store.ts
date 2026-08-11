import { GoogleAuth } from "google-auth-library";

// APIキー等の秘密情報の保存先（Secret Manager）への薄いアクセス層（Phase 2-5・設定画面からのキー投入）。
// 方針：
//   - 値の保存先は従来どおり Secret Manager のみ。DB（app_settings）には一切入れない。
//   - 画面は「書き込み専用」。status() はメタデータ（登録済みか・版・更新時刻）だけを返し、
//     値そのものは access()（ランタイム解決専用）以外では取り出さない。
//   - live/disabled の切替やシークレットの env マウントは従来どおりデプロイ管理（この層は触らない）。

export interface SecretVersionStatus {
  registered: boolean;
  version?: string;
  updatedAt?: string;
}

export interface SecretStore {
  status(secretName: string): Promise<SecretVersionStatus>;
  addVersion(secretName: string, value: string): Promise<{ version: string }>;
  // ランタイム解決用（最新版の値）。未登録・アクセス不可は null。
  access(secretName: string): Promise<string | null>;
}

export class SecretStoreError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "PERMISSION" | "UNAVAILABLE") {
    super(message);
    this.name = "SecretStoreError";
  }
}

const API_BASE = "https://secretmanager.googleapis.com/v1";

// GCP Secret Manager 実装。Cloud Run 上では ADC（実行SA）で認証する。
// 必要な権限（対象シークレットに対して）:
//   roles/secretmanager.secretVersionAdder（版の追加）
//   roles/secretmanager.viewer（登録状況の表示）
//   roles/secretmanager.secretAccessor（ランタイム解決）
export class GcpSecretStore implements SecretStore {
  private readonly auth: GoogleAuth;
  private projectId: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { projectId?: string; fetchImpl?: typeof fetch } = {}) {
    this.auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    this.projectId = options.projectId?.trim() || null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: { method?: string; body?: unknown } = {}) {
    if (!this.projectId) this.projectId = await this.auth.getProjectId();
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new SecretStoreError("Secret Manager の認証に失敗しました", "UNAVAILABLE");
    const response = await this.fetchImpl(`${API_BASE}/projects/${this.projectId}/${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    return response;
  }

  async status(secretName: string): Promise<SecretVersionStatus> {
    const response = await this.request(`secrets/${encodeURIComponent(secretName)}/versions/latest`);
    if (response.status === 404) return { registered: false };
    if (response.status === 403) throw new SecretStoreError(`シークレット ${secretName} の参照権限がありません`, "PERMISSION");
    if (!response.ok) throw new SecretStoreError(`Secret Manager 参照に失敗しました (HTTP ${response.status})`, "UNAVAILABLE");
    const payload = await response.json() as { name?: string; createTime?: string; state?: string };
    if (payload.state && payload.state !== "ENABLED") return { registered: false };
    const version = typeof payload.name === "string" ? payload.name.split("/").pop() : undefined;
    return { registered: true, version, updatedAt: payload.createTime };
  }

  async addVersion(secretName: string, value: string): Promise<{ version: string }> {
    const data = Buffer.from(value, "utf8").toString("base64");
    const add = () => this.request(`secrets/${encodeURIComponent(secretName)}:addVersion`, {
      method: "POST",
      body: { payload: { data } }
    });
    let response = await add();
    if (response.status === 404) {
      // シークレット未作成なら自動作成を試みる（プロジェクトレベル権限がある場合のみ成功）。
      const created = await this.request(`secrets?secretId=${encodeURIComponent(secretName)}`, {
        method: "POST",
        body: { replication: { automatic: {} } }
      });
      if (!created.ok && created.status !== 409) {
        throw new SecretStoreError(
          `シークレット ${secretName} が未作成です（初期設定コマンドで作成と権限付与が必要）`, "NOT_FOUND");
      }
      response = await add();
    }
    if (response.status === 403) throw new SecretStoreError(`シークレット ${secretName} への書込権限がありません`, "PERMISSION");
    if (!response.ok) throw new SecretStoreError(`Secret Manager への保存に失敗しました (HTTP ${response.status})`, "UNAVAILABLE");
    const payload = await response.json() as { name?: string };
    const version = typeof payload.name === "string" ? payload.name.split("/").pop() ?? "?" : "?";
    return { version };
  }

  async access(secretName: string): Promise<string | null> {
    const response = await this.request(`secrets/${encodeURIComponent(secretName)}/versions/latest:access`);
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new SecretStoreError(`Secret Manager 読取に失敗しました (HTTP ${response.status})`, "UNAVAILABLE");
    const payload = await response.json() as { payload?: { data?: string } };
    const data = payload.payload?.data;
    if (typeof data !== "string") return null;
    return Buffer.from(data, "base64").toString("utf8");
  }
}

// テスト・ローカル用のメモリ実装。
export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, { values: string[]; updatedAt: string }>();
  // 事前作成済みシークレットのみ受け付けるモード（本番の権限モデルの再現用）。
  constructor(private readonly options: { requireExisting?: boolean } = {}) {}

  create(secretName: string) {
    if (!this.secrets.has(secretName)) this.secrets.set(secretName, { values: [], updatedAt: new Date(0).toISOString() });
  }

  async status(secretName: string): Promise<SecretVersionStatus> {
    const entry = this.secrets.get(secretName);
    if (!entry || entry.values.length === 0) return { registered: false };
    return { registered: true, version: String(entry.values.length), updatedAt: entry.updatedAt };
  }

  async addVersion(secretName: string, value: string): Promise<{ version: string }> {
    let entry = this.secrets.get(secretName);
    if (!entry) {
      if (this.options.requireExisting) {
        throw new SecretStoreError(`シークレット ${secretName} が未作成です（初期設定コマンドで作成と権限付与が必要）`, "NOT_FOUND");
      }
      this.create(secretName);
      entry = this.secrets.get(secretName)!;
    }
    entry.values.push(value);
    entry.updatedAt = new Date().toISOString();
    return { version: String(entry.values.length) };
  }

  async access(secretName: string): Promise<string | null> {
    const entry = this.secrets.get(secretName);
    if (!entry || entry.values.length === 0) return null;
    return entry.values[entry.values.length - 1];
  }
}
