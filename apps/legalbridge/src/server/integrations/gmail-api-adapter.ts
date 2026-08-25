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

// JSON エンドポイントは raw が大きいと 400 で拒否するため、このサイズを超えたら
// メディアアップロード（message/rfc822・35MBまで）へ自動で切り替える。
export const MEDIA_UPLOAD_THRESHOLD = 4 * 1024 * 1024;

// Gmail messages.send の実行（鍵あり/鍵レスの両クライアントで共用）。
async function postGmailSend(
  fetchImpl: typeof fetch, token: string, userEmail: string, raw: string
): Promise<{ id: string; threadId: string | null }> {
  let response: Response;
  if (raw.length > MEDIA_UPLOAD_THRESHOLD) {
    // base64url を RFC822 の生バイト列へ戻してメディアアップロードで送る。
    const rfc822 = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    response = await fetchImpl(
      `https://gmail.googleapis.com/upload/gmail/v1/users/${encodeURIComponent(userEmail)}/messages/send?uploadType=media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "message/rfc822" },
        body: new Uint8Array(rfc822)
      }
    );
  } else {
    response = await fetchImpl(
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

// Drive と同じ認証優先順位（Secret Manager にマウントした Workspace SA の
// 鍵ファイル → ADC）。ドメイン全体委任で送信元ユーザーとして送るため、
// clientOptions.subject に送信元アドレスを指定する。
// 注意: 鍵ファイルが無い（ADC＝ランタイムSA）と subject は効かず、SA 自身の
// 名義になって Gmail が「Precondition check failed」で拒否する。鍵レス環境では
// KeylessGmailApiClient を使うこと。
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

  async send(userEmail: string, raw: string, _idempotencyKey: string) {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new GmailApiError("Gmail access token could not be obtained", "no_token");
    return postGmailSend(this.fetchImpl, token, userEmail, raw);
  }
}

// 鍵レスのドメイン全体委任送信（V1 EmailService の鍵レス経路の移植）。
// 委任済みクライアントIDを持つ SA（delegateSa）の signJwt（IAM Credentials API）で
// sub=送信元 の JWT を署名し、JWT-bearer でアクセストークンへ交換して送る。
// 前提: 実行側の SA に delegateSa への roles/iam.serviceAccountTokenCreator、
//       delegateSa のクライアントIDが Workspace で gmail.send にドメイン全体委任済み。
export class KeylessGmailApiClient implements GmailApiClient {
  private readonly auth: GoogleAuth;

  constructor(
    private readonly senderEmail: string,
    // 委任済みクライアントIDを持つ SA。空なら実行中ランタイムSA（メタデータから解決）。
    private readonly delegateSa: string,
    private readonly fetchImpl: typeof fetch = fetch,
    // テスト用: ベーストークン（cloud-platform）の取得を差し替え可能にする。
    private readonly baseTokenProvider?: () => Promise<string>
  ) {
    if (!isValidEmail(senderEmail)) throw new Error("A valid Gmail sender address is required");
    this.auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  }

  private async baseToken(): Promise<string> {
    if (this.baseTokenProvider) return this.baseTokenProvider();
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new GmailApiError("base access token could not be obtained", "no_token");
    return token;
  }

  private async resolveDelegate(): Promise<string> {
    if (this.delegateSa.trim()) return this.delegateSa.trim();
    try {
      const response = await this.fetchImpl(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
        { headers: { "Metadata-Flavor": "Google" } }
      );
      const email = (await response.text()).trim();
      if (response.ok && email.includes("@")) return email;
    } catch { /* fall through */ }
    throw new GmailApiError(
      "委任に使うサービスアカウントを解決できません（GMAIL_DELEGATE_SA を設定してください）",
      "delegate_unresolved"
    );
  }

  async send(userEmail: string, raw: string, _idempotencyKey: string) {
    const base = await this.baseToken();
    const delegate = await this.resolveDelegate();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: delegate,
      sub: this.senderEmail,          // 代理する送信元メールボックス
      scope: GMAIL_SEND_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    };
    const signed = await this.fetchImpl(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(delegate)}:signJwt`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${base}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: JSON.stringify(claims) })
      }
    );
    const signedPayload = await signed.json().catch(() => null) as
      { signedJwt?: unknown; error?: { message?: unknown } } | null;
    if (!signed.ok || typeof signedPayload?.signedJwt !== "string") {
      const detail = String(signedPayload?.error?.message ?? "").slice(0, 300);
      throw new GmailApiError(
        `signJwt failed: ${signed.status}${detail ? ` — ${detail}` : ""}` +
          `（${delegate} への roles/iam.serviceAccountTokenCreator を確認）`,
        "sign_jwt_failed", signed.status
      );
    }
    const exchanged = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedPayload.signedJwt
      }).toString()
    });
    const tokenPayload = await exchanged.json().catch(() => null) as
      { access_token?: unknown; error?: unknown; error_description?: unknown } | null;
    if (!exchanged.ok || typeof tokenPayload?.access_token !== "string") {
      const detail = [tokenPayload?.error, tokenPayload?.error_description]
        .filter(Boolean).map(String).join(": ").slice(0, 300);
      throw new GmailApiError(
        `token exchange failed: ${exchanged.status}${detail ? ` — ${detail}` : ""}` +
          `（Workspace のドメイン全体委任に ${delegate} のクライアントIDと gmail.send スコープがあるか確認）`,
        "token_exchange_failed", exchanged.status
      );
    }
    return postGmailSend(this.fetchImpl, tokenPayload.access_token, userEmail, raw);
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
