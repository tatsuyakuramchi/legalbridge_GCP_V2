# 外部連携 段階的接続 runbook

外部サービスをadapter単位で段階的に開放するための現状と手順。原則は「まず読取／プレビュー → 検証チャンネル → 本番送信」。既定は全て無効（`INTEGRATION_MODE=local`）で、送信は行わない。

## 1. 現状サマリ

| サービス | V2実装 | デプロイ配線 | 既定 | 次段 |
|---|---|---|---|---|
| **Drive** | ✅ V1準拠（専用SA鍵＋フルdriveスコープ） | ✅ `cloudbuild-write-test` Driveゲート | 無効 | 実デプロイでON → 確定PDF保存確認（[drive-integration](drive-integration.md)） |
| **Backlog** | ✅ 参照専用アダプタ（GET project） | ✅ `BACKLOG_MODE=readonly` ゲート | 無効 | **本runbook §3 で接続確認** |
| **Slack** | ✅ 七状態UXプレビュー・候補・承認・dry-run・配信ゲート | 一部（履歴/承認は別テーブル前提） | 送信無効 | §4：プレビュー→検証チャンネル |
| **Gmail** | ❌ localモックのみ（live未実装） | ― | 無効 | V1移植が必要（§5） |
| **CloudSign** | ❌ localモックのみ（live未実装） | ― | 無効 | V1移植が必要（§5） |

## 2. 常時維持する安全境界

- adapterは個別に明示有効化する。一括有効化しない
- 本番送信の前に必ず「読取／プレビュー」「検証チャンネル」を通す
- Cloud Runは`--no-allow-unauthenticated`、認証は`cloudrun-iam`/`iap`
- 送信失敗時もBacklog/LegalBridgeの状態を変更しない（Slackゲート）

## 3. Backlog（参照専用）— 接続確認

書込みは一切行わず、`GET project` で疎通と権限だけ確認する。`/api/v2/integrations/status` に接続状態が現れる。

### 前提

- Secret `backlog-api-key` に読取可能なAPIキーを登録し、デプロイSA（`legalbridge-v2-preview@…`）へ `secretmanager.secretAccessor` を付与
- 対象は既存の `LEGAL` プロジェクト（読取のみ）

### デプロイ（契約取込構成にBacklog参照を追加）

`--substitutions` はカンマ対策で `^|^` 区切り＋ダブルクオート。既存の契約取込substitutionに以下を**追加**する。

```
|_BACKLOG_MODE=readonly|_BACKLOG_HOST=arclight.backlog.com|_BACKLOG_PROJECT_KEY=LEGAL|_CONFIRM_BACKLOG_READONLY=BACKLOG_READONLY_VALIDATION_ONLY
```

`verify-isolation` の Backlog ゲートは、サービス名（`legalbridge-v2-write-test`）・ホスト（`arclight.backlog.com`）・プロジェクト（`LEGAL`）・確認合言葉を検証する。`live` は明示的に拒否される（既存workerが正）。

### 検証

```bash
SERVICE_URL=$(gcloud run services describe legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/integrations/status" | python3 -m json.tool
```

- `backlog` の `mode` が `readonly`、`ok:true`、`detail` に `project LEGAL (...)` が出る
- 失敗時 `detail` にエラー（APIキー・ホスト・権限を確認）。APIキーはログ・レスポンスに出さない実装

## 4. Slack（プレビュー → 検証チャンネル）

送信は依然無効。まず管理画面で内部工程→利用者向け七状態の変換をプレビューし、次に検証チャンネルへ dry-run する段階開放。

- **プレビュー（送信なし）**：`GET /api/v2/admin/slack-notification-candidates` が実案件を七状態の通知候補へ変換して返す（`slackUxPreviewCatalog` / `buildSlackNotificationCandidates`）。まずここで文面・現在地・次の行動・重複抑止を確認
- **承認（DB追記のみ）**：`slack-approvals` スコープ + 履歴/承認テーブル（`SLACK_NOTIFICATION_HISTORY_ENABLED` / `SLACK_NOTIFICATION_APPROVALS_ENABLED`）で、送信可否の判断を追記（送信はまだしない）
- **検証送信（実DM・検証宛先限定）**：`POST /api/v2/admin/slack-notifications/dispatch`（管理者・要 `confirmation:"SEND_SLACK_VALIDATION"`）。承認済みの1件を、多重ゲート充足時だけ**DMで1回**送る。宛先は `SLACK_DRY_RUN_USER_MAP` に解決される検証ユーザーのみ（未マップの実依頼者へは送られない）。冪等（同一指紋の重複送信を抑止）
- **本番チャンネル**：検証完了後に限定開放

### 検証送信の有効化（deploy）

実DMは次が**すべて揃った時だけ**送信される：`SLACK_DELIVERY_MODE=live` ＋ 実アダプタ（`SLACK_BOT_TOKEN`）＋ 管理者による個別承認 ＋ 履歴接続 ＋ 非重複 ＋ 宛先が検証マップに存在。

前提：`SLACK_BOT_TOKEN` Secret（V1が保有）へ V2デプロイSAの `secretAccessor`、006で本番`legalbridge`にSlack履歴/承認テーブル作成済み、検証宛先マップ（`メール=SlackユーザーID`）。

`cloudbuild-write-test` の Slack配信ゲートを通す substitution（既存の deploy に追加）：

```
|_SLACK_NOTIFICATION_HISTORY_ENABLED=true|_SLACK_NOTIFICATION_APPROVALS_ENABLED=true|_SLACK_APPROVAL_WRITES_ENABLED=true|_CONFIRM_SLACK_APPROVAL_WRITES=SLACK_APPROVAL_WRITES_VALIDATION_ONLY|_SLACK_DRY_RUN_USER_MAP=<メール>=<SlackユーザーID>|_SLACK_DELIVERY_MODE=live|_SLACK_DISPATCH_ENABLED=true|_CONFIRM_SLACK_DISPATCH=SLACK_DISPATCH_VALIDATION_ONLY|_SLACK_BOT_TOKEN_SECRET=SLACK_BOT_TOKEN
```

`WRITE_SCOPES` の末尾に `,slack,slack-dispatch` を追加（`slack-approvals` 有効時は該当位置に含める。順序は `verify-isolation` と完全一致）。有効化後、`/api/v2/runtime` の `writeCapabilities` に `slack-dispatch` が出る。

**配信経路のスモークテスト**：`POST /api/v2/admin/slack-notifications/test-dispatch`（管理者・要 `confirmation:"SEND_SLACK_VALIDATION"`・`userId:"U…"`）で、指定Slackユーザーへ固定の検証メッセージをDMし、bot token・アダプタ・Slack API疎通だけを確認できる（候補フロー非経由）。

> 注：候補フローの実送信は候補の `requesterEmail` が `SLACK_DRY_RUN_USER_MAP` で解決される必要がある。本番 `matter_overview_v` に requester email が無い場合、候補経由の送信は不可のため、まず上記 test-dispatch で配信経路を検証する。requester email の供給はDBビュー側の課題。

> Slackはデフォルト画面にせず、申請入口と利用者の行動が必要な通知に限定する（Production Readiness §6）。検証段階では `SLACK_DRY_RUN_USER_MAP` を**検証ユーザーのみ**に絞ること。

## 5. Gmail / CloudSign（V1移植が必要）

V2は `integrations/index.ts` に名前だけあり実体は local モック。live化にはV1（`LegalBridge_AI_GCP`）の実装移植が必要。

- Gmail：V1 `services/worker/src/services/emailService.ts`
- CloudSign：V1側の送信実装（要特定）

移植時も「dry-run／検証宛先 → 本番」の順で開放し、冪等性と失敗時の状態不整合防止を確認する。

## 6. 参照

- [契約取込デプロイ手順](contract-intake-deploy.md)
- [Google Drive連携](drive-integration.md)
- [Production Readiness Runbook](production-readiness.md)
