import { SlackWebApiError, type SlackWebApiClient } from "./slack-web-api-adapter.js";

// 案件スレッドの会話読取（送信アダプタとは責務を分離）。
// conversations.replies のみを使い、raw payload は client へ返さず正規化する。
// DM スレッドの読取には bot token ＋ im:history が必要（公開/プライベートチャンネルは
// channels:history / groups:history）。scope 不足は missing_scope として明示的に返す。

export interface MatterSlackMessage {
  ts: string;
  authorType: "legalbridge" | "user" | "unknown";
  authorId: string | null;
  text: string;
  isRoot: boolean;
}

export interface SlackThread {
  messages: MatterSlackMessage[];
}

export type SlackReadFailureReason =
  | "rate_limited"
  | "missing_scope"
  | "not_found"
  | "invalid_anchor"
  | "unavailable";

export class SlackConversationReadError extends Error {
  constructor(readonly reason: SlackReadFailureReason, message: string) {
    super(message);
    this.name = "SlackConversationReadError";
  }
}

export interface SlackConversationReader {
  readonly configured: boolean;
  getThread(channelId: string, rootMessageTs: string): Promise<SlackThread>;
}

// Slack のチャンネルID（DM=D / 公開=C / プライベート=G）とメッセージ ts の形式。
const CHANNEL_PATTERN = /^[CDG][A-Z0-9]{6,}$/;
const TS_PATTERN = /^\d+\.\d+$/;

// Slack API のエラーコード → 呼び出し側が分岐できる理由コード。
function toReason(code: string, status: number | null): SlackReadFailureReason {
  if (code === "ratelimited" || status === 429) return "rate_limited";
  if (code === "missing_scope" || code === "not_allowed_token_type") return "missing_scope";
  if (code === "channel_not_found" || code === "thread_not_found" ||
      code === "message_not_found") return "not_found";
  return "unavailable";
}

export class SlackWebApiConversationReader implements SlackConversationReader {
  readonly configured = true;

  constructor(
    private readonly client: SlackWebApiClient,
    // 自bot の user ID。発言者が bot 自身か（LegalBridge の通知か）の判定に使う。
    private readonly botUserId: string | null = null
  ) {}

  async getThread(channelId: string, rootMessageTs: string): Promise<SlackThread> {
    // 不正なアンカーは Slack を叩く前に弾く（無駄な API 消費と曖昧なエラーを防ぐ）。
    if (!CHANNEL_PATTERN.test(channelId) || !TS_PATTERN.test(rootMessageTs)) {
      throw new SlackConversationReadError(
        "invalid_anchor", "Slack スレッドの参照情報が不正です");
    }
    let payload: unknown;
    try {
      payload = await this.client.post("conversations.replies", {
        channel: channelId,
        ts: rootMessageTs,
        limit: 200,
        inclusive: true
      });
    } catch (error) {
      if (error instanceof SlackWebApiError) {
        throw new SlackConversationReadError(
          toReason(error.code, error.status), error.message);
      }
      throw new SlackConversationReadError("unavailable", String(error));
    }
    const raw = (payload as { messages?: unknown }).messages;
    const messages = Array.isArray(raw) ? raw : [];
    return {
      messages: messages
        .map((message) => this.normalize(message, rootMessageTs))
        .filter((message): message is MatterSlackMessage => message !== null)
    };
  }

  // raw payload（blocks 等）は返さず、表示に必要な最小項目だけへ正規化する。
  private normalize(raw: unknown, rootMessageTs: string): MatterSlackMessage | null {
    const message = (raw ?? {}) as Record<string, unknown>;
    const ts = typeof message.ts === "string" ? message.ts : "";
    if (!TS_PATTERN.test(ts)) return null;
    const user = typeof message.user === "string" ? message.user : null;
    const botId = typeof message.bot_id === "string" ? message.bot_id : null;
    const isSelf = Boolean(botId) || (this.botUserId !== null && user === this.botUserId);
    return {
      ts,
      authorType: isSelf ? "legalbridge" : user ? "user" : "unknown",
      authorId: user ?? botId,
      text: typeof message.text === "string" ? message.text : "",
      isRoot: ts === rootMessageTs
    };
  }
}

// 読取が無効（SLACK_CONVERSATION_READ_MODE=disabled）またはトークン未設定のとき。
export class DisabledSlackConversationReader implements SlackConversationReader {
  readonly configured = false;
  async getThread(): Promise<SlackThread> {
    throw new SlackConversationReadError(
      "unavailable", "Slack conversation read is disabled");
  }
}
