import { SECRET_FIELDS, type SecretKey } from "./secrets-fields.js";
import type { SecretStore } from "./secret-store.js";

// 秘密情報のランタイム解決（Phase 2-5・設定画面からのキー投入の即時反映用）。
// RuntimeIntegrationSettings と同じ同期スナップショット方式：
//   - get() は同期（リクエスト処理を Secret Manager 呼び出しでブロックしない）。
//   - スナップショットが ttlMs より古ければ裏で refresh()（60秒以内に全インスタンスへ伝播）。
//   - 保存成功時は onSaved フック経由で即時 refresh()。
//   - Secret Manager 側に値が無い／取得失敗のキーは env（起動時の値）へフォールバック。
// 有効/無効の判定（live/disabled・ゲート）は従来どおり起動時 config のまま。ここで差し替わるのは
// 「すでに有効な連携が使う値」だけ（＝キーのローテーションが再デプロイなしで効く）。

export type SecretValues = Record<SecretKey, string>;

export class RuntimeSecrets {
  private snapshot: SecretValues;
  private loadedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly env: SecretValues,
    private readonly store?: SecretStore,
    private readonly ttlMs = 60_000
  ) {
    this.snapshot = { ...env };
  }

  get(key: SecretKey): string {
    if (this.store && Date.now() - this.loadedAt > this.ttlMs) {
      void this.refresh().catch(() => { /* 失敗時は現行スナップショットを維持 */ });
    }
    return this.snapshot[key] ?? "";
  }

  async refresh(): Promise<void> {
    if (!this.store) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const next: SecretValues = { ...this.env };
      for (const field of SECRET_FIELDS) {
        try {
          const value = await this.store!.access(field.secretName);
          if (value && value.trim()) next[field.key] = value.trim();
        } catch {
          // このキーだけ現行値を維持（他キーの更新は続行）。
          next[field.key] = this.snapshot[field.key] ?? this.env[field.key];
        }
      }
      this.snapshot = next;
      this.loadedAt = Date.now();
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }
}
