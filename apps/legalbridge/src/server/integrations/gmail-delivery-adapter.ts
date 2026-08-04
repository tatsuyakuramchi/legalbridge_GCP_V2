// Gmail 送信アダプタの共通契約。Slack 配信と同じく「ローカル(送信なし)」と
// 「ライブ(Gmail API)」を差し替え可能にし、ゲートで既定OFFを担保する。

export interface GmailDeliveryRequest {
  to: string;                 // 宛先メールアドレス
  subject: string;            // 件名（日本語可）
  bodyText: string;           // 本文（プレーンテキスト）
  fromEmail: string;          // 送信元（ドメイン委任で as-user 送信）
  fromName?: string;          // 送信元表示名
  idempotencyKey: string;     // 冪等キー（SHA-256指紋）
}

export interface GmailDeliveryReceipt {
  messageId: string;
  threadId: string | null;
}

export interface GmailDeliveryAdapter {
  readonly configured: boolean;
  send(request: GmailDeliveryRequest): Promise<GmailDeliveryReceipt>;
}

// 送信しないローカル実装。ゲートが integration_local でブロックするため
// send() が呼ばれることは無いが、安全側に倒して明示的に失敗させる。
export class LocalGmailDeliveryAdapter implements GmailDeliveryAdapter {
  readonly configured = false;
  async send(): Promise<GmailDeliveryReceipt> {
    throw new Error("Gmail delivery is in local mode; external send is disabled");
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

// RFC 2047 でヘッダ（件名・表示名）の非ASCIIをエンコードする。
export function encodeHeaderWord(value: string): string {
  // 全てASCII印字可能ならそのまま返す（アドレス・英数字件名）。
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

// RFC 822 メッセージを組み立て、Gmail API 用に base64url へ変換する。
export function buildRawMessage(request: GmailDeliveryRequest): string {
  const fromHeader = request.fromName
    ? `${encodeHeaderWord(request.fromName)} <${request.fromEmail}>`
    : request.fromEmail;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${request.to}`,
    `Subject: ${encodeHeaderWord(request.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64"
  ];
  const body = Buffer.from(request.bodyText, "utf-8").toString("base64");
  const message = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(message, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
