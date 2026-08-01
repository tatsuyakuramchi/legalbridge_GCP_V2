export interface BacklogProjectSummary {
  id: number;
  projectKey: string;
  name: string;
}

export interface BacklogReadClient {
  getProject(): Promise<BacklogProjectSummary>;
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

export class BacklogWebApiClient implements BacklogReadClient {
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
    return { id: value.id, projectKey: value.projectKey, name: value.name };
  }
}

export function normalizeBacklogHost(value: string) {
  const host = value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!host || host.includes("/") || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error("Backlog host is invalid");
  }
  return host;
}
