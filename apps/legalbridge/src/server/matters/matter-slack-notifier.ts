import type { MatterUpdateInput, TaskCreateInput, TaskUpdateInput } from "./write-schema.js";
import type { MatterSlackThreadRepository, MatterMentionRepository } from "./matter-slack-thread-repository.js";
import type { MatterSlackChannelAdapter } from "../integrations/slack-matter-channel.js";
import { mentionTokens } from "../integrations/slack-matter-channel.js";

// 案件イベント連動の自動 Slack 通知（V1 に無い新規）。案件/タスクの書込後に、
// スレッドが存在すれば変更サマリを投稿し、担当変更時は新担当を @メンションする。
// best-effort：スレッド未作成・無効・投稿失敗のいずれでも書込処理は妨げない。

export interface MatterEventNotification {
  text: string;
  mentionStaffIds: number[];
}

// 案件更新の入力から1件の通知を導出（変更項目をまとめる）。担当変更時は新担当をメンション。
export function deriveMatterUpdateNotification(input: MatterUpdateInput): MatterEventNotification | null {
  const parts: string[] = [];
  if (input.status !== undefined) parts.push(`ステータス: *${input.status}*`);
  if (input.lifecycleStage !== undefined && input.lifecycleStage !== null) parts.push(`工程: *${input.lifecycleStage}*`);
  if (typeof input.blockedReason === "string" && input.blockedReason.trim()) {
    parts.push(`:warning: ブロック: ${input.blockedReason.trim()}`);
  }
  const ownerChanged = input.ownerStaffId != null;
  if (ownerChanged) parts.push("担当変更");
  if (!parts.length) return null;
  return {
    text: `案件を更新しました（${parts.join(" / ")}）`,
    mentionStaffIds: ownerChanged ? [input.ownerStaffId as number] : []
  };
}

// タスク作成/更新の入力から通知を導出。担当が付いていれば @メンション。
export function deriveTaskNotification(
  input: TaskCreateInput | TaskUpdateInput,
  opts: { isCreate: boolean }
): MatterEventNotification | null {
  const title = ("title" in input && input.title) ? input.title : "タスク";
  const assignee = input.assigneeStaffId ?? null;
  if (opts.isCreate) {
    return {
      text: assignee != null ? `タスク「${title}」を割り当てました。` : `タスク「${title}」を追加しました。`,
      mentionStaffIds: assignee != null ? [assignee] : []
    };
  }
  const parts: string[] = [];
  if (assignee != null) parts.push("担当変更");
  if ("status" in input && input.status) parts.push(`状態: ${input.status}`);
  if (typeof input.blockedReason === "string" && input.blockedReason.trim()) {
    parts.push(`:warning: ${input.blockedReason.trim()}`);
  }
  if (!parts.length) return null;
  return {
    text: `タスク「${title}」を更新しました（${parts.join(" / ")}）`,
    mentionStaffIds: assignee != null ? [assignee] : []
  };
}

export interface MatterSlackNotifier {
  notifyMatterUpdate(matterId: number, input: MatterUpdateInput): Promise<void>;
  notifyTask(matterId: number, input: TaskCreateInput | TaskUpdateInput, opts: { isCreate: boolean }): Promise<void>;
}

// 無効時（既定）。何もしない。
export class NoopMatterSlackNotifier implements MatterSlackNotifier {
  async notifyMatterUpdate(): Promise<void> {}
  async notifyTask(): Promise<void> {}
}

export interface LiveMatterSlackNotifierDeps {
  enabled: boolean;
  threads: MatterSlackThreadRepository;
  mentions: MatterMentionRepository;
  channel: MatterSlackChannelAdapter;
}

export class LiveMatterSlackNotifier implements MatterSlackNotifier {
  constructor(private readonly deps: LiveMatterSlackNotifierDeps) {}

  private async post(matterId: number, note: MatterEventNotification): Promise<void> {
    try {
      if (!this.deps.enabled || !this.deps.channel.configured) return;
      const thread = await this.deps.threads.findByMatter(matterId);
      if (!thread) return;
      let text = note.text;
      if (note.mentionStaffIds.length) {
        const resolved = await this.deps.mentions.slackIdsForStaffIds(note.mentionStaffIds);
        const tokens = mentionTokens(resolved.map((r) => r.slackId));
        if (tokens.length) text = `${text} ${tokens.join(" ")}`;
      }
      await this.deps.channel.postMessage({ channel: thread.channelId, text, threadTs: thread.threadTs });
    } catch {
      // best-effort：自動通知の失敗は書込を妨げない。
    }
  }

  async notifyMatterUpdate(matterId: number, input: MatterUpdateInput) {
    const note = deriveMatterUpdateNotification(input);
    if (note) await this.post(matterId, note);
  }

  async notifyTask(matterId: number, input: TaskCreateInput | TaskUpdateInput, opts: { isCreate: boolean }) {
    const note = deriveTaskNotification(input, opts);
    if (note) await this.post(matterId, note);
  }
}
