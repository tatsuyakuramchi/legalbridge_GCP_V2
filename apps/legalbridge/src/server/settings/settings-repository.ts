import type { DatabasePool } from "../db/pool.js";

// システム設定リポジトリ（Phase 11-1・grant 036）。共有 app_settings（value JSONB）を read/upsert。
// 値は文字列として格納/取得する（JSONB へ JSON 文字列として保存し、pg が JS 値へ復元）。
// 表未整備(42P01)は get で空に縮退（capability OFF でも画面は開ける）。権限不足(42501)は save で throw。

export interface AppSettingsRepository {
  get(keys: string[]): Promise<Record<string, string>>;
  // 与えられた key/value を upsert。記録した件数を返す。
  save(values: Record<string, string>, actor: string): Promise<number>;
}

export class PgAppSettingsRepository implements AppSettingsRepository {
  constructor(private readonly database: DatabasePool) {}

  async get(keys: string[]): Promise<Record<string, string>> {
    if (!keys.length) return {};
    try {
      const r = await this.database.query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [keys]
      );
      const out: Record<string, string> = {};
      for (const row of r.rows) {
        const v = row.value;
        out[row.key] = typeof v === "string" ? v : v == null ? "" : String(v);
      }
      return out;
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return {};   // 表未整備は空
      throw error;
    }
  }

  async save(values: Record<string, string>, _actor: string): Promise<number> {
    const entries = Object.entries(values);
    let n = 0;
    for (const [key, value] of entries) {
      await this.database.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
        [key, JSON.stringify(value ?? "")]
      );
      n++;
    }
    return n;
  }
}

export class MemoryAppSettingsRepository implements AppSettingsRepository {
  constructor(private readonly store: Record<string, string> = {}, private readonly forbidden = false) {}
  async get(keys: string[]) {
    const out: Record<string, string> = {};
    for (const k of keys) if (this.store[k] != null) out[k] = this.store[k];
    return out;
  }
  async save(values: Record<string, string>) {
    if (this.forbidden) { const e = new Error("forbidden"); (e as { code?: string }).code = "42501"; throw e; }
    let n = 0;
    for (const [k, v] of Object.entries(values)) { this.store[k] = v ?? ""; n++; }
    return n;
  }
}
