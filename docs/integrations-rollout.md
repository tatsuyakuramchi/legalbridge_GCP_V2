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
- **検証チャンネルへ dry-run**：`SLACK_DRY_RUN_USER_MAP` を実解決し、配信ゲート（`slack-dispatch-gate`）の全条件が揃った候補だけを検証チャンネルへ送る。冪等（同一指紋の重複送信を抑止）
- **本番チャンネル**：検証完了後に限定開放

> Slackはデフォルト画面にせず、申請入口と利用者の行動が必要な通知に限定する（Production Readiness §6）。

## 5. Gmail / CloudSign（V1移植が必要）

V2は `integrations/index.ts` に名前だけあり実体は local モック。live化にはV1（`LegalBridge_AI_GCP`）の実装移植が必要。

- Gmail：V1 `services/worker/src/services/emailService.ts`
- CloudSign：V1側の送信実装（要特定）

移植時も「dry-run／検証宛先 → 本番」の順で開放し、冪等性と失敗時の状態不整合防止を確認する。

## 6. 参照

- [契約取込デプロイ手順](contract-intake-deploy.md)
- [Google Drive連携](drive-integration.md)
- [Production Readiness Runbook](production-readiness.md)
