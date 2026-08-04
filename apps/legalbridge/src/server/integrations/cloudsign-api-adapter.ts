import {
  CloudSignError, isValidEmail,
  type CloudSignAdapter, type CloudSignSignatureReceipt, type CloudSignSignatureRequest
} from "./cloudsign-adapter.js";

// CloudSign REST クライアント（テストで差し替え可能）。実HTTP実装は
// FetchCloudSignApiClient。orchestration は CloudSignApiAdapter 側に置く。
export interface CloudSignApiClient {
  createDocument(input: { title: string; note?: string }): Promise<{ id: string }>;
  addFile(documentId: string, filename: string, pdf: Buffer): Promise<{ id: string }>;
  addParticipant(documentId: string, participant: { email: string; name: string; organization?: string }): Promise<{ id: string }>;
  send(documentId: string): Promise<{ status: string }>;
}

// CloudSign v2 の一般形に対する実HTTP実装。OAuth2 で client_id からアクセス
// トークンを取得し、Bearer で /documents 系を呼ぶ。実URL・client_id は
// 有効化時に確定する（既定では live 化されない）。
export class FetchCloudSignApiClient implements CloudSignApiClient {
  private cachedToken: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!baseUrl.trim()) throw new Error("CloudSign base URL is required");
    if (!clientId.trim()) throw new Error("CloudSign client id is required");
  }

  private base(path: string) {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async token(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    const url = new URL(this.base("/token"));
    url.searchParams.set("client_id", this.clientId);
    const response = await this.fetchImpl(url, { method: "POST" });
    const payload = await response.json().catch(() => null) as { access_token?: unknown } | null;
    if (!response.ok || typeof payload?.access_token !== "string") {
      throw new CloudSignError("CloudSign token acquisition failed", "token_error", response.status);
    }
    this.cachedToken = payload.access_token;
    return this.cachedToken;
  }

  private async authed(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const token = await this.token();
    const response = await this.fetchImpl(this.base(path), {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new CloudSignError(`CloudSign API HTTP error: ${response.status}`, "http_error", response.status);
    }
    if (!payload) throw new CloudSignError("CloudSign API returned no body", "invalid_response");
    return payload;
  }

  async createDocument(input: { title: string; note?: string }) {
    const payload = await this.authed("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, ...(input.note ? { note: input.note } : {}) })
    });
    if (typeof payload.id !== "string") throw new CloudSignError("CloudSign createDocument returned no id", "invalid_response");
    return { id: payload.id };
  }

  async addFile(documentId: string, filename: string, pdf: Buffer) {
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
    const payload = await this.authed(`/documents/${encodeURIComponent(documentId)}/files`, {
      method: "POST",
      body: form
    });
    return { id: typeof payload.id === "string" ? payload.id : documentId };
  }

  async addParticipant(documentId: string, participant: { email: string; name: string; organization?: string }) {
    const payload = await this.authed(`/documents/${encodeURIComponent(documentId)}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(participant)
    });
    if (typeof payload.id !== "string") throw new CloudSignError("CloudSign addParticipant returned no id", "invalid_response");
    return { id: payload.id };
  }

  async send(documentId: string) {
    const payload = await this.authed(`/documents/${encodeURIComponent(documentId)}`, { method: "POST" });
    return { status: typeof payload.status === "string" ? payload.status : "sent" };
  }
}

export class CloudSignApiAdapter implements CloudSignAdapter {
  readonly configured = true;

  constructor(private readonly client: CloudSignApiClient) {}

  async requestSignature(request: CloudSignSignatureRequest): Promise<CloudSignSignatureReceipt> {
    if (!request.participants.length) throw new CloudSignError("At least one participant is required", "no_participants");
    for (const participant of request.participants) {
      if (!isValidEmail(participant.email)) throw new CloudSignError("A valid participant email is required", "invalid_participant");
    }
    const document = await this.client.createDocument({ title: request.documentTitle, note: request.note });
    await this.client.addFile(document.id, request.filename, request.pdf);
    const participantIds: string[] = [];
    for (const participant of request.participants) {
      const added = await this.client.addParticipant(document.id, participant);
      participantIds.push(added.id);
    }
    const sent = await this.client.send(document.id);
    return { cloudSignDocumentId: document.id, status: sent.status, participantIds };
  }
}
