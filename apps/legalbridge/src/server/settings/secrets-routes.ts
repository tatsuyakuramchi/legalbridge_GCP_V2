import { Router } from "express";
import { z } from "zod";
import { SECRET_FIELDS, findSecretField } from "./secrets-fields.js";
import { SecretStoreError, type SecretStore, type SecretVersionStatus } from "./secret-store.js";

// APIキー投入画面のAPI（Phase 2-5）。設定画面（連携設定）の姉妹ルート。
// 安全方針：
//   - 書き込み専用：GET はメタデータ（登録済みか・版・更新時刻）のみ。値は絶対に返さない。
//   - 保存先は Secret Manager のみ（DB に入れない）。ログにも値を出さない。
//   - admin ロール＋設定書込有効（settings スコープ）でゲート。allowlist（SECRET_FIELDS）外は 400。
//   - live/disabled の切替・env へのマウントは従来どおりデプロイ管理（この画面では扱わない）。

const saveSchema = z.object({
  secrets: z.record(z.string(), z.string().min(1).max(65_536))
});

function adminOnly(role: string | undefined) { return role === "admin"; }

export function createSecretsRouter(
  store: SecretStore | undefined,
  writeEnabled = false,
  // 保存成功後フック（ランタイム秘密情報の即時リフレッシュ用）。
  onSaved?: () => Promise<void> | void
) {
  const router = Router();
  const fields = SECRET_FIELDS.map(({ key, label, hint, secretName, patternHint }) =>
    ({ key, label, hint, secretName, patternHint }));

  router.get("/settings/secrets", async (request, response, next) => {
    try {
      if (!adminOnly(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "管理者のみがAPIキーを管理できます", code: "SECRETS_FORBIDDEN" });
      }
      if (!store) {
        return response.status(200).json({ available: false, fields, statuses: {}, writeEnabled: false });
      }
      const statuses: Record<string, SecretVersionStatus> = {};
      for (const field of SECRET_FIELDS) {
        try {
          statuses[field.key] = await store.status(field.secretName);
        } catch {
          statuses[field.key] = { registered: false };
        }
      }
      return response.status(200).json({ available: true, fields, statuses, writeEnabled });
    } catch (error) { return next(error); }
  });

  router.post("/settings/secrets", async (request, response, next) => {
    try {
      if (!adminOnly(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "管理者のみがAPIキーを管理できます", code: "SECRETS_FORBIDDEN" });
      }
      if (!writeEnabled || !store) {
        return response.status(503).json({ error: "APIキーの保存は未有効化です", code: "SECRETS_WRITE_UNAVAILABLE" });
      }
      const input = saveSchema.parse(request.body ?? {});
      const entries = Object.entries(input.secrets);
      if (entries.length === 0) return response.status(400).json({ error: "保存する値がありません", code: "SECRETS_EMPTY" });
      // 事前検証（allowlist＋形式）。1件でも不正なら保存せず 400（部分保存しない）。
      for (const [key, raw] of entries) {
        const field = findSecretField(key);
        if (!field) return response.status(400).json({ error: `許可されていないキーです: ${key}`, code: "SECRETS_KEY_NOT_ALLOWED" });
        const value = raw.trim();
        if (!value) return response.status(400).json({ error: `${field.label} が空です`, code: "SECRETS_VALUE_EMPTY" });
        if (field.pattern && !field.pattern.test(value)) {
          return response.status(400).json({
            error: `${field.label}: ${field.patternHint ?? "形式が正しくありません"}`, code: "SECRETS_VALUE_INVALID"
          });
        }
      }
      const actor = String(response.locals.currentUser?.email ?? "unknown");
      const results: Record<string, { ok: boolean; version?: string; error?: string }> = {};
      let saved = 0;
      for (const [key, raw] of entries) {
        const field = findSecretField(key)!;
        try {
          const { version } = await store.addVersion(field.secretName, raw.trim());
          results[key] = { ok: true, version };
          saved += 1;
          // 監査ログ（値は絶対に出さない）。
          console.warn(`[secrets] ${actor} updated ${field.secretName} → v${version}`);
        } catch (error) {
          const message = error instanceof SecretStoreError ? error.message : "保存に失敗しました";
          results[key] = { ok: false, error: message };
        }
      }
      if (saved > 0) {
        try { await onSaved?.(); } catch { /* リフレッシュ失敗は保存結果に影響させない */ }
      }
      return response.status(saved === entries.length ? 200 : 207).json({ saved, results });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
