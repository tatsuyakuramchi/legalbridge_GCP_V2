import { createHash } from "node:crypto";

/**
 * 外部サービスのアダプタ。V2 から HTTP の呼び方を移植しつつ、
 * V3 では「送る」インターフェースを1本に揃える。
 * 実装が無い環境では Memory 版に差し替えて、送らずに記録だけ残す。
 */

export interface DispatchRequest {
  /** 宛先。メールアドレス／SlackチャンネルID／CloudSignの参加者など。 */
  recipient: string;
  /** 写し。メールだけが使う。担当者を cc に入れて、やり取りが見えるようにする。 */
  cc?: string[] | null;
  subject?: string | null;
  body: string;
  /** 添付。CloudSign は必須、Gmail は任意。 */
  attachment?: { filename: string; mimeType: string; data: Buffer } | null;
  /** 外部側の参照（スレッド返信など）。 */
  threadRef?: string | null;
}

export interface DispatchReceipt {
  /** 外部サービス側のID。監査記録に残す。 */
  externalId: string;
  threadRef?: string | null;
  raw?: Record<string, unknown>;
}

export interface DispatchAdapter {
  readonly channel: string;
  readonly configured: boolean;
  send(request: DispatchRequest): Promise<DispatchReceipt>;
}

const fail = async (channel: string, response: Response): Promise<never> => {
  const detail = (await response.text()).slice(0, 500);
  throw new Error(`${channel} への送信に失敗しました (${response.status}): ${detail}`);
};

/** Slack。chat.postMessage のみを使う（V2 の Web API アダプタから必要部分を移植）。 */
export class SlackAdapter implements DispatchAdapter {
  readonly channel = "slack";
  constructor(private readonly botToken: string, private readonly fetchImpl: typeof fetch = fetch) {}
  get configured() { return /^xoxb-[A-Za-z0-9-]+$/.test(this.botToken); }

  async send(request: DispatchRequest): Promise<DispatchReceipt> {
    const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel: request.recipient,
        text: request.body,
        ...(request.threadRef ? { thread_ts: request.threadRef } : {})
      })
    });
    if (!response.ok) return fail("Slack", response);
    const body = await response.json() as { ok?: boolean; error?: string; ts?: string; channel?: string };
    // Slack は HTTP 200 でも ok:false でエラーを返す。ここを見落とすと送れていないのに成功になる。
    if (!body.ok) throw new Error(`Slack への送信に失敗しました: ${body.error ?? "unknown"}`);
    return { externalId: String(body.ts ?? ""), threadRef: String(body.ts ?? ""), raw: body };
  }
}

/** Gmail。RFC822 を base64url にして users.messages.send へ渡す。 */
export class GmailAdapter implements DispatchAdapter {
  readonly channel = "gmail";
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly sender: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}
  get configured() { return Boolean(this.sender); }

  async send(request: DispatchRequest): Promise<DispatchReceipt> {
    const token = await this.accessToken();
    const boundary = `lb-${createHash("sha1").update(String(Date.now())).digest("hex").slice(0, 16)}`;
    const cc = (request.cc ?? []).map((v) => v.trim()).filter(Boolean);
    const headers = [
      `From: ${this.sender}`,
      `To: ${request.recipient}`,
      ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
      `Subject: =?UTF-8?B?${Buffer.from(request.subject ?? "").toString("base64")}?=`,
      "MIME-Version: 1.0"
    ];
    const mime = request.attachment
      ? [
          ...headers,
          `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
          `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", request.body, "",
          `--${boundary}`,
          `Content-Type: ${request.attachment.mimeType}; name="${request.attachment.filename}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${request.attachment.filename}"`, "",
          request.attachment.data.toString("base64"), "",
          `--${boundary}--`
        ].join("\r\n")
      : [...headers, "Content-Type: text/plain; charset=UTF-8", "", request.body].join("\r\n");

    const response = await this.fetchImpl(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          raw: Buffer.from(mime, "utf8").toString("base64url"),
          ...(request.threadRef ? { threadId: request.threadRef } : {})
        })
      });
    if (!response.ok) return fail("Gmail", response);
    const body = await response.json() as { id?: string; threadId?: string };
    return { externalId: String(body.id ?? ""), threadRef: body.threadId ?? null, raw: body };
  }
}

/** CloudSign。書類を作って参加者を付け、送信する（3手続き）。 */
export class CloudSignAdapter implements DispatchAdapter {
  readonly channel = "cloudsign";
  constructor(
    private readonly clientId: string,
    private readonly baseUrl = "https://api.cloudsign.jp",
    private readonly fetchImpl: typeof fetch = fetch
  ) {}
  get configured() { return Boolean(this.clientId); }

  private async token(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/token?client_id=${encodeURIComponent(this.clientId)}`,
      { method: "POST" });
    if (!response.ok) return fail("CloudSign", response);
    const body = await response.json() as { access_token?: string };
    if (!body.access_token) throw new Error("CloudSign のトークンを取得できませんでした");
    return body.access_token;
  }

  async send(request: DispatchRequest): Promise<DispatchReceipt> {
    if (!request.attachment) throw new Error("CloudSign には送信する書類が必要です");
    const token = await this.token();
    const auth = { Authorization: `Bearer ${token}` };

    const created = await this.fetchImpl(`${this.baseUrl}/documents`, {
      method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: request.subject ?? request.attachment.filename }).toString()
    });
    if (!created.ok) return fail("CloudSign", created);
    const document = await created.json() as { id?: string };
    const documentId = String(document.id ?? "");

    const participants = await this.fetchImpl(`${this.baseUrl}/documents/${documentId}/participants`, {
      method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: request.recipient, name: request.recipient }).toString()
    });
    if (!participants.ok) return fail("CloudSign", participants);

    const sent = await this.fetchImpl(`${this.baseUrl}/documents/${documentId}`, {
      method: "POST", headers: auth
    });
    if (!sent.ok) return fail("CloudSign", sent);
    return { externalId: documentId, raw: { documentId } };
  }
}

/** Backlog。課題を1件立てる。 */
export class BacklogAdapter implements DispatchAdapter {
  readonly channel = "backlog";
  constructor(
    private readonly host: string,
    private readonly apiKey: string,
    private readonly projectId: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}
  get configured() { return Boolean(this.host && this.apiKey && this.projectId); }

  async send(request: DispatchRequest): Promise<DispatchReceipt> {
    const response = await this.fetchImpl(
      `https://${this.host}/api/v2/issues?apiKey=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          projectId: this.projectId,
          summary: request.subject ?? request.body.slice(0, 100),
          description: request.body,
          issueTypeId: request.recipient,   // 課題種別IDを宛先として渡す
          priorityId: "3"
        }).toString()
      });
    if (!response.ok) return fail("Backlog", response);
    const body = await response.json() as { issueKey?: string; id?: number };
    return { externalId: String(body.issueKey ?? body.id ?? ""), raw: body };
  }
}

/** 送らずに記録だけ残す。未設定の環境とテストで使う。 */
export class MemoryAdapter implements DispatchAdapter {
  readonly configured = true;
  readonly sent: DispatchRequest[] = [];
  constructor(readonly channel: string) {}
  async send(request: DispatchRequest): Promise<DispatchReceipt> {
    this.sent.push(request);
    return { externalId: `${this.channel}-${this.sent.length}`, threadRef: null };
  }
}
