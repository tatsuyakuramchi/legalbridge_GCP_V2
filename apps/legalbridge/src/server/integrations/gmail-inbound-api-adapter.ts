import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import {
  extractPdfAttachments, headerValue, isPdfBufferSafe,
  type GmailInboundAdapter, type InboundContractMessage
} from "./gmail-inbound-adapter.js";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface GmailInboundApiClient {
  listMessageIds(query: string, maxResults: number): Promise<string[]>;
  getMessage(messageId: string): Promise<Record<string, unknown>>;
  getAttachment(messageId: string, attachmentId: string): Promise<string>; // base64url data
}

export class GmailInboundError extends Error {
  constructor(message: string, readonly code: string, readonly status: number | null = null) {
    super(message);
    this.name = "GmailInboundError";
  }
}

// gmail.readonly をドメイン全体委任で対象メールボックスに impersonate する。
export class FetchGmailInboundApiClient implements GmailInboundApiClient {
  private readonly auth: GoogleAuth;

  constructor(
    private readonly mailbox: string,
    options: { keyFilePath?: string } = {},
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!mailbox.trim()) throw new Error("A target mailbox is required");
    const keyFile = options.keyFilePath?.trim();
    const keyFileUsable = Boolean(keyFile && fs.existsSync(keyFile));
    this.auth = new GoogleAuth({
      ...(keyFileUsable ? { keyFile } : {}),
      scopes: [GMAIL_READONLY_SCOPE],
      clientOptions: { subject: mailbox }
    });
  }

  private user() { return encodeURIComponent(this.mailbox); }

  private async token(): Promise<string> {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new GmailInboundError("Gmail access token could not be obtained", "no_token");
    return token;
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const token = await this.token();
    const response = await this.fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/${this.user()}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new GmailInboundError(`Gmail API HTTP error: ${response.status}`, "http_error", response.status);
    if (!payload) throw new GmailInboundError("Gmail API returned no body", "invalid_response");
    return payload;
  }

  async listMessageIds(query: string, maxResults: number) {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(maxResults, 1), 50)) });
    const payload = await this.get(`/messages?${params.toString()}`);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages
      .map((entry) => (entry as Record<string, unknown>).id)
      .filter((id): id is string => typeof id === "string");
  }

  async getMessage(messageId: string) {
    return this.get(`/messages/${encodeURIComponent(messageId)}?format=full`);
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const payload = await this.get(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    if (typeof payload.data !== "string") throw new GmailInboundError("Gmail attachment had no data", "invalid_response");
    return payload.data;
  }
}

export class GmailInboundApiAdapter implements GmailInboundAdapter {
  readonly configured = true;

  constructor(private readonly client: GmailInboundApiClient) {}

  async listContracts(query: string, maxResults: number): Promise<InboundContractMessage[]> {
    const ids = await this.client.listMessageIds(query, maxResults);
    const messages: InboundContractMessage[] = [];
    for (const id of ids) {
      const message = await this.client.getMessage(id);
      const payload = message.payload as Record<string, unknown> | undefined;
      const headers = payload?.headers;
      const attachments = extractPdfAttachments(payload);
      if (!attachments.length) continue; // PDF添付のあるメールだけを契約候補とする
      messages.push({
        messageId: id,
        threadId: typeof message.threadId === "string" ? message.threadId : null,
        subject: headerValue(headers, "Subject"),
        from: headerValue(headers, "From"),
        date: headerValue(headers, "Date") || null,
        attachments
      });
    }
    return messages;
  }

  async fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const data = await this.client.getAttachment(messageId, attachmentId);
    const buffer = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (!isPdfBufferSafe(buffer)) {
      throw new GmailInboundError("Fetched attachment is not a PDF", "not_pdf");
    }
    return buffer;
  }
}
