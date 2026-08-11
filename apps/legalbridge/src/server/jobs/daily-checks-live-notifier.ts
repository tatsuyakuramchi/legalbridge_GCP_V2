import type { DailyChecksNotifier, DailyChecksNotification } from "./daily-checks-runner.js";
import type { MatterSlackChannelAdapter } from "../integrations/slack-matter-channel.js";

// daily-checks の実送信ノーティファイア（Phase 9-1c）。督促を Slack の法務相談チャンネルへ
// 1通のダイジェストとして投稿する（スパム回避）。投稿成功で全件 delivered＝台帳へ記録、
// 失敗で全件未達＝記録せず次回再送。宛先DM（申請者個別）は将来拡張（要 email→Slack ID 解決）。
export class LiveDailyChecksNotifier implements DailyChecksNotifier {
  readonly mode = "live" as const;
  constructor(
    private readonly channel: MatterSlackChannelAdapter,
    // チャンネルは関数でも受ける（連携設定のランタイム反映・呼び出し時解決）。
    private readonly channelId: string | (() => string)
  ) {}

  async send(notifications: DailyChecksNotification[]): Promise<{ delivered: DailyChecksNotification[]; failed: number }> {
    if (!notifications.length) return { delivered: [], failed: 0 };
    const channelId = typeof this.channelId === "function" ? this.channelId() : this.channelId;
    if (!channelId) return { delivered: [], failed: notifications.length };
    const header = `:bell: 本日の督促（${notifications.length}件）`;
    const body = notifications.map((n) => `• ${n.text}`).join("\n");
    try {
      await this.channel.postMessage({ channel: channelId, text: `${header}\n${body}` });
      return { delivered: [...notifications], failed: 0 };
    } catch {
      return { delivered: [], failed: notifications.length };
    }
  }
}
