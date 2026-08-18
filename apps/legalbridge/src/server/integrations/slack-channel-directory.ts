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
    // まず両方まとめて要求する。片方のスコープしか無いと Slack は missing_scope を返して
    // 全部落ちるため、その場合は種別ごとに取り直して「取れる方だけ」出す。
    // （実地：channels:read 無し・groups:read 有りのインストールがあった）
    const both = await this.loadTypes("public_channel,private_channel");
    if (both.ok) return { available: true, channels: sortByName(both.channels), truncated: both.truncated };
    if (both.code !== "missing_scope") {
      return {
        available: false, channels: [], truncated: false,
        reason: `Slack からチャンネル一覧を取得できませんでした（${both.code}）。`
      };
    }
    const publicChannels = await this.loadTypes("public_channel");
    const privateChannels = await this.loadTypes("private_channel");
    if (!publicChannels.ok && !privateChannels.ok) {
      return {
        available: false, channels: [], truncated: false,
        reason: "Slack アプリに channels:read（非公開チャンネルも選ぶ場合は groups:read）が付与されていません。"
      };
    }
    const channels = sortByName([
      ...(publicChannels.ok ? publicChannels.channels : []),
      ...(privateChannels.ok ? privateChannels.channels : [])
    ]);
    // 片方だけ取れた状態を黙って通すと「あるはずのチャンネルが出ない」と見える。理由を残す。
    const missing = !publicChannels.ok ? "公開チャンネル（channels:read）" : "非公開チャンネル（groups:read）";
    return {
      available: true, channels,
      truncated: (publicChannels.ok && publicChannels.truncated) || (privateChannels.ok && privateChannels.truncated),
      reason: `${missing}は一覧に出ません（スコープ未付与）。その場合はチャンネルIDを直接入力してください。`
    };
  }

  private async loadTypes(types: string): Promise<
    { ok: true; channels: SlackChannelSummary[]; truncated: boolean } | { ok: false; code: string }
  > {
    const channels: SlackChannelSummary[] = [];
    let cursor = "";
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let payload: { channels?: unknown; response_metadata?: { next_cursor?: unknown } };
      try {
        payload = await this.client.post("conversations.list", {
          types,
          exclude_archived: true,
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {})
        }) as typeof payload;
      } catch (error) {
        return { ok: false, code: error instanceof SlackWebApiError ? error.code : "unknown_error" };
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
    return { ok: true, channels, truncated };
  }
}

function sortByName(channels: SlackChannelSummary[]): SlackChannelSummary[] {
  return [...channels].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}
