import type { AppSettingsRepository } from "./settings-repository.js";
import {
  applyIntegrationOverrides, INTEGRATION_SETTING_KEYS,
  type IntegrationOverridableConfig
} from "./integration-overrides.js";
import {
  NOTIFICATION_SETTING_KEYS, resolveNotification,
  type NotificationId, type ResolvedNotification
} from "../../notification-settings.js";

// 連携設定のランタイム解決（デプロイ不要の即時反映）。設定画面で保存された app_settings の値を
// TTL 付きスナップショットとして保持し、各連携の消費箇所が `current()` で毎回参照する。
//   - 保存時は settings ルートの onSaved フックが `refresh()` を呼ぶ＝同一インスタンスは即時反映。
//   - 他インスタンスは TTL（既定60秒）経過後の最初のアクセスでバックグラウンド更新＝約1分以内に追随。
//   - DB 不通・表未整備は env 値（起動時スナップショット）のまま＝連携を止めない。
//   - `current()` は同期（Express の非 async 経路や getter からも使える）。

export type IntegrationValues = IntegrationOverridableConfig;

export class RuntimeIntegrationSettings {
  private snapshot: IntegrationValues;
  // 定期通知の設定（宛先・ON/OFF）。env フォールバックは無く、未保存は既定値（ON・法務相談CH）。
  private notificationValues: Record<string, string> = {};
  private loadedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly env: IntegrationValues,
    private readonly repository?: AppSettingsRepository,
    private readonly ttlMs = 60_000
  ) {
    this.snapshot = { ...env };
  }

  current(): IntegrationValues {
    if (this.repository && !this.refreshing && Date.now() - this.loadedAt >= this.ttlMs) {
      // 期限切れはバックグラウンド更新（呼び出しは現スナップショットで即応答）。
      void this.refresh();
    }
    return this.snapshot;
  }

  // 定期通知1件分の実効設定。宛先が空欄なら法務相談チャンネルへ落とす（従来の挙動）。
  // current() と同じスナップショットを見るので、TTL・保存時リフレッシュもそのまま効く。
  notification(id: NotificationId): ResolvedNotification {
    const values = this.current();
    return resolveNotification(this.notificationValues, id, values.slackLegalConsultChannel);
  }

  // 設定画面の表示用（保存済みの生値）。未保存キーは含まない。
  notificationValuesSnapshot(): Record<string, string> {
    this.current();
    return { ...this.notificationValues };
  }

  async refresh(): Promise<void> {
    if (!this.repository) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const values = await this.repository!.get([
          ...INTEGRATION_SETTING_KEYS, ...NOTIFICATION_SETTING_KEYS
        ]);
        const next: IntegrationValues = { ...this.env };
        applyIntegrationOverrides(next, values);
        this.snapshot = next;
        const notifications: Record<string, string> = {};
        for (const key of NOTIFICATION_SETTING_KEYS) {
          const value = String(values[key] ?? "").trim();
          if (value) notifications[key] = value;
        }
        this.notificationValues = notifications;
      } catch (error) {
        console.warn(
          "[settings] runtime integration refresh failed; keeping current values:",
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        this.loadedAt = Date.now();
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
