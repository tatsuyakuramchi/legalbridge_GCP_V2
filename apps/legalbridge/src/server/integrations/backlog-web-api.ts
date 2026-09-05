export interface BacklogProjectSummary {
  id: number;
  projectKey: string;
  name: string;
}

export interface BacklogIssueSummary {
  id: number;
  projectId: number;
  issueKey: string;
  summary: string;
  statusName: string | null;
}

export interface BacklogAttachmentSummary {
  id: number;
  name: string;
  size: number;
}

export interface BacklogCommentSummary {
  id: number;
  content: string;
}

export interface BacklogReadClient {
  getProject(): Promise<BacklogProjectSummary>;
  getIssue(issueIdOrKey: string): Promise<BacklogIssueSummary>;
  listIssueAttachments(issueIdOrKey: string): Promise<BacklogAttachmentSummary[]>;
}

export interface BacklogWriteClient extends BacklogReadClient {
  uploadAttachment(input: {
    filename: string;
    contentType: string;
    data: Uint8Array;
  }): Promise<BacklogAttachmentSummary>;
  addIssueComment(input: {
    issueIdOrKey: string;
    content: string;
    attachmentIds?: number[];
  }): Promise<BacklogCommentSummary>;
}

export interface BacklogReadClientOptions {
  host: string;
  apiKey: string;
  projectKey: string;
  fetch?: typeof globalThis.fetch;
}

export class BacklogApiError extends Error {
  constructor(readonly status: number, readonly operation?: string) {
    super(`Backlog API request failed (${status})${operation ? ` during ${operation}` : ""}`);
    this.name = "BacklogApiError";
  }
}

export class BacklogWebApiClient implements BacklogWriteClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly projectKey: string;
  private readonly request: typeof globalThis.fetch;

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
    const response = await this.requestJson(
      `projects/${encodeURIComponent(this.projectKey)}`,
      { method: "GET", headers: { accept: "application/json" } },
      "get project"
    );
    const value = response as Partial<BacklogProjectSummary>;
    if (
      typeof value.id !== "number" ||
      typeof value.projectKey !== "string" ||
      typeof value.name !== "string"
    ) {
      throw new Error("Backlog API returned an invalid project response");
    }
    return { id: value.id, projectKey: value.projectKey, name: value.name };
  }

  async getIssue(issueIdOrKey: string): Promise<BacklogIssueSummary> {
    const issueKey = normalizeIssueKey(issueIdOrKey);
    const response = await this.requestJson(
      `issues/${encodeURIComponent(issueKey)}`,
      { method: "GET", headers: { accept: "application/json" } },
      "get issue"
    ) as Record<string, unknown>;
    if (
      typeof response.id !== "number" ||
      typeof response.projectId !== "number" ||
      typeof response.issueKey !== "string" ||
      typeof response.summary !== "string"
    ) {
      throw new Error("Backlog API returned an invalid issue response");
    }
    const status = response.status as Record<string, unknown> | null | undefined;
    return {
      id: response.id,
      projectId: response.projectId,
      issueKey: response.issueKey,
      summary: response.summary,
      statusName: typeof status?.name === "string" ? status.name : null
    };
  }

  async listIssueAttachments(issueIdOrKey: string): Promise<BacklogAttachmentSummary[]> {
    const issueKey = normalizeIssueKey(issueIdOrKey);
    const response = await this.requestJson(
      `issues/${encodeURIComponent(issueKey)}/attachments`,
      { method: "GET", headers: { accept: "application/json" } },
      "list issue attachments"
    );
    if (!Array.isArray(response)) {
      throw new Error("Backlog API returned an invalid attachment list");
    }
    return response.map((item) => mapAttachment(item));
  }

  async uploadAttachment(input: {
    filename: string;
    contentType: string;
    data: Uint8Array;
  }): Promise<BacklogAttachmentSummary> {
    const filename = safeAttachmentFilename(input.filename);
    const form = new FormData();
    const bytes = Uint8Array.from(input.data);
    form.append("file", new Blob([bytes], {
      type: input.contentType || "application/octet-stream"
    }), filename);
    const response = await this.requestJson(
      "space/attachment",
      { method: "POST", body: form },
      "upload attachment"
    );
    return mapAttachment(response);
  }

  async addIssueComment(input: {
    issueIdOrKey: string;
    content: string;
    attachmentIds?: number[];
  }): Promise<BacklogCommentSummary> {
    const issueKey = normalizeIssueKey(input.issueIdOrKey);
    const content = input.content.trim();
    if (!content) throw new Error("Backlog comment content is required");
    const body = new URLSearchParams();
    body.set("content", content);
    for (const id of input.attachmentIds ?? []) {
      if (!Number.isInteger(id) || id <= 0) throw new Error("Backlog attachment id is invalid");
      body.append("attachmentId[]", String(id));
    }
    const response = await this.requestJson(
      `issues/${encodeURIComponent(issueKey)}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      },
      "add issue comment"
    ) as Record<string, unknown>;
    if (typeof response.id !== "number" || typeof response.content !== "string") {
      throw new Error("Backlog API returned an invalid comment response");
    }
    return { id: response.id, content: response.content };
  }

  private async requestJson(path: string, init: RequestInit, operation: string): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("apiKey", this.apiKey);
    const response = await this.request(url, init);
    if (!response.ok) throw new BacklogApiError(response.status, operation);
    return await response.json();
  }
}

function mapAttachment(value: unknown): BacklogAttachmentSummary {
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "number" ||
    typeof item.name !== "string" ||
    typeof item.size !== "number"
  ) {
    throw new Error("Backlog API returned an invalid attachment response");
  }
  return { id: item.id, name: item.name, size: item.size };
}

function normalizeIssueKey(value: string) {
  const key = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) {
    throw new Error("Backlog issue key is invalid");
  }
  return key;
}

function safeAttachmentFilename(value: string) {
  const filename = value.trim().replace(/[\\/\0\r\n]/g, "_").slice(0, 180);
  if (!filename) throw new Error("Backlog attachment filename is required");
  return filename;
}

export function normalizeBacklogHost(value: string) {
  const host = value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!host || host.includes("/") || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error("Backlog host is invalid");
  }
  return host;
}
