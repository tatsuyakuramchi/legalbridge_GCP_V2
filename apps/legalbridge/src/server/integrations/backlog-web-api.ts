export interface BacklogProjectSummary {
  id: number;
  projectKey: string;
  name: string;
}

export interface BacklogIssueSummary {
  id: number;
  issueKey: string;
  summary: string;
  description: string | null;
  statusName: string | null;
  assigneeName: string | null;
  created: string | null;
  updated: string | null;
}

// プロジェクト固有のステータス／カスタム属性の実ID一覧（3-2b の同期実装前に運用側で確定するための読取）。
export interface BacklogStatusSummary {
  id: number;
  name: string;
}

export interface BacklogCustomFieldSummary {
  id: number;
  name: string;
  typeId: number;
}

export interface BacklogProjectMetadata {
  statuses: BacklogStatusSummary[];
  customFields: BacklogCustomFieldSummary[];
}

export interface BacklogReadClient {
  getProject(): Promise<BacklogProjectSummary>;
  getIssues(options?: { count?: number; keyword?: string }): Promise<BacklogIssueSummary[]>;
  getProjectMetadata(): Promise<BacklogProjectMetadata>;
}

// 書き戻し（Phase 3・guarded）。コメント投稿＋課題起票（Phase 16-3・Slack インテーク用）。
// ステータス/カスタム属性はプロジェクト固有IDの確定後に別途。
export interface BacklogWriteClient {
  addComment(issueKey: string, content: string): Promise<{ id: number }>;
  // 課題を起票して issueKey を返す。issueTypeName は名前で解決（不明時は先頭種別へフォールバック）。
  createIssue(input: { summary: string; description: string; issueTypeName: string }): Promise<{ issueKey: string }>;
}

function mapIssue(raw: unknown): BacklogIssueSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = (r.status ?? {}) as Record<string, unknown>;
  const assignee = (r.assignee ?? {}) as Record<string, unknown>;
  return {
    id: Number(r.id),
    issueKey: typeof r.issueKey === "string" ? r.issueKey : "",
    summary: typeof r.summary === "string" ? r.summary : "",
    description: typeof r.description === "string" ? r.description : null,
    statusName: typeof status.name === "string" ? status.name : null,
    assigneeName: typeof assignee.name === "string" ? assignee.name : null,
    created: typeof r.created === "string" ? r.created : null,
    updated: typeof r.updated === "string" ? r.updated : null
  };
}

function mapStatus(raw: unknown): BacklogStatusSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: Number(r.id),
    name: typeof r.name === "string" ? r.name : ""
  };
}

function mapCustomField(raw: unknown): BacklogCustomFieldSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: Number(r.id),
    name: typeof r.name === "string" ? r.name : "",
    typeId: Number(r.typeId)
  };
}

export interface BacklogReadClientOptions {
  host: string;
  apiKey: string;
  projectKey: string;
  fetch?: typeof globalThis.fetch;
}

export class BacklogApiError extends Error {
  constructor(readonly status: number) {
    super(`Backlog API request failed (${status})`);
    this.name = "BacklogApiError";
  }
}

export class BacklogWebApiClient implements BacklogReadClient, BacklogWriteClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly projectKey: string;
  private readonly request: typeof globalThis.fetch;
  private projectId: number | null = null;

  constructor(options: BacklogReadClientOptions) {
    const host = normalizeBacklogHost(options.host);
    if (!options.apiKey.trim()) throw new Error("Backlog API key is required");
    if (!options.projectKey.trim()) throw new Error("Backlog project key is required");
    this.baseUrl = new URL(`https://${host}/api/v2/`);
    this.apiKey = options.apiKey;
    this.projectKey = options.projectKey.trim();
    this.request = options.fetch ?? globalThis.fetch;
  }

  async getProject(): Promise<BacklogProjectSummary> {
    const path = `projects/${encodeURIComponent(this.projectKey)}`;
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("apiKey", this.apiKey);
    const response = await this.request(url, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new BacklogApiError(response.status);
    const value = await response.json() as Partial<BacklogProjectSummary>;
    if (
      typeof value.id !== "number" ||
      typeof value.projectKey !== "string" ||
      typeof value.name !== "string"
    ) {
      throw new Error("Backlog API returned an invalid project response");
    }
    this.projectId = value.id;
    return { id: value.id, projectKey: value.projectKey, name: value.name };
  }

  private async resolveProjectId(): Promise<number> {
    if (this.projectId != null) return this.projectId;
    return (await this.getProject()).id;
  }

  async getIssues(options: { count?: number; keyword?: string } = {}): Promise<BacklogIssueSummary[]> {
    const projectId = await this.resolveProjectId();
    const url = new URL("issues", this.baseUrl);
    url.searchParams.set("apiKey", this.apiKey);
    url.searchParams.append("projectId[]", String(projectId));
    url.searchParams.set("count", String(Math.min(Math.max(options.count ?? 50, 1), 100)));
    url.searchParams.set("sort", "updated");
    url.searchParams.set("order", "desc");
    const keyword = options.keyword?.trim();
    if (keyword) url.searchParams.set("keyword", keyword);
    const response = await this.request(url, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) throw new BacklogApiError(response.status);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("Backlog API returned an invalid issues response");
    return value.map(mapIssue);
  }

  async getProjectMetadata(): Promise<BacklogProjectMetadata> {
    const key = encodeURIComponent(this.projectKey);
    const statuses = await this.getJsonArray(`projects/${key}/statuses`);
    const customFields = await this.getJsonArray(`projects/${key}/customFields`);
    return {
      statuses: statuses.map(mapStatus),
      customFields: customFields.map(mapCustomField)
    };
  }

  private async getJsonArray(path: string): Promise<unknown[]> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("apiKey", this.apiKey);
    const response = await this.request(url, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) throw new BacklogApiError(response.status);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("Backlog API returned an invalid response");
    return value;
  }

  // 課題起票（Phase 16-3）。V1 backlogService.createIssue のサブセット：種別は名前で解決し
  // priority は「中」(3) 固定。カスタム属性はプロジェクト固有IDが要るため 16-3a では見送り。
  async createIssue(input: { summary: string; description: string; issueTypeName: string }): Promise<{ issueKey: string }> {
    const projectId = await this.resolveProjectId();
    const key = encodeURIComponent(this.projectKey);
    const types = await this.getJsonArray(`projects/${key}/issueTypes`);
    const named = types
      .map((t) => t as { id?: unknown; name?: unknown })
      .find((t) => typeof t.name === "string" && t.name === input.issueTypeName);
    const first = types[0] as { id?: unknown } | undefined;
    const issueTypeId = Number(named?.id ?? first?.id);
    if (!Number.isFinite(issueTypeId)) throw new Error("Backlog issue type could not be resolved");

    const url = new URL("issues", this.baseUrl);
    url.searchParams.set("apiKey", this.apiKey);
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        projectId: String(projectId),
        summary: input.summary,
        description: input.description,
        issueTypeId: String(issueTypeId),
        priorityId: "3"
      }).toString()
    });
    if (!response.ok) throw new BacklogApiError(response.status);
    const value = await response.json() as { issueKey?: unknown };
    if (typeof value?.issueKey !== "string" || !value.issueKey) {
      throw new Error("Backlog issue creation returned an invalid response");
    }
    return { issueKey: value.issueKey };
  }

  async addComment(issueKey: string, content: string): Promise<{ id: number }> {
    const url = new URL(`issues/${encodeURIComponent(issueKey)}/comments`, this.baseUrl);
    url.searchParams.set("apiKey", this.apiKey);
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ content }).toString()
    });
    if (!response.ok) throw new BacklogApiError(response.status);
    const value = await response.json() as { id?: unknown };
    return { id: Number(value?.id) };
  }
}

export function normalizeBacklogHost(value: string) {
  const host = value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!host || host.includes("/") || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error("Backlog host is invalid");
  }
  return host;
}
