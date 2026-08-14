import { Router } from "express";
import { z } from "zod";
import type { SlackNotificationHistoryRepository } from "../integrations/slack-history-repository.js";
import {
  SlackConversationReadError,
  type SlackConversationReader
} from "../integrations/slack-conversation-reader.js";
import { slackDisplayName, resolveSlackMentions } from "../../slack-mentions.js";
import type { MatterMentionRepository } from "./matter-slack-thread-repository.js";

// 案件の Slack 会話履歴（読取専用・admin/legal 限定）。Matter 詳細 API とは独立させ、
// Slack 側の障害・レート制限が案件画面全体を落とさないようにする（方針 §9）。
// 自動ポーリングは行わず、詳細を開いた時と「更新」操作のときだけ取得する（§7.3）。

const idPath = z.object({ id: z.coerce.number().int().positive() });
const readerAllowed = (role?: string) => role === "admin" || role === "legal";

// 連打抑止のためのサーバ側短期キャッシュ（instance 単位・§14）。
// Redis 等は導入せず、rate limit を踏みにくくすることだけを目的とする。
const CACHE_TTL_MS = 30_000;

export interface MatterSlackHistoryDeps {
  history?: SlackNotificationHistoryRepository;
  reader: SlackConversationReader;
  // 発言者IDを担当者マスタの氏名へ解決する（既存のメンション候補と同じ供給元）。
  mentions?: MatterMentionRepository;
}

export function createMatterSlackHistoryRouter(deps: MatterSlackHistoryDeps) {
  const router = Router();
  const cache = new Map<string, { at: number; payload: unknown }>();

  let names: { at: number; map: Map<string, string> } | null = null;
  async function nameMap(): Promise<Map<string, string>> {
    if (!deps.mentions) return new Map();
    if (names && Date.now() - names.at < 60_000) return names.map;
    try {
      const candidates = await deps.mentions.listCandidates();
      names = { at: Date.now(), map: new Map(candidates.map((c) => [c.id, c.name])) };
      return names.map;
    } catch {
      return names?.map ?? new Map();
    }
  }

  router.get("/matters/:id/slack", async (request, response, next) => {
    try {
      if (!readerAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({
          error: "法務または管理者のみが参照できます", code: "MATTER_SLACK_HISTORY_FORBIDDEN"
        });
      }
      const { id } = idPath.parse(request.params);
      const refresh = String(request.query.refresh ?? "") === "1";

      // 履歴テーブル未有効（通知履歴 OFF）の環境では「未接続」を返して縮退する。
      if (!deps.history) {
        return response.status(200).json({
          configured: deps.reader.configured, linked: false, available: true,
          matterId: id, thread: null, messages: [], deliveries: []
        });
      }
      const anchor = await deps.history.findMatterThreadAnchor(id);
      const deliveries = await deps.history.listMatterDeliveries(id);
      if (!anchor) {
        return response.status(200).json({
          configured: deps.reader.configured, linked: false, available: true,
          matterId: id, thread: null, messages: [], deliveries
        });
      }
      const thread = {
        channelId: anchor.channelId,
        rootMessageTs: anchor.rootMessageTs,
        legacyRootCount: anchor.legacyRootCount
      };
      // 読取が無効なら Slack を叩かず、アンカーと送信履歴だけを返す。
      if (!deps.reader.configured) {
        return response.status(200).json({
          configured: false, linked: true, available: true,
          matterId: id, thread, messages: [], deliveries
        });
      }

      const cacheKey = `${id}:${anchor.channelId}:${anchor.rootMessageTs}`;
      const cached = cache.get(cacheKey);
      if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return response.status(200).json(cached.payload);
      }

      try {
        const [fetched, staffNames] = await Promise.all([
          deps.reader.getThread(anchor.channelId, anchor.rootMessageTs),
          nameMap()
        ]);
        const payload = {
          configured: true, linked: true, available: true,
          matterId: id, thread, deliveries,
          messages: fetched.messages.map((message) => ({
            ...message,
            // 発言者・本文の Slack ユーザーIDは担当者マスタの氏名へ（users.info は使わない）。
            authorName: message.authorType === "legalbridge"
              ? "LegalBridge"
              : slackDisplayName(message.authorId, staffNames) || "不明なユーザー",
            text: resolveSlackMentions(message.text, staffNames)
          })),
          fetchedAt: new Date().toISOString()
        };
        cache.set(cacheKey, { at: Date.now(), payload });
        return response.status(200).json(payload);
      } catch (error) {
        // Slack 側の失敗は 200 ＋ available:false で返す。案件画面を壊さないため（§9）。
        const reason = error instanceof SlackConversationReadError ? error.reason : "unavailable";
        return response.status(200).json({
          configured: true, linked: true, available: false, reason,
          matterId: id, thread, messages: [], deliveries
        });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      return next(error);
    }
  });

  return router;
}
