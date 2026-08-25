import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import {
  buildRawMessage, isValidEmail, parseRecipientList,
  type GmailDeliveryAdapter, type GmailDeliveryReceipt, type GmailDeliveryRequest
} from "./gmail-delivery-adapter.js";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

// 送信元アドレスへの HTTP クライアント（テストで差し替え可能）。
export interface GmailApiClient {
  send(userEmail: string, raw: string, idempotencyKey: string): Promise<{ id: string; threadId: string | null }>;
}

export class GmailApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number | null = null) {
    super(message);
    this.name = "GmailApiError";
  }
}

// Drive と同じ認証優先順位（Secret Manager にマウントした Workspace SA の
// 鍵ファイル → ADC）。ドメイン全体委任で送信元ユーザーとして送るため、
// clientOptions.subject に送信元アドレスを指定する。
export class FetchGmailApiClient implements GmailApiClient {
  private readonly auth: GoogleAuth;

  constructor(
    private readonly senderEmail: string,
    options: { keyFilePath?: string } = {},
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!isValidEmail(senderEmail)) throw new Error("A valid Gmail sender address is required");
    const keyFile = options.keyFilePath?.trim();
    const keyFileUsable = Boolean(keyFile && fs.existsSync(keyFile));
    this.auth = new GoogleAuth({
      ...(keyFileUsable ? { keyFile } : {}),
      scopes: [GMAIL_SEND_SCOPE],
      clientOptions: { subject: senderEmail }
    });
  }

  // JSON エンドポイントは raw が大きいと 400 で拒否するため、このサイズを超えたら
  // メディアアップロード（message/rfc822・35MBまで）へ自動で切り替える。
  static readonly MEDIA_UPLOAD_THRESHOLD = 4 * 1024 * 1024;

  async send(userEmail: string, raw: string, _idempotencyKey: string) {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new GmailApiError("Gmail access token could not be obtained", "no_token");
    let response: Response;
    if (raw.length > FetchGmailApiClient.MEDIA_UPLOAD_THRESHOLD) {
      // base64url を RFC822 の生バイト列へ戻してメディアアップロードで送る。
      const rfc822 = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      response = await this.fetchImpl(
        `https://gmail.googleapis.com/upload/gmail/v1/users/${encodeURIComponent(userEmail)}/messages/send?uploadType=media`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "message/rfc822" },
          body: new Uint8Array(rfc822)
        }
      );
    } else {
      response = await this.fetchImpl(
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/messages/send`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw })
        }
      );
    }
    const payload = await response.json().catch(() => null) as
      { id?: unknown; threadId?: unknown; error?: { message?: unknown } } | null;
    if (!response.ok) {
      // Gmail の理由文（Invalid To header / size exceeds 等）を運用者が読めるように残す。
      const detail = String(payload?.error?.message ?? "").slice(0, 300);
      throw new GmailApiError(
        `Gmail API HTTP error: ${response.status}${detail ? ` — ${detail}` : ""}`,
        "http_error", response.status
      );
    }
    if (!payload || typeof payload.id !== "string") {
      throw new GmailApiError("Gmail API returned no message id", "invalid_response");
    }
    return { id: payload.id, threadId: typeof payload.threadId === "string" ? payload.threadId : null };
  }
}

export class GmailApiDeliveryAdapter implements GmailDeliveryAdapter {
  readonly configured = true;

  constructor(private readonly client: GmailApiClient) {}

  async send(request: GmailDeliveryRequest): Promise<GmailDeliveryReceipt> {
    // 宛先・CC はカンマ区切りで複数を許す。1件でも不正なら送らない。
    const recipients = parseRecipientList(request.to);
    const ccRecipients = parseRecipientList(request.cc ?? "");
    if (!recipients.length || recipients.some((email) => !isValidEmail(email)) || ccRecipients.some((email) => !isValidEmail(email))) {
      throw new GmailApiError("A valid recipient address is required", "invalid_recipient");
    }
    if (!isValidEmail(request.fromEmail)) throw new GmailApiError("A valid sender address is required", "invalid_sender");
    const raw = buildRawMessage(request);
    const receipt = await this.client.send(request.fromEmail, raw, request.idempotencyKey);
    return { messageId: receipt.id, threadId: receipt.threadId };
  }
}
