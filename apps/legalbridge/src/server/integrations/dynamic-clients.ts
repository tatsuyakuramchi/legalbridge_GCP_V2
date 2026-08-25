import {
  BacklogWebApiClient,
  type BacklogReadClient, type BacklogWriteClient,
  type BacklogIssueSummary, type BacklogProjectSummary, type BacklogProjectMetadata
} from "./backlog-web-api.js";
import fs from "node:fs";
import { FetchGmailApiClient, KeylessGmailApiClient, type GmailApiClient } from "./gmail-api-adapter.js";
import { FetchGmailInboundApiClient, type GmailInboundApiClient } from "./gmail-inbound-api-adapter.js";
import {
  FetchSlackWebApiClient, type SlackWebApiClient, type SlackWebApiMethod
} from "./slack-web-api-adapter.js";

// 接続先パラメータを呼び出しごとに解決する動的クライアント（連携設定の即時反映用）。
// 既存クライアントはコンストラクタで host/送信元等を固定するため、設定画面の変更を拾えない。
// ここでは値プロバイダ（RuntimeIntegrationSettings.current() 由来）を受け取り、
// **メソッド呼び出し時**に実クライアントを解決して委譲する（値が変われば作り直す）。

export class DynamicBacklogClient implements BacklogReadClient, BacklogWriteClient {
  private cached: { key: string; client: BacklogWebApiClient } | null = null;

  constructor(
    private readonly connection: () => { host: string; projectKey: string },
    // 関数を渡すと呼び出し毎に解決する（APIキーのローテーション対応・Phase 2-5）。
    private readonly apiKey: string | (() => string),
    private readonly fetchImpl?: typeof globalThis.fetch
  ) {}

  private client(): BacklogWebApiClient {
    const { host, projectKey } = this.connection();
    if (!host || !projectKey) {
      throw new Error("Backlog host / project key is not configured（設定画面の連携設定を確認）");
    }
    const apiKey = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
    if (!apiKey) {
      throw new Error("Backlog API key is not configured（設定画面のAPIキーを確認）");
    }
    const key = `${host} ${projectKey} ${apiKey}`;
    if (this.cached?.key !== key) {
      this.cached = {
        key,
        client: new BacklogWebApiClient({ host, projectKey, apiKey, fetch: this.fetchImpl })
      };
    }
    return this.cached.client;
  }

  getProject(): Promise<BacklogProjectSummary> { return this.client().getProject(); }
  getIssues(options?: { count?: number; keyword?: string }): Promise<BacklogIssueSummary[]> {
    return this.client().getIssues(options);
  }
  getProjectMetadata(): Promise<BacklogProjectMetadata> { return this.client().getProjectMetadata(); }
  addComment(issueKey: string, content: string): Promise<{ id: number }> {
    return this.client().addComment(issueKey, content);
  }
  createIssue(input: { summary: string; description: string; issueTypeName: string }): Promise<{ issueKey: string }> {
    return this.client().createIssue(input);
  }
}

export class DynamicGmailApiClient implements GmailApiClient {
  private cached: { sender: string; client: GmailApiClient } | null = null;

  constructor(
    private readonly sender: () => string,
    private readonly options: { keyFilePath?: string; delegateSa?: string } = {}
  ) {}

  private client(): GmailApiClient {
    const sender = this.sender();
    if (this.cached?.sender !== sender) {
      // 鍵ファイルが実在するときだけ鍵あり経路。無ければ鍵レス（signJwt によるドメイン
      // 委任・V1 と同じ）。ADC のまま FetchGmailApiClient を使うと SA 自身の名義になり
      // Gmail が「Precondition check failed」で拒否するため、ここで確実に分岐する。
      const keyFile = this.options.keyFilePath?.trim();
      const client: GmailApiClient = keyFile && fs.existsSync(keyFile)
        ? new FetchGmailApiClient(sender, this.options)
        : new KeylessGmailApiClient(sender, this.options.delegateSa ?? "");
      this.cached = { sender, client };
    }
    return this.cached.client;
  }

  send(userEmail: string, raw: string, idempotencyKey: string) {
    return this.client().send(userEmail, raw, idempotencyKey);
  }
}

export class DynamicGmailInboundClient implements GmailInboundApiClient {
  private cached: { mailbox: string; client: FetchGmailInboundApiClient } | null = null;

  constructor(
    private readonly mailbox: () => string,
    private readonly options: { keyFilePath?: string } = {}
  ) {}

  private client(): FetchGmailInboundApiClient {
    const mailbox = this.mailbox();
    if (this.cached?.mailbox !== mailbox) {
      this.cached = { mailbox, client: new FetchGmailInboundApiClient(mailbox, this.options) };
    }
    return this.cached.client;
  }

  listMessageIds(query: string, maxResults: number) { return this.client().listMessageIds(query, maxResults); }
  getMessage(messageId: string) { return this.client().getMessage(messageId); }
  getAttachment(messageId: string, attachmentId: string) { return this.client().getAttachment(messageId, attachmentId); }
}

export class DynamicSlackWebApiClient implements SlackWebApiClient {
  private cached: { token: string; client: FetchSlackWebApiClient } | null = null;

  constructor(
    private readonly token: () => string,
    private readonly fetchImpl?: typeof globalThis.fetch
  ) {}

  private client(): FetchSlackWebApiClient {
    const token = this.token();
    if (this.cached?.token !== token) {
      // 不正・空トークンは FetchSlackWebApiClient のコンストラクタ検証で例外（呼び出し時に顕在化）。
      this.cached = { token, client: new FetchSlackWebApiClient(token, this.fetchImpl) };
    }
    return this.cached.client;
  }

  post(method: SlackWebApiMethod, body: Record<string, unknown>) {
    return this.client().post(method, body);
  }
}
