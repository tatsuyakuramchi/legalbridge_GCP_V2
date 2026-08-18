// 定期通知の設定（宛先チャンネル・ON/OFF）。設定画面とジョブの両方が同じ定義を読む。
//
// V2 で実際に配信している定期通知は 3 種類だけで、いずれも Cloud Scheduler が
// /internal/jobs/{daily-checks,inspection-digest} を叩いて Slack へ投稿する。
// これまで宛先は「法務相談チャンネル」1つに固定で、止めたいときはデプロイし直すしか
// なかった。ここで通知ごとに宛先と ON/OFF を持たせ、app_settings 経由で即時反映する。
//
// 値の保存先は app_settings（key/value）。秘密ではないので Secret Manager は使わない。
//   NOTIFY_<ID>_ENABLED = "true" | "false"   （空＝既定値＝ON）
//   NOTIFY_<ID>_CHANNEL = "C0XXXXXXX"        （空＝法務相談チャンネルへ）

export type NotificationId = "delivery_alert" | "contract_alert" | "inspection_digest";

export interface NotificationDefinition {
  id: NotificationId;
  label: string;
  /** 何がいつ飛ぶのかを設定画面でそのまま出す。 */
  description: string;
  /** 実行スケジュール（Cloud Scheduler の設定と一致させる）。 */
  schedule: string;
  enabledKey: string;
  channelKey: string;
}

export const NOTIFICATION_DEFINITIONS: NotificationDefinition[] = [
  {
    id: "delivery_alert",
    label: "納期アラート",
    description: "発注明細の納期が 7日前・3日前・前日になったとき、および納期を過ぎたときに督促します。",
    schedule: "平日 9:00（daily-checks）",
    enabledKey: "NOTIFY_DELIVERY_ALERT_ENABLED",
    channelKey: "NOTIFY_DELIVERY_ALERT_CHANNEL"
  },
  {
    id: "contract_alert",
    label: "契約更新アラート",
    description: "自動更新契約の更新拒絶の通告期限が近づいた契約を知らせます。",
    schedule: "平日 9:00（daily-checks）",
    enabledKey: "NOTIFY_CONTRACT_ALERT_ENABLED",
    channelKey: "NOTIFY_CONTRACT_ALERT_CHANNEL"
  },
  {
    id: "inspection_digest",
    label: "検収待ちダイジェスト",
    description: "検収書が未作成の発注書を一覧で投稿します（毎回全件・件数が多いときは先頭20件）。",
    schedule: "平日 9:05（inspection-digest）",
    enabledKey: "NOTIFY_INSPECTION_DIGEST_ENABLED",
    channelKey: "NOTIFY_INSPECTION_DIGEST_CHANNEL"
  }
];

export const NOTIFICATION_SETTING_KEYS: string[] = NOTIFICATION_DEFINITIONS.flatMap(
  (d) => [d.enabledKey, d.channelKey]
);

export interface ResolvedNotification {
  enabled: boolean;
  /** 実際の投稿先。空文字なら投稿しない（＝法務相談チャンネルも未設定）。 */
  channelId: string;
}

// 空欄は「既定どおり」＝ON。明示的に false を保存したときだけ止める。
// 誤って壊れた値（"" や "yes"）で通知が黙って止まると気づけないため、
// false と読めるものだけを OFF にする。
export function parseEnabled(raw: string | undefined | null): boolean {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return true;
  return !(value === "false" || value === "off" || value === "0" || value === "no");
}

export function resolveNotification(
  values: Record<string, string | undefined>,
  id: NotificationId,
  fallbackChannel: string
): ResolvedNotification {
  const def = NOTIFICATION_DEFINITIONS.find((d) => d.id === id);
  if (!def) return { enabled: false, channelId: "" };
  const channel = String(values[def.channelKey] ?? "").trim();
  return {
    enabled: parseEnabled(values[def.enabledKey]),
    channelId: channel || String(fallbackChannel ?? "").trim()
  };
}

// 宛先チャンネルの絞り込み（設定画面の選択UI）。ワークスペースのチャンネルは数百件になり、
// 目で探すのは現実的でない。名前の部分一致とチャンネルIDの両方で引ける。
// 「#」を付けて打つ人がいるので落とす。大文字小文字は無視する。
export function matchesChannelQuery(
  channel: { id: string; name: string }, query: string
): boolean {
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  if (!needle) return true;
  return channel.name.toLowerCase().includes(needle) || channel.id.toLowerCase().includes(needle);
}

// daily-checks の台帳 kind（delivery_7d / contract_renewal など）から通知種別へ。
// 1 ジョブが 2 種類の通知を出すため、送信直前にここで振り分ける。
export function notificationIdForLedgerKind(kind: string): NotificationId | null {
  if (kind.startsWith("delivery_")) return "delivery_alert";
  if (kind === "contract_renewal") return "contract_alert";
  return null;
}
