import { createApp } from "./app.js";
import { config } from "./config.js";
import { getPool } from "./db/pool.js";
import { PgAppSettingsRepository } from "./settings/settings-repository.js";
import { applyIntegrationOverrides, loadIntegrationOverrides } from "./settings/integration-overrides.js";

// 起動時に app_settings の連携設定（非秘密・設定画面で編集）を config へ上書きしてから
// アプリを構築する（2-5 UI 化）。DB 不通・表未整備は env 値のまま起動。
const pool = getPool();
if (pool) {
  const values = await loadIntegrationOverrides(new PgAppSettingsRepository(pool));
  const applied = applyIntegrationOverrides(config, values);
  if (applied.length) {
    console.log(`[settings] integration overrides applied from app_settings: ${applied.join(", ")}`);
  }
}

createApp().listen(config.port, () => {
  console.log(`LegalBridge V2 listening on :${config.port}`);
});
