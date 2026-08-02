# 案件（Matter）作成・編集 有効化手順

案件の新規作成・フィールド編集・タスク（次アクション）追加/編集を、本番`legalbridge` DBへ書込む形で有効化する手順。既定は無効（`MATTER_WRITES_ENABLED=false`・`WRITE_SCOPES`に`matters`なし）で、`verify-isolation`ゲート通過時のみデプロイされる。

## 1. この構成で有効になる範囲

`WRITE_SCOPES`に`matters`を含み、`MATTER_WRITES_ENABLED=true`のとき、`legalbridge_v2_runtime`ロールで次の書込みが有効になる（管理者・法務ロール限定）。

- 案件の新規作成：`POST /api/v2/matters`（`matters`へINSERT。`matter_code`未指定時は`MTR-YYYY-NNNNN`を自動採番）
- 案件フィールドの編集：`PATCH /api/v2/matters/:id`（`title/status/lifecycle_stage/owner_staff_id/counterparty/primary_issue_key/target_due_date/blocked_reason/remarks`をUPDATE。`status=closed`時に`completed_at/completed_by`を自動スタンプ）
- タスク追加：`POST /api/v2/matters/:id/tasks`（`matter_tasks`へINSERT。`is_primary=true`は案件1件のみに集約）
- タスク編集：`PATCH /api/v2/matters/:id/tasks/:taskId`（状態・次アクション設定・期限等をUPDATE。`status=done`で`completed_at`スタンプ）

検証（`POST /api/v2/matters/validate`）は書込みゲート無効でも読取だけ実行できる。DELETEは提供しない（不要案件は`status=archived/cancelled`で表現）。外部送信（Slack/Backlog/Drive/Gmail）は行わない。

## 2. 安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ
- 付与は`matters`/`matter_tasks`の`INSERT, UPDATE`と対応sequenceのみ（`DELETE`は付与しない）
- 編集可能ロールは`admin`/`legal`のみ（`requester`は不可、アプリ側で403）
- `WRITE_SCOPES`と有効化能力が完全一致でなければデプロイを停止

## 3. 前提：本番DBへのGRANT拡張（008）

006で`matters`/`matter_tasks`は`SELECT`のみ付与済み。案件編集には`INSERT, UPDATE`を追加する。

```bash
# 読取専用preflight（変更なし・現状権限を表示）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/008_production_matter_management_preflight.sql

# 本付与（matters / matter_tasks の INSERT, UPDATE と sequence）
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_matter_management_grants=GRANT_PRODUCTION_MATTER_MANAGEMENT \
  -f infra/gcp/sql/008_production_matter_management_grants.sql
```

## 4. デプロイ（既存構成に案件編集を追加）

`--substitutions`（`^|^`区切り）へ次を**追加**する。`_WRITE_SCOPES`末尾に`,matters`を加える（順序は`verify-isolation`と完全一致：`...,contract-intake,matters`。Slack配信を併用する場合は`matters`の後ろに`,slack,slack-dispatch`）。

```
|_MATTER_WRITES_ENABLED=true|_CONFIRM_MATTER_WRITES=MATTER_MANAGEMENT_LEGALBRIDGE_VALIDATION_ONLY
```

`verify-isolation`のmattersゲートは、本番モード・サービス名・DB（`legalbridge`）・ユーザー（`legalbridge_v2_runtime`）・パスワードSecret・認証（`iap`/`cloudrun-iam`）・確認合言葉を検証する。

## 5. デプロイ後の検証

```bash
SERVICE_URL=$(gcloud run services describe legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/runtime" | python3 -m json.tool
```

`writeCapabilities`に`matters`が含まれること。UI「案件」画面に「＋ 新規案件」ボタン、詳細に「編集」「＋ タスク追加」が表示される。

## 6. 参照

- [契約取込デプロイ手順](contract-intake-deploy.md)
- [IAP直接アクセス](iap-access.md)
- [Production Readiness Runbook](production-readiness.md)
