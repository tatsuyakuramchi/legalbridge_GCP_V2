// Gmail 送信アダプタの共通契約。Slack 配信と同じく「ローカル(送信なし)」と
// 「ライブ(Gmail API)」を差し替え可能にし、ゲートで既定OFFを担保する。

export interface GmailAttachment {
  filename: string;           // 添付ファイル名（日本語可・RFC2047でエンコード）
  content: Buffer;            // ファイル本体
  mimeType: string;           // 例: application/pdf
}

export interface GmailDeliveryRequest {
  to: string;                 // 宛先メールアドレス（カンマ区切りで複数可）
  cc?: string;                // CC（カンマ区切りで複数可・任意）
  subject: string;            // 件名（日本語可）
  bodyText: string;           // 本文（プレーンテキスト）
  fromEmail: string;          // 送信元（ドメイン委任で as-user 送信）
  fromName?: string;          // 送信元表示名
  idempotencyKey: string;     // 冪等キー（SHA-256指紋）
  attachments?: GmailAttachment[];  // 添付（あれば multipart/mixed で組む）
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

// カンマ区切りの宛先文字列 → 正規化済みリスト（trim・空除去・大文字小文字を無視して重複除去）。
export function parseRecipientList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of value.split(",")) {
    const email = piece.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

// RFC 2047 でヘッダ（件名・表示名）の非ASCIIをエンコードする。
export function encodeHeaderWord(value: string): string {
  // 全てASCII印字可能ならそのまま返す（アドレス・英数字件名）。
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

// RFC 2045 に合わせて base64 を 76 桁で折り返す（添付はサイズが大きく1行だと壊れうる）。
function base64Lines(buffer: Buffer): string {
  return buffer.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

// RFC 822 メッセージを組み立て、Gmail API 用に base64url へ変換する。
// 添付があるときは multipart/mixed（本文パート + 添付パート）で組む。
export function buildRawMessage(request: GmailDeliveryRequest): string {
  const fromHeader = request.fromName
    ? `${encodeHeaderWord(request.fromName)} <${request.fromEmail}>`
    : request.fromEmail;
  const commonHeaders = [
    `From: ${fromHeader}`,
    `To: ${request.to}`,
    ...(request.cc?.trim() ? [`Cc: ${request.cc}`] : []),
    `Subject: ${encodeHeaderWord(request.subject)}`,
    "MIME-Version: 1.0"
  ];

  let message: string;
  const attachments = request.attachments ?? [];
  if (attachments.length === 0) {
    const headers = [
      ...commonHeaders,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64"
    ];
    const body = Buffer.from(request.bodyText, "utf-8").toString("base64");
    message = `${headers.join("\r\n")}\r\n\r\n${body}`;
  } else {
    // 境界は冪等キー（hex）から決める＝同一送信は常に同一バイト列（テスト・再送検証しやすい）。
    const boundary = `=_lb_${(request.idempotencyKey || "boundary").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "boundary"}`;
    const headers = [
      ...commonHeaders,
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    ];
    const parts = [
      [
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(request.bodyText, "utf-8").toString("base64")
      ].join("\r\n"),
      ...attachments.map((attachment) => [
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${encodeHeaderWord(attachment.filename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${encodeHeaderWord(attachment.filename)}"`,
        "",
        base64Lines(attachment.content)
      ].join("\r\n")),
      `--${boundary}--`
    ];
    message = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n`;
  }
  return Buffer.from(message, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
