export interface BacklogProjectSummary {
  id: number;
  projectKey: string;
  name: string;
}

export interface BacklogIssueSummary {
  id: number;
  issueKey: string;
  summary: string;
  statusName: string | null;
  assigneeName: string | null;
  created: string | null;
  updated: string | null;
}

export interface BacklogReadClient {
  getProject(): Promise<BacklogProjectSummary>;
  getIssues(options?: { count?: number; keyword?: string }): Promise<BacklogIssueSummary[]>;
}

// 書き戻し（Phase 3・guarded）。現状はコメント投稿のみ（ID非依存）。
// ステータス/カスタム属性はプロジェクト固有IDの確定後に別途。
export interface BacklogWriteClient {
  addComment(issueKey: string, content: string): Promise<{ id: number }>;
}

function mapIssue(raw: unknown): BacklogIssueSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = (r.status ?? {}) as Record<string, unknown>;
  const assignee = (r.assignee ?? {}) as Record<string, unknown>;
  return {
    id: Number(r.id),
    issueKey: typeof r.issueKey === "string" ? r.issueKey : "",
    summary: typeof r.summary === "string" ? r.summary : "",
    statusName: typeof status.name === "string" ? status.name : null,
    assigneeName: typeof assignee.name === "string" ? assignee.name : null,
    created: typeof r.created === "string" ? r.created : null,
    updated: typeof r.updated === "string" ? r.updated : null
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
