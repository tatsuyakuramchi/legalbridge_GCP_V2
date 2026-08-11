import type { AppSettingsRepository } from "./settings-repository.js";
import {
  applyIntegrationOverrides, INTEGRATION_SETTING_KEYS,
  type IntegrationOverridableConfig
} from "./integration-overrides.js";

// 連携設定のランタイム解決（デプロイ不要の即時反映）。設定画面で保存された app_settings の値を
// TTL 付きスナップショットとして保持し、各連携の消費箇所が `current()` で毎回参照する。
//   - 保存時は settings ルートの onSaved フックが `refresh()` を呼ぶ＝同一インスタンスは即時反映。
//   - 他インスタンスは TTL（既定60秒）経過後の最初のアクセスでバックグラウンド更新＝約1分以内に追随。
//   - DB 不通・表未整備は env 値（起動時スナップショット）のまま＝連携を止めない。
//   - `current()` は同期（Express の非 async 経路や getter からも使える）。

export type IntegrationValues = IntegrationOverridableConfig;

export class RuntimeIntegrationSettings {
  private snapshot: IntegrationValues;
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

  async refresh(): Promise<void> {
    if (!this.repository) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const values = await this.repository!.get(INTEGRATION_SETTING_KEYS);
        const next: IntegrationValues = { ...this.env };
        applyIntegrationOverrides(next, values);
        this.snapshot = next;
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
