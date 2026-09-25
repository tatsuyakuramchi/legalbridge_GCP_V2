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
  /** 隠しの写し。相手には見えない。 */
  bcc?: string[] | null;
  subject?: string | null;
  body: string;
  /** 添付。CloudSign は必須、Gmail は任意。1枚だけのときはこちら。 */
  attachment?: Attachment | null;
  /** 添付が複数のとき（発注書を何枚か、発注書と検収書を1通で）。 */
  attachments?: Attachment[] | null;
  /**
   * CloudSign の署名者。順番に署名を求める（order）。
   * 空なら recipient を1人の署名者として扱う。
   */
  participants?: Array<{ email: string; name?: string | null;
                         organization?: string | null; order?: number }> | null;
  /** CloudSign の確認者・CC（reportees）。署名はしないが書類を見られる。 */
  reportees?: Array<{ email: string; name?: string | null }> | null;
  /** 外部側の参照（スレッド返信など）。 */
  threadRef?: string | null;
}

export interface Attachment { filename: string; mimeType: string; data: Buffer }

/** 添付の一覧。1枚だけの書き方と複数の書き方の両方を受ける。 */
export const attachmentsOf = (request: DispatchRequest): Attachment[] =>
  (request.attachments?.length ? request.attachments
    : request.attachment ? [request.attachment] : []);

/** 実際に届く宛先すべて。許可リストの照合に使う（cc・bcc も外へ届く）。 */
export function everyRecipient(request: DispatchRequest): string[] {
  return [
    ...String(request.recipient ?? "").split(/[,;]/),
    ...(request.cc ?? []), ...(request.bcc ?? []),
    ...(request.participants ?? []).map((p) => p.email),
    ...(request.reportees ?? []).map((r) => r.email)
  ].map((v) => String(v ?? "").trim()).filter(Boolean);
}

export interface DispatchReceipt {
  /** 外部サービス側のID。監査記録に残す。 */
  externalId: string;
  threadRef?: string | null;
  /** 相手にはまだ届いていない（CloudSign に下書きを作っただけ）。 */
  draft?: boolean;
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
    // bcc は本文（RFC822）に書かない。書くと相手に見える。Gmail API は
    // Bcc ヘッダを見て配送し、受信側には渡さないので、ヘッダには入れる。
    const bcc = (request.bcc ?? []).map((v) => v.trim()).filter(Boolean);
    const headers = [
      `From: ${this.sender}`,
      `To: ${request.recipient}`,
      ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
      ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
      `Subject: =?UTF-8?B?${Buffer.from(request.subject ?? "").toString("base64")}?=`,
      "MIME-Version: 1.0"
    ];
    const files = attachmentsOf(request);
    const mime = files.length
      ? [
          ...headers,
          `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
          `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", request.body, "",
          // 添付は何枚でも。発注書を数枚、発注書と検収書を1通で、という送り方をする。
          ...files.flatMap((file) => [
            `--${boundary}`,
            `Content-Type: ${file.mimeType}; name="${file.filename}"`,
            "Content-Transfer-Encoding: base64",
            `Content-Disposition: attachment; filename="${file.filename}"`, "",
            file.data.toString("base64"), ""
          ]),
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

/**
 * CloudSign。書類を作って参加者を付ける。
 *
 * 既定は**下書きで止める**。相手へ送るのは人が CloudSign の画面で中身を見て
 * からにする（発注書の宛名に余計な文字が入ったまま相手に届いた、を二度と
 * 起こさない）。台帳には「下書きあり」と残り、送ったら人が「送信済」を記録する。
 * autoSend を立てると、作ったその場で送る（以前の動き）。
 */
export class CloudSignAdapter implements DispatchAdapter {
  readonly channel = "cloudsign";
  constructor(
    private readonly clientId: string,
    private readonly baseUrl = "https://api.cloudsign.jp",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: { autoSend?: boolean } = {}
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
    const files = attachmentsOf(request);
    if (!files.length) throw new Error("CloudSign には送信する書類が必要です");
    const token = await this.token();
    const auth = { Authorization: `Bearer ${token}` };
    const form = (fields: Record<string, string | undefined>) =>
      new URLSearchParams(
        Object.entries(fields).filter(([, v]) => v !== undefined && v !== "") as [string, string][]
      ).toString();

    const created = await this.fetchImpl(`${this.baseUrl}/documents`, {
      method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: form({ title: request.subject ?? files[0].filename })
    });
    if (!created.ok) return fail("CloudSign", created);
    const document = await created.json() as { id?: string };
    const documentId = String(document.id ?? "");

    // 書類は何枚でも同じ封筒に入れられる（発注書を数枚、発注書と検収書を1式で）。
    for (const file of files) {
      const body = new FormData();
      body.append("uploadfile",
        new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename);
      const added = await this.fetchImpl(`${this.baseUrl}/documents/${documentId}/files`,
        { method: "POST", headers: auth, body });
      if (!added.ok) return fail("CloudSign", added);
    }

    // 署名者。order で署名の順番が決まる。指定が無ければ recipient を1人だけ。
    const signers = request.participants?.length
      ? request.participants
      : [{ email: request.recipient, name: request.recipient }];
    for (const [index, signer] of signers.entries()) {
      const added = await this.fetchImpl(`${this.baseUrl}/documents/${documentId}/participants`, {
        method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        body: form({
          email: signer.email, name: signer.name ?? signer.email,
          organization: signer.organization ?? undefined,
          order: String(signer.order ?? index + 1)
        })
      });
      if (!added.ok) return fail("CloudSign", added);
    }

    // 確認者・CC。署名はしないが書類を見られる（CloudSign の reportees）。
    for (const reportee of request.reportees ?? []) {
      const added = await this.fetchImpl(`${this.baseUrl}/documents/${documentId}/reportees`, {
        method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        body: form({ email: reportee.email, name: reportee.name ?? reportee.email })
      });
      if (!added.ok) return fail("CloudSign", added);
    }

    const raw = { documentId, files: files.length, signers: signers.length,
                  reportees: (request.reportees ?? []).length };
    if (!this.options.autoSend) {
      // 下書きのまま置く。送信は CloudSign の画面から。
      return { externalId: documentId, draft: true, raw: { ...raw, draft: true } };
    }
    const sent = await this.fetchImpl(`${this.baseUrl}/documents/${documentId}`, {
      method: "POST", headers: auth
    });
    if (!sent.ok) return fail("CloudSign", sent);
    return { externalId: documentId, raw };
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

  /**
   * 課題の一覧を読む（受付箱の取得に使う）。書き込みはしない。
   * 失敗は例外にする。空の配列を返すと「課題が0件」と区別できず、栞を進めてしまう。
   */
  async listIssues(params: Record<string, string | number>): Promise<BacklogIssue[]> {
    const query = new URLSearchParams({ apiKey: this.apiKey });
    query.append("projectId[]", this.projectId);
    for (const [k, v] of Object.entries(params)) query.append(k, String(v));
    const response = await this.fetchImpl(`https://${this.host}/api/v2/issues?${query.toString()}`);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Backlog の課題一覧を読めませんでした (${response.status}): ${detail}`);
    }
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Backlog の課題一覧が配列ではありません");
    return body as BacklogIssue[];
  }
}

/** Backlog の課題（受付箱で使う項目だけ）。 */
export interface BacklogIssue {
  id: number;
  issueKey: string;
  summary?: string | null;
  description?: string | null;
  issueType?: { name?: string | null } | null;
  status?: { name?: string | null } | null;
  createdUser?: { name?: string | null } | null;
  dueDate?: string | null;
  created?: string | null;
  updated?: string | null;
  customFields?: Array<{ name?: string | null; value?: unknown }> | null;
}

/** 課題を読む口。本物は BacklogAdapter、手元とテストは MemoryBacklogReader。 */
export interface BacklogReader {
  readonly configured: boolean;
  listIssues(params: Record<string, string | number>): Promise<BacklogIssue[]>;
}

/** 手元とテスト用。渡した課題を更新順に、ページで切って返す。 */
export class MemoryBacklogReader implements BacklogReader {
  readonly configured = true;
  readonly calls: Array<Record<string, string | number>> = [];
  constructor(public issues: BacklogIssue[] = []) {}
  async listIssues(params: Record<string, string | number>): Promise<BacklogIssue[]> {
    this.calls.push(params);
    const offset = Number(params.offset ?? 0);
    const count = Number(params.count ?? 100);
    const sorted = [...this.issues].sort((a, b) =>
      String(a.updated ?? "").localeCompare(String(b.updated ?? "")));
    return sorted.slice(offset, offset + count);
  }
}

/** 送らずに記録だけ残す。未設定の環境とテストで使う。 */
export class MemoryAdapter implements DispatchAdapter {
  readonly configured = true;
  readonly sent: DispatchRequest[] = [];
  constructor(readonly channel: string) {}
  async send(request: DispatchRequest): Promise<DispatchReceipt> {
    this.sent.push(request);
    // CloudSign は本物も下書きで止めるので、手元でも同じ形にしておく。
    return { externalId: `${this.channel}-${this.sent.length}`, threadRef: null,
             ...(this.channel === "cloudsign" ? { draft: true } : {}) };
  }
}
