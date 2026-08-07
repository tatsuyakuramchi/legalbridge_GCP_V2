import type { SlackWebApiClient } from "./slack-web-api-adapter.js";

// 案件ごとの「法務相談スレッド」用 Slack 連携（V1 の matter Slack パネル相当）。
// 既存の DM 通知パイプライン（slack-delivery-adapter）とは別能力：固定チャンネルへ
// ルート投稿し、thread_ts で返信を積み、staff の slack_user_id で <@id> メンションする。

export interface MatterSlackPostResult {
  channel: string;
  ts: string;
}

export interface MatterSlackReply {
  ts: string;
  user: string | null;
  text: string;
  bot: boolean;
}

export interface MatterSlackChannelAdapter {
  readonly configured: boolean;
  // チャンネルへ投稿（thread_ts 指定時はスレッド返信）。
  postMessage(input: { channel: string; text: string; threadTs?: string }): Promise<MatterSlackPostResult>;
  // スレッドの会話を取得。
  getReplies(input: { channel: string; ts: string }): Promise<MatterSlackReply[]>;
}

// 未設定（bot token / チャンネル未設定）時の実装。呼ばれても安全側で失敗する。
export class LocalMatterSlackChannelAdapter implements MatterSlackChannelAdapter {
  readonly configured = false;
  async postMessage(): Promise<MatterSlackPostResult> {
    throw new Error("Matter Slack channel is not configured");
  }
  async getReplies(): Promise<MatterSlackReply[]> {
    throw new Error("Matter Slack channel is not configured");
  }
}

export class WebApiMatterSlackChannelAdapter implements MatterSlackChannelAdapter {
  readonly configured = true;
  constructor(private readonly client: SlackWebApiClient) {}

  async postMessage(input: { channel: string; text: string; threadTs?: string }) {
    const posted = await this.client.post("chat.postMessage", {
      channel: input.channel,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false
    }) as { channel?: unknown; ts?: unknown };
    if (typeof posted.ts !== "string" || !/^\d+\.\d+$/.test(posted.ts)) {
      throw new Error("Slack chat.postMessage returned an invalid ts");
    }
    return { channel: typeof posted.channel === "string" ? posted.channel : input.channel, ts: posted.ts };
  }

  async getReplies(input: { channel: string; ts: string }) {
    const result = await this.client.post("conversations.replies", {
      channel: input.channel,
      ts: input.ts,
      limit: 200
    }) as { messages?: unknown };
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return messages.map((raw) => {
      const m = raw as Record<string, unknown>;
      return {
        ts: typeof m.ts === "string" ? m.ts : "",
        user: typeof m.user === "string" ? m.user : null,
        text: typeof m.text === "string" ? m.text : "",
        bot: typeof m.bot_id === "string" && m.bot_id.length > 0
      };
    });
  }
}

// ── 純関数：メンション組み立て ─────────────────────────────────────────────

const SLACK_USER_ID = /^[UW][A-Z0-9]{8,}$/;

export function isSlackUserId(value: string): boolean {
  return SLACK_USER_ID.test(value.trim());
}

// slack_user_id を <@id> トークンへ。無効IDは除外する。
export function mentionTokens(ids: string[]): string[] {
  return ids
    .map((id) => id.trim())
    .filter((id) => isSlackUserId(id))
    .map((id) => `<@${id}>`);
}

// 先頭テキスト＋メンション（＋任意の末尾テキスト）を1行に組み立てる。
export function composeMentionMessage(
  leadText: string,
  ids: string[],
  options: { trailing?: string; joiner?: string } = {}
): string {
  const joiner = options.joiner ?? " ";
  const mentions = mentionTokens(ids).join(joiner);
  const parts = [leadText.trim(), mentions].filter((p) => p.length > 0);
  let text = parts.join(" ");
  if (options.trailing && options.trailing.trim()) {
    text += `\n${options.trailing.trim()}`;
  }
  return text;
}

// 法務相談スレッドのルート文言（V1 準拠）。
export function buildThreadRootText(input: {
  matterCode: string | null;
  matterId: number;
  title: string;
  counterparty: string;
}): string {
  const label = input.matterCode ?? `#${input.matterId}`;
  const counterparty = input.counterparty?.trim() ? `｜相手方: ${input.counterparty.trim()}` : "";
  return `:memo: 法務相談スレッド ${label}｜*${input.title}*${counterparty}`;
}
