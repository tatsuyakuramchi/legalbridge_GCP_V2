import type { SlackWebApiClient } from "./slack-web-api-adapter.js";
import { SlackWebApiError } from "./slack-web-api-adapter.js";

// 通知の宛先チャンネルを選ぶための一覧（設定画面の選択UI用）。conversations.list を使う。
//
// 必要スコープは channels:read（公開チャンネル）と groups:read（非公開チャンネル）。
// どちらも無い状態でインストールされている場合があるため、missing_scope は
// 「一覧が出せないだけ」として扱い、画面はチャンネルID直接入力へ落とす（設定不能にしない）。
//
// 一覧はワークスペース全体で数百件になり得るので、ページングしつつ上限で打ち切り、
// 短時間キャッシュする（設定画面を開くたびに Slack を叩かない）。

export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  /** Bot が参加しているか。未参加のチャンネルには投稿できない（chat.postMessage が not_in_channel）。 */
  isMember: boolean;
}

export interface SlackChannelListing {
  available: boolean;
  channels: SlackChannelSummary[];
  /** available=false のときの理由（画面にそのまま出す）。 */
  reason?: string;
  /** 上限で打ち切ったか（打ち切ったときは検索で足りない可能性を画面に出す）。 */
  truncated: boolean;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 10;          // 最大 2000 件まで
const CACHE_TTL_MS = 300_000;  // 5分

function toSummary(raw: unknown): SlackChannelSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? row.name : "";
  if (!id || !name) return null;
  return {
    id, name,
    isPrivate: row.is_private === true,
    isMember: row.is_member === true
  };
}

export class SlackChannelDirectory {
  private cache: SlackChannelListing | null = null;
  private cachedAt = 0;
  private inflight: Promise<SlackChannelListing> | null = null;

  constructor(
    private readonly client: SlackWebApiClient,
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  async list(): Promise<SlackChannelListing> {
    if (this.cache && this.now() - this.cachedAt < this.ttlMs) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.load()
      .then((listing) => {
        // 取得できなかった場合もキャッシュする（スコープ不足で毎回叩きに行かない）。
        this.cache = listing;
        this.cachedAt = this.now();
        return listing;
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<SlackChannelListing> {
    const channels: SlackChannelSummary[] = [];
    let cursor = "";
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let payload: { channels?: unknown; response_metadata?: { next_cursor?: unknown } };
      try {
        payload = await this.client.post("conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {})
        }) as typeof payload;
      } catch (error) {
        if (error instanceof SlackWebApiError && error.code === "missing_scope") {
          return {
            available: false, channels: [], truncated: false,
            reason: "Slack アプリに channels:read（非公開チャンネルも選ぶ場合は groups:read）が付与されていません。"
          };
        }
        return {
          available: false, channels: [], truncated: false,
          reason: `Slack からチャンネル一覧を取得できませんでした（${
            error instanceof SlackWebApiError ? error.code : "unknown_error"}）。`
        };
      }
      for (const raw of Array.isArray(payload.channels) ? payload.channels : []) {
        const summary = toSummary(raw);
        if (summary) channels.push(summary);
      }
      const next = payload.response_metadata?.next_cursor;
      cursor = typeof next === "string" ? next : "";
      if (!cursor) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    channels.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    return { available: true, channels, truncated };
  }
}
