/**
 * 検証中の宛先許可リスト（settings の dispatch_allowlist）。
 *
 * もとは .env の DISPATCH_ALLOWLIST だけで、直すたびに app を上げ直していた。設定の画面から
 * 変えられるように、台帳の設定を先に見る。
 *   env  … .env のとおり（既定。設定を作っていないときと同じ）
 *   list … ここに書いた宛先だけに送れる（to・cc・bcc・CloudSign の参加者を全員見る）
 *   open … 制限しない（本番と同じ。誰にでも送れる）
 * 画面（設定タブ）とサーバ（送る前の関所）の両方が読むので、サーバ専用のものは import しない。
 */

export const DISPATCH_ALLOWLIST_KEY = "dispatch_allowlist";

export type AllowlistMode = "env" | "list" | "open";
export interface DispatchAllowlistSettings { mode: AllowlistMode; addresses: string[] }

export const DEFAULT_DISPATCH_ALLOWLIST: DispatchAllowlistSettings = { mode: "env", addresses: [] };

export const ALLOWLIST_MODE_LABEL: Record<AllowlistMode, string> = {
  env: ".env のとおり（DISPATCH_ALLOWLIST）", list: "下の宛先だけに送れる（検証中）", open: "制限しない（本番と同じ）"
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function parseDispatchAllowlist(input: unknown): { value: DispatchAllowlistSettings; errors: string[] } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const errors: string[] = [];
  const mode: AllowlistMode = src.mode === "list" || src.mode === "open" ? src.mode : "env";
  const raw = Array.isArray(src.addresses) ? src.addresses
    : typeof src.addresses === "string" ? src.addresses.split(/[,、;\s]+/) : [];
  const addresses = [...new Set(raw.map((v: unknown) => String(v ?? "").trim().toLowerCase()).filter(Boolean))] as string[];
  for (const a of addresses) if (!EMAIL.test(a)) errors.push(`「${a}」はメールアドレスの形ではありません`);
  if (addresses.length > 50) errors.push("宛先は 50 件までです");
  if (mode === "list" && !addresses.length) errors.push("「下の宛先だけ」にするなら、宛先を 1 つ以上入れてください");
  return { value: { mode, addresses }, errors: [...new Set(errors)] };
}

export function readDispatchAllowlist(stored: unknown): DispatchAllowlistSettings {
  return parseDispatchAllowlist(stored ?? DEFAULT_DISPATCH_ALLOWLIST).value;
}

/** 実際に効く許可リスト。空なら制限しない。 */
export function effectiveAllowlist(setting: DispatchAllowlistSettings, envList: string[]): { allowlist: string[]; source: AllowlistMode } {
  if (setting.mode === "open") return { allowlist: [], source: "open" };
  if (setting.mode === "list") return { allowlist: setting.addresses, source: "list" };
  return { allowlist: envList, source: "env" };
}
