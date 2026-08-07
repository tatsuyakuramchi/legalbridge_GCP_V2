import {
  CloudSignError, isValidEmail, normalizeCloudSignStatus,
  type CloudSignAdapter, type CloudSignSignatureReceipt, type CloudSignSignatureRequest,
  type CloudSignStatus
} from "./cloudsign-adapter.js";

// CloudSign REST クライアント（テストで差し替え可能）。実HTTP実装は
// FetchCloudSignApiClient。orchestration は CloudSignApiAdapter 側に置く。
export interface CloudSignApiClient {
  createDocument(input: { title: string; note?: string }): Promise<{ id: string }>;
  addFile(documentId: string, filename: string, pdf: Buffer): Promise<{ id: string }>;
  addParticipant(documentId: string, participant: { email: string; name: string; organization?: string }): Promise<{ id: string }>;
  send(documentId: string): Promise<{ status: string }>;
  getDocument(documentId: string): Promise<Record<string, unknown>>;
}

export interface CloudSignApiClientOptions {
  fetchImpl?: typeof fetch;
}

// CloudSign Web API 実HTTP実装。V1 (LegalBridge_AI_GCP) の実動クライアントに準拠。
//   認証: POST /token に client_id を form-urlencoded で渡し access_token(Bearer)取得。
//         短命トークンのため expires_in を尊重してキャッシュ＆更新（30秒前倒し失効）。
//         401 は 1 回だけトークンを捨てて再取得リトライ。
//   送信: createDocument → addFile(uploadfile) → addParticipant → send。いずれも
//         form-urlencoded / multipart（CloudSign は JSON body を受けない）。
//   ※ client_secret は使用しない（CloudSign の /token は client_id のみ）。
export class FetchCloudSignApiClient implements CloudSignApiClient {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    options: CloudSignApiClientOptions = {}
  ) {
    if (!baseUrl.trim()) throw new Error("CloudSign base URL is required");
    if (!clientId.trim()) throw new Error("CloudSign client id is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private base(path: string) {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  // POST /token: client_id を form-urlencoded で送り access_token を取得。
  // expires_in（秒・不明時600）を尊重し、30秒前倒しで失効扱いにしてキャッシュする。
  private async token(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) return this.cachedToken.value;
    const body = new URLSearchParams({ client_id: this.clientId });
    const response = await this.fetchImpl(this.base("/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const payload = await response.json().catch(() => null) as
      { access_token?: unknown; expires_in?: unknown } | null;
    if (!response.ok || typeof payload?.access_token !== "string") {
      throw new CloudSignError("CloudSign token acquisition failed", "token_error", response.status);
    }
    const expiresIn = Number(payload.expires_in) || 600;
    this.cachedToken = {
      value: payload.access_token,
      expiresAt: now + Math.max(60, expiresIn - 30) * 1000
    };
    return this.cachedToken.value;
  }

  // 401（トークン失効）のときだけ 1 回トークンを捨てて再試行する薄いラッパ。
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CloudSignError && error.status === 401) {
        this.cachedToken = null;
        return await fn();
      }
      throw error;
    }
  }

  private async authed(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    return this.withRetry(async () => {
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
    });
  }

  private form(fields: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== "") params.set(key, value);
    }
    return params.toString();
  }

  async createDocument(input: { title: string; note?: string }) {
    // CloudSign /documents は form-urlencoded。title のみ送る（note は API 対象外）。
    const payload = await this.authed("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: this.form({ title: input.title })
    });
    if (typeof payload.id !== "string") throw new CloudSignError("CloudSign createDocument returned no id", "invalid_response");
    return { id: payload.id };
  }

  async addFile(documentId: string, filename: string, pdf: Buffer) {
    // multipart のファイル項目名は uploadfile（V1 実装準拠）。Content-Type は
    // FormData に任せる（boundary 自動付与）ため明示しない。
    const form = new FormData();
    form.append("uploadfile", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
    const payload = await this.authed(`/documents/${encodeURIComponent(documentId)}/files`, {
      method: "POST",
      body: form
    });
    return { id: typeof payload.id === "string" ? payload.id : documentId };
  }

  async addParticipant(participantDocumentId: string, participant: { email: string; name: string; organization?: string }) {
    // participants は form-urlencoded（email/name/organization）。
    const payload = await this.authed(`/documents/${encodeURIComponent(participantDocumentId)}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: this.form({ email: participant.email, name: participant.name, organization: participant.organization })
    });
    if (typeof payload.id !== "string") throw new CloudSignError("CloudSign addParticipant returned no id", "invalid_response");
    return { id: payload.id };
  }

  async send(documentId: string) {
    // 送信確定は POST /documents/{id}（本文なし）。
    const payload = await this.authed(`/documents/${encodeURIComponent(documentId)}`, { method: "POST" });
    return { status: typeof payload.status === "string" ? payload.status : "sent" };
  }

  async getDocument(documentId: string) {
    return this.authed(`/documents/${encodeURIComponent(documentId)}`, { method: "GET" });
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

  async fetchStatus(cloudSignDocumentId: string): Promise<CloudSignStatus> {
    const raw = await this.client.getDocument(cloudSignDocumentId);
    const { status, completed } = normalizeCloudSignStatus(raw.status);
    const rawParticipants = Array.isArray(raw.participants) ? raw.participants : [];
    const participants = rawParticipants.map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        email: typeof record.email === "string" ? record.email : "",
        status: normalizeCloudSignStatus(record.status).status
      };
    });
    return { cloudSignDocumentId, status, completed, participants };
  }
}
