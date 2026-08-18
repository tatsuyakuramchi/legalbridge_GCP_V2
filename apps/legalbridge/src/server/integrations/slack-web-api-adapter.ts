import type {
  SlackDeliveryAdapter,
  SlackDeliveryReceipt,
  SlackDeliveryRequest
} from "./slack-delivery-adapter.js";

export type SlackWebApiMethod =
  | "conversations.open"
  | "chat.postMessage"
  | "conversations.replies"
  | "conversations.list"
  | "views.open"
  | "views.update";

export interface SlackWebApiClient {
  post(method: SlackWebApiMethod, body: Record<string, unknown>): Promise<unknown>;
}

export class SlackWebApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null = null,
    readonly retryAfter: string | null = null
  ) {
    super(message);
    this.name = "SlackWebApiError";
  }
}

export class FetchSlackWebApiClient implements SlackWebApiClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(botToken)) {
      throw new Error("A valid Slack bot token is required");
    }
  }

  async post(method: SlackWebApiMethod, body: Record<string, unknown>) {
    // 読み取り系メソッド（conversations.replies 等）は JSON ボディ非対応で、
    // JSON で呼ぶと引数が無視され invalid_arguments になる（実地で確認）。
    // GET＋クエリパラメータで呼ぶ。書込系（chat.postMessage 等）は JSON のまま。
    const isReadMethod = method === "conversations.replies" || method === "conversations.list";
    const response = isReadMethod
      ? await this.fetchImpl(
          `https://slack.com/api/${method}?${new URLSearchParams(
            Object.entries(body)
              .filter(([, value]) => value !== undefined && value !== null)
              .map(([key, value]) => [key, String(value)])
          ).toString()}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${this.botToken}` }
          }
        )
      : await this.fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.botToken}`,
            "Content-Type": "application/json; charset=utf-8"
          },
          body: JSON.stringify(body)
        });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new SlackWebApiError(
        `Slack Web API HTTP error: ${response.status}`,
        "http_error",
        response.status,
        response.headers.get("retry-after")
      );
    }
    if (!payload || payload.ok !== true) {
      const code = typeof payload?.error === "string" ? payload.error : "invalid_response";
      throw new SlackWebApiError(`Slack Web API error: ${code}`, code);
    }
    return payload;
  }
}

export class SlackWebApiDeliveryAdapter implements SlackDeliveryAdapter {
  readonly configured = true;

  constructor(private readonly client: SlackWebApiClient) {}

  async send(request: SlackDeliveryRequest): Promise<SlackDeliveryReceipt> {
    if (!/^[UW][A-Z0-9]{8,}$/.test(request.userId)) {
      throw new Error("Slack delivery requires a valid user ID");
    }
    const clientMessageId = fingerprintToClientMessageId(request.idempotencyKey);
    // 既存スレッドがある場合は conversations.open を省く。ただし宛先の DM チャンネルが
    // 本当にこの相手のものかを必ず確認し、一致しなければ送信しない（fail-closed・§8.4）。
    // requester 差し替え時に他人のスレッドへ投稿する事故を防ぐ。
    const anchorChannelId = typeof request.channelId === "string" ? request.channelId : null;
    const threadTs = typeof request.rootThreadTs === "string" ? request.rootThreadTs : null;
    const reuseThread = Boolean(anchorChannelId && threadTs);

    const opened = await this.client.post("conversations.open", {
      users: request.userId,
      return_im: false
    }) as {
      channel?: { id?: unknown };
    };
    const channelId = opened.channel?.id;
    if (typeof channelId !== "string" || !/^D[A-Z0-9]{8,}$/.test(channelId)) {
      throw new SlackWebApiError(
        "Slack conversations.open returned no valid DM channel",
        "invalid_dm_channel"
      );
    }
    if (reuseThread && anchorChannelId !== channelId) {
      throw new SlackWebApiError(
        "Slack thread anchor does not belong to the current recipient",
        "recipient_thread_mismatch"
      );
    }

    const posted = await this.client.post("chat.postMessage", {
      channel: channelId,
      client_msg_id: clientMessageId,
      text: fallbackText(request),
      blocks: messageBlocks(request),
      unfurl_links: false,
      unfurl_media: false,
      // 2回目以降は既存 root へのスレッド返信。初回は thread_ts なし＝新規 root。
      ...(reuseThread ? { thread_ts: threadTs } : {})
    }) as {
      channel?: unknown;
      ts?: unknown;
    };
    if (posted.channel !== channelId ||
        typeof posted.ts !== "string" ||
        !/^\d+\.\d+$/.test(posted.ts)) {
      throw new SlackWebApiError(
        "Slack chat.postMessage returned an invalid receipt",
        "invalid_message_receipt"
      );
    }
    return {
      channelId,
      messageTs: posted.ts,
      // 返信のときは root ts を返す（履歴のアンカーを案件で一意に保つため）。
      threadRootTs: reuseThread ? (threadTs as string) : posted.ts
    };
  }
}

function fallbackText(request: SlackDeliveryRequest) {
  return truncate(
    `${request.headline}\n${request.body}\n次の行動：${request.nextAction}`,
    4000
  );
}

function messageBlocks(request: SlackDeliveryRequest) {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(request.headline, 150),
        emoji: true
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(request.body, 3000)
      }
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: truncate(`*現在地*：${request.issueKey}\n*次の行動*：${request.nextAction}`, 3000)
      }]
    }
  ];
  const actions = request.actions.slice(0, 5).map((action) => ({
    type: "button",
    action_id: action.id,
    text: {
      type: "plain_text",
      text: truncate(action.label, 75),
      emoji: true
    },
    url: action.url,
    ...(action.style === "primary" ? { style: "primary" } : {})
  }));
  if (actions.length) {
    blocks.push({
      type: "actions",
      block_id: `legalbridge_${request.issueKey}`,
      elements: actions
    });
  }
  return blocks;
}

function fingerprintToClientMessageId(fingerprint: string) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("Slack idempotency key must be a SHA-256 fingerprint");
  }
  const value = fingerprint.slice(0, 32);
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    `4${value.slice(13, 16)}`,
    `a${value.slice(17, 20)}`,
    value.slice(20, 32)
  ].join("-");
}

function truncate(value: string, max: number) {
  const normalized = value.trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}
