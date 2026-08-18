import { Router } from "express";
import { z } from "zod";
import {
  settingsSaveSchema, COMPANY_PROFILE_FIELDS, INTEGRATION_SETTING_FIELDS, ALLOWED_SETTING_KEYS
} from "./settings-schema.js";
import type { AppSettingsRepository } from "./settings-repository.js";
import { NOTIFICATION_DEFINITIONS } from "../../notification-settings.js";
import type { SlackChannelDirectory } from "../integrations/slack-channel-directory.js";

// システム設定（Phase 11-1）。読取（admin のみ・現在値＋フィールド定義）と保存（guarded-write・
// 既定OFF・admin のみ・allowlist キーのみ）。会社プロファイルの自己管理。
function adminOnly(role: string | undefined) { return role === "admin"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "管理者のみが設定を編集できます", code: "SETTINGS_FORBIDDEN" });
}

export function createSettingsRouter(
  repository: AppSettingsRepository | undefined,
  writeEnabled = false,
  // 連携設定の実効値（env/ランタイム由来・空欄時のフォールバック表示用）。秘密は含めないこと。
  integrationEffective: Record<string, string> = {},
  // 保存成功後フック（ランタイム設定の即時リフレッシュ用）。失敗しても保存応答は成功のまま。
  onSaved?: () => Promise<void> | void,
  // 通知タブ用（任意）。宛先が空欄のときに実際に使われるチャンネルと、選択UIの一覧取得元。
  notifications?: {
    fallbackChannel?: () => string;
    channels?: SlackChannelDirectory;
  }
) {
  const router = Router();
  const keys = [...ALLOWED_SETTING_KEYS];

  // 現在の会社プロファイル＋フィールド定義（ラベル）を返す。読取＝admin のみ。
  router.get("/settings", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "settings is not available", code: "SETTINGS_UNAVAILABLE" });
      if (!adminOnly(response.locals.currentUser?.role)) return forbidden(response);
      const values = await repository.get(keys);
      return response.status(200).json({
        fields: COMPANY_PROFILE_FIELDS,
        integrationFields: INTEGRATION_SETTING_FIELDS,
        integrationEffective,
        notificationDefinitions: NOTIFICATION_DEFINITIONS,
        // 宛先未設定のときに実際に使われるチャンネル（画面の「既定の宛先」表示用）。
        notificationFallbackChannel: notifications?.fallbackChannel?.() ?? "",
        values,
        writeEnabled
      });
    } catch (error) { return next(error); }
  });

  // 宛先チャンネルの選択肢（Slack conversations.list）。取得できない環境・スコープ不足でも
  // 200 を返し、画面はチャンネルID直接入力へ落とす（設定できなくなる方が困る）。
  router.get("/settings/slack-channels", async (_request, response, next) => {
    try {
      if (!adminOnly(response.locals.currentUser?.role)) return forbidden(response);
      if (!notifications?.channels) {
        return response.status(200).json({
          available: false, channels: [], truncated: false,
          reason: "Slack 連携が有効ではないため、チャンネル一覧を取得できません。"
        });
      }
      return response.status(200).json(await notifications.channels.list());
    } catch (error) { return next(error); }
  });

  // 会社プロファイルの保存（guarded・allowlist キーのみ）。
  router.post("/settings", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "settings write is not enabled", code: "SETTINGS_WRITE_UNAVAILABLE" });
      }
      if (!adminOnly(response.locals.currentUser?.role)) return forbidden(response);
      const input = settingsSaveSchema.parse(request.body ?? {});
      const actor = String(response.locals.currentUser?.email ?? "unknown");
      try {
        const saved = await repository.save(input.settings, actor);
        try { await onSaved?.(); } catch { /* リフレッシュ失敗は保存成功に影響させない */ }
        const values = await repository.get(keys);
        return response.status(200).json({ saved, values });
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({ error: "設定書込の権限が付与されていません", code: "SETTINGS_FORBIDDEN_DB" });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
