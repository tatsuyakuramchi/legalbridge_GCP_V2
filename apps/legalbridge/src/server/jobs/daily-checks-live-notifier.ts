import type { DailyChecksNotifier, DailyChecksNotification } from "./daily-checks-runner.js";
import type { MatterSlackChannelAdapter } from "../integrations/slack-matter-channel.js";
import {
  notificationIdForLedgerKind, type NotificationId, type ResolvedNotification
} from "../../notification-settings.js";

// daily-checks の実送信ノーティファイア（Phase 9-1c）。督促を Slack へ 1通のダイジェストとして
// 投稿する（スパム回避）。投稿成功で全件 delivered＝台帳へ記録、失敗で全件未達＝記録せず次回再送。
//
// 宛先と ON/OFF は設定画面（通知ごと）から解決する。1回の実行に納期アラートと契約更新アラートが
// 混ざるため、宛先ごとに束ねて投稿する（別々のチャンネルを指定できる）。
// OFF の通知は投稿も台帳記録もしない＝再度 ON にしたときに、その時点でまだ条件に合うものだけが飛ぶ。

export type NotificationResolver = (id: NotificationId) => ResolvedNotification;

export class LiveDailyChecksNotifier implements DailyChecksNotifier {
  readonly mode = "live" as const;
  constructor(
    private readonly channel: MatterSlackChannelAdapter,
    // 通知種別ごとの宛先・ON/OFF（呼び出し時解決＝設定変更が次の実行から効く）。
    private readonly resolve: NotificationResolver
  ) {}

  async send(notifications: DailyChecksNotification[]): Promise<{ delivered: DailyChecksNotification[]; failed: number }> {
    if (!notifications.length) return { delivered: [], failed: 0 };

    // 宛先チャンネルごとに束ねる。OFF・宛先未設定のものはここで落ちる。
    const byChannel = new Map<string, DailyChecksNotification[]>();
    for (const notification of notifications) {
      const id = notificationIdForLedgerKind(notification.kind);
      if (!id) continue;
      const setting = this.resolve(id);
      if (!setting.enabled || !setting.channelId) continue;
      const bucket = byChannel.get(setting.channelId);
      if (bucket) bucket.push(notification);
      else byChannel.set(setting.channelId, [notification]);
    }
    if (!byChannel.size) return { delivered: [], failed: 0 };

    const delivered: DailyChecksNotification[] = [];
    let failed = 0;
    for (const [channelId, items] of byChannel) {
      const header = `:bell: 本日の督促（${items.length}件）`;
      const body = items.map((n) => `• ${n.text}`).join("\n");
      try {
        await this.channel.postMessage({ channel: channelId, text: `${header}\n${body}` });
        delivered.push(...items);
      } catch {
        // 1つのチャンネルの失敗で他の宛先を巻き添えにしない（成功分は台帳へ記録される）。
        failed += items.length;
      }
    }
    return { delivered, failed };
  }
}
