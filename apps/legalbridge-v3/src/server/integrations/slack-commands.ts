import type { LegalSearchResult } from "../search/legal-search.js";
import type { SlackViewOpener } from "./adapters.js";
import { INTAKE_COMMANDS, buildIntakeModal } from "./slack-intake.js";
import {
  SEARCH_COMMANDS, SEARCH_CALLBACK_ID, buildSearchModal, buildSearchResultView,
  parseSearchSubmission, renderSearchBlocks, searchSummaryText
} from "./slack-search.js";

/**
 * スラッシュコマンドの振り分け（/法務依頼・/法務検索）。
 *
 * Slack は 3 秒以内の応答を求める。モーダルは応答本文では開けないので、
 * trigger_id を使って views.open を呼び、本文は「開いています」だけ返す。
 * トークンが無い（開けない）ときは、何をすればよいかを文字で返す。
 */

export interface SlackCommandDeps {
  search: (keyword: string) => Promise<LegalSearchResult>;
  views: SlackViewOpener | null;
  /** /法務検索 を使ってよいチャンネル。空ならどこでも。 */
  searchChannels: string[];
  backlogHost?: string;
  backlogProjectKey?: string;
  /** 検索の記録（誰が何を引いたか）。失敗しても応答は止めない。 */
  audit?: (entry: { userId: string; keyword: string; hits: number }) => Promise<void>;
}

export type SlackReply = Record<string, unknown>;

const ephemeral = (text: string, blocks?: unknown[]): SlackReply =>
  ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });

export class SlackCommandHandler {
  constructor(private readonly deps: SlackCommandDeps) {}

  handles(command: string) { return INTAKE_COMMANDS.has(command) || SEARCH_COMMANDS.has(command); }

  async command(form: Record<string, string>): Promise<SlackReply> {
    const command = String(form.command ?? "");
    const triggerId = String(form.trigger_id ?? "");

    if (INTAKE_COMMANDS.has(command)) {
      if (!this.deps.views) return ephemeral("法務依頼のフォームを開けませんでした（Slack アプリの設定を確認中です）。法務へ直接ご連絡ください。");
      try {
        await this.deps.views.openView(triggerId, buildIntakeModal({ channelId: form.channel_id }));
      } catch (error) {
        console.error("views.open failed (intake)", (error as Error)?.message);
        return ephemeral("法務依頼のフォームを開けませんでした。もう一度 /法務依頼 を実行してください。");
      }
      return ephemeral("依頼フォームを開いています…");
    }

    if (SEARCH_COMMANDS.has(command)) {
      const allowed = this.deps.searchChannels;
      if (allowed.length && !allowed.includes(String(form.channel_id ?? ""))) {
        return ephemeral("❌ /法務検索 はこのチャンネルでは使えません。指定の法務チャンネルでお試しください。");
      }
      const keyword = String(form.text ?? "").trim();
      if (keyword) {
        // キーワード付きはその場で返す（モーダルを挟まない分だけ速い）。
        const result = await this.run(String(form.user_id ?? ""), keyword);
        return ephemeral(searchSummaryText(result), this.blocks(result));
      }
      if (!this.deps.views) return ephemeral("`/法務検索 キーワード` の形で検索してください（例：`/法務検索 株式会社アーク`）。");
      try {
        await this.deps.views.openView(triggerId, buildSearchModal());
      } catch (error) {
        console.error("views.open failed (search)", (error as Error)?.message);
        return ephemeral("検索フォームを開けませんでした。`/法務検索 キーワード` の形でもう一度お試しください。");
      }
      return ephemeral("検索フォームを開いています…");
    }

    return ephemeral("知らないコマンドです。");
  }

  /** 検索フォームの送信か。 */
  isSearchSubmission(payload: any) {
    return payload?.type === "view_submission" && payload?.view?.callback_id === SEARCH_CALLBACK_ID;
  }

  /** 検索フォームの送信。同じモーダルを結果に差し替える。 */
  async searchSubmission(payload: any): Promise<SlackReply> {
    const keyword = parseSearchSubmission(payload);
    if (keyword.length < 2) {
      return { response_action: "errors", errors: { keyword: "2文字以上で入力してください" } };
    }
    const result = await this.run(String(payload?.user?.id ?? ""), keyword);
    return { response_action: "update", view: buildSearchResultView(this.blocks(result)) };
  }

  private blocks(result: LegalSearchResult) {
    return renderSearchBlocks(result, {
      backlogHost: this.deps.backlogHost, backlogProjectKey: this.deps.backlogProjectKey
    });
  }

  private async run(userId: string, keyword: string) {
    const result = await this.deps.search(keyword);
    const hits = (result.party ? 1 : 0) + result.partyNames.length + result.hits.length
      + result.requests.length + result.backlogMatters.length + result.ringi.length;
    await this.deps.audit?.({ userId, keyword: result.keyword, hits })
      .catch((error) => console.error("search audit failed", (error as Error)?.message));
    return result;
  }
}
