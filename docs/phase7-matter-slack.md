# Phase 7：案件 Slack（法務相談スレッド＋メンション＋自動通知）

V1 にあって V2 に欠けていた「案件詳細から Slack で法務相談スレッドを立て、担当を
`@メンション`する」機能を V2 へ移植し、さらに V1 に無かった**案件イベント連動の自動通知**まで
拡張する（ユーザー選択：範囲最大）。

## 背景（V1↔V2 突合）

- **V1**：`MatterSlackPanel.tsx` + `matters.ts` の手動パネル。固定チャンネル（法務相談）に
  1案件1スレッド（`matter_slack_threads`・migration 0145）を作成し、`<@id>` メンション付き
  メッセージ／3定型文（CloudSign送信済・文書作成完了・評価完了＋Drive閲覧権限付与）を投稿。
  メンション候補は `staff.slack_user_id`。**案件イベントの自動通知は無し**（手動のみ）。
- **V2（着手前）**：Slack は「依頼者への DM 通知パイプライン」のみ。チャンネル投稿・thread_ts・
  メンションの能力が**コードに存在しない**（grep 0 ヒット）。

## 設計方針（V2 作法）

- 既存の DM パイプラインとは**別能力**として追加。`SlackWebApiClient` に `conversations.replies` を
  追加し、`WebApiMatterSlackChannelAdapter`（`chat.postMessage`＋`thread_ts`）を新設。
- 隔離テーブル `lb_v2_matter_slack_threads`（grant 024・1案件1スレッド・SELECT/INSERT のみ）。
  本番 `matter_slack_threads` には触れない。
- guarded-write＋capability ゲート：`MATTER_SLACK_ENABLED`＋scope `matter-slack`＋
  `INTEGRATION_MODE=live`＋`SLACK_DELIVERY_MODE=live`＋`SLACK_LEGAL_CONSULT_CHANNEL`。
- メンションはサーバ側で `<@id>` を合成（`slack-matter-channel.ts` の純関数）。

## スライス

- **7-1/7-2（実装済み）**：基盤＋読取＋スレッド作成＋メンション付きメッセージ。
  - `slack-matter-channel.ts`：`MatterSlackChannelAdapter`（Web API / Local）＋純関数
    `mentionTokens`/`composeMentionMessage`/`buildThreadRootText`/`isSlackUserId`。
  - `matter-slack-thread-repository.ts`：`MatterSlackThreadRepository`（Pg/Memory・1案件1スレッド冪等）
    ＋`MatterMentionRepository`（`staff.slack_user_id` 候補・Drive付与用メール解決）。
  - `matter-slack-routes.ts`：
    - `GET /matters/slack/mention-candidates`（候補・read）
    - `GET /matters/:id/slack/replies`（スレッド会話・read）
    - `POST /matters/:id/slack/thread`（スレッド作成・冪等・guarded）
    - `POST /matters/:id/slack/messages`（メンション付き投稿・guarded）
  - config / app.ts / grant 024（validation＋production＋preflight）/ verify（scope `matter-slack`＋
    flag ガード）/ cloudbuild 全結線。テスト 467 件。
- **7-3（実装済み）**：定型文3種（CloudSign送信済／文書作成完了／評価完了）＋メンション＋
  Drive 閲覧権限付与。`slack-matter-channel.ts` の `buildTemplateMessage`（純関数）＋
  `documents/drive-permission.ts`（`DrivePermissionGranter`＝Google/Local/Memory・
  `extractDriveFileId`）。`POST /matters/:id/slack/template`：閲覧リンクは documentId＞
  driveLink＞案件最新文書の順で解決し、テンプレ2/3 は granter があればメンション先staff
  （`emailsForSlackIds`）へ `role=reader` を best-effort 付与（結果は `grant` で返す）。
  app.ts で Drive SA を再利用した `GoogleDrivePermissionGranter` を結線。テスト 476 件。
- **7-4（実装済み）**：案件イベント連動の自動通知（**V1 に無い新規**）。`matter-slack-notifier.ts`：
  純関数 `deriveMatterUpdateNotification`（ステータス/工程/ブロック/担当変更を1件にまとめる）／
  `deriveTaskNotification`（作成=割当文言、更新=状態/担当）。`LiveMatterSlackNotifier` が案件書込後に
  スレッド有無を確認し、担当変更時は `staff_id→slack_user_id`（`slackIdsForStaffIds`）を解決して
  `<@id>` 付きでスレッド投稿（**best-effort**・失敗や無効・スレッド未作成では書込を妨げない）。
  `write-routes` の updateMatter/createTask/updateTask 後に発火、app.ts で案件Slack有効時のみ Live を結線。
  期限/停滞のスケジュール通知（cron）は 7-4 対象外（別途）。テスト 484 件。
- **7-5（予定）**：案件詳細の Slack パネル UI（メンションピッカー・スレッド表示）。

## 有効化（点火）

`_MATTER_SLACK_ENABLED=true`＋`_SLACK_LEGAL_CONSULT_CHANNEL=<チャンネルID>`＋
`_WRITE_SCOPES=...,matter-slack`＋`INTEGRATION_MODE=live`＋`SLACK_DELIVERY_MODE=live`＋
`SLACK_BOT_TOKEN`（Secret）。事前に grant 024 を適用（本番は `024_..._production_grants.sql`・
トークン `GRANT_PRODUCTION_MATTER_SLACK_THREADS`）。Bot に `chat:write` と対象チャンネル参加、
`conversations.replies` 読取が必要。
