# 案件管理（Phase 7/8）有効化ランブック

V2 の案件管理（Slack 連携＝Phase 7／課題・文書・送信・Drive・名寄せ・削除＝Phase 8）を
本番（`legalbridge`）で段階的に有効化するための、GRANT とデプロイ substitution を一枚にまとめた手順。

各機能は既定 OFF の guarded-write。有効化には **①本番 GRANT の適用** と **②デプロイ時の
フラグ／scope／確認トークン** の両方が必要（片方だけでは 503／verify ブロック）。

## 0. 前提

- 本番プライマリ切替済み（`PRIMARY_DB_MODE=production`・`_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE`）。基盤は `docs/phase5-cutover-checklist.md` 参照。
- 認証は IAP または Cloud Run IAM（案件系の破壊操作は verify がこれを必須化）。
- 管理接続 `RUNTIME_ADMIN_DSN`（DDL/GRANT 権限を持つ Cloud SQL 管理接続）。
- ランタイムロールは `legalbridge_v2_runtime`（GRANT の付与先）。
- `--substitutions` はカンマを含むため **`^|^` 区切り**（既定のカンマ区切りは `Bad syntax for dict arg` で失敗）。値全体をダブルクオートで囲む。

## 1. 機能 ↔ GRANT ↔ フラグ 対応表

| 機能（スライス） | 本番 GRANT | デプロイ フラグ / 確認トークン | 追加 scope |
|---|---|---|---|
| 課題紐付け 8-1 | **025**（matter_issues INSERT/UPDATE/DELETE） | `_MATTER_WRITES_ENABLED=true` / `_CONFIRM_MATTER_WRITES=MATTER_MANAGEMENT_LEGALBRIDGE_VALIDATION_ONLY` | `matters` |
| 文書リンク 8-2 | **026**（documents UPDATE(matter_id)） | 〃（同上・共有） | 〃 |
| Drive→文書登録 8-2b | 追加不要（documents INSERT＝grant 006） | 〃 | 〃 |
| 送信履歴 8-3 | **027**（document_sends SELECT/INSERT） | 〃 | 〃 |
| Drive フォルダ 8-4 | 追加不要（matters UPDATE＝grant 008） | 〃＋`_DRIVE_STORAGE_ENABLED=true` / `_CONFIRM_DRIVE_STORAGE=DRIVE_LEGALBRIDGE_VALIDATION_ONLY` | `matters`＋`drive` |
| Slack 案件連携 7 | **024**（matter_slack_threads SELECT/INSERT） | `_MATTER_SLACK_ENABLED=true`（確認トークン無し・下記 Slack 実送信の前提が必須） | `matter-slack` |
| 名寄せ 8-5 | **028**（document_sends UPDATE(matter_id)）＋025/026/008 | `_MATTER_MERGE_ENABLED=true` / `_CONFIRM_MATTER_MERGE=MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY` | `matter-merge` |
| 案件・タスク削除 8-6 | **029**（matters・matter_tasks DELETE） | `_MATTER_DELETE_ENABLED=true` / `_CONFIRM_MATTER_DELETE=MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY` | `matter-delete` |

> `matters` scope は 8-1〜8-4＋8-2b の書込みを一括で担う（フラグは共有）。名寄せ・削除・Slack は
> 破壊的／外部送信のため専用フラグ＋専用 scope で隔離している。

## 2. GRANT 適用（冪等・preflight → 本適用）

各 preflight は読取専用（現状確認）。本適用は確認変数付きで実行する。**必要な機能ぶんだけ**適用すればよい。

```bash
# 基本案件編集（8-1/8-2/8-3。8-2b/8-4 は追加 GRANT 不要）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/025_production_matter_issue_links_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_issue_links=GRANT_PRODUCTION_MATTER_ISSUE_LINKS \
  -f infra/gcp/sql/025_production_matter_issue_links_grants.sql
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/026_production_matter_document_links_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_document_links=GRANT_PRODUCTION_MATTER_DOCUMENT_LINKS \
  -f infra/gcp/sql/026_production_matter_document_links_grants.sql
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/027_production_matter_sends_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_sends=GRANT_PRODUCTION_MATTER_SENDS \
  -f infra/gcp/sql/027_production_matter_sends_grants.sql

# Slack 案件連携（Phase 7）。本ファイルは lb_v2_matter_slack_threads の CREATE TABLE IF NOT EXISTS ＋
# GRANT を一括で行う（自己完結・冪等）。検証DB用は 024_matter_slack_threads_validation.sql（本番では使わない）。
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_slack_threads=GRANT_PRODUCTION_MATTER_SLACK_THREADS \
  -f infra/gcp/sql/024_matter_slack_threads_production_grants.sql

# 名寄せ 8-5
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/028_production_matter_sends_matter_id_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_sends_matter_id=GRANT_PRODUCTION_MATTER_SENDS_MATTER_ID \
  -f infra/gcp/sql/028_production_matter_sends_matter_id_grants.sql

# 案件・タスク削除 8-6（preflight で matters を参照する FK の ON DELETE を確認）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/029_production_matter_delete_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_delete=GRANT_PRODUCTION_MATTER_DELETE \
  -f infra/gcp/sql/029_production_matter_delete_grants.sql
```

## 3. デプロイ（Cloud Build → Cloud Run）

`verify-write-test.sh` は `WRITE_SCOPES` が「有効化フラグから導かれる期待値」と**完全一致**（順序も）
することを要求する。案件系の scope は次の**正準順**で並ぶ（他機能を併用する場合はその scope も所定位置に挿入）：

```
drafts,documents,pdf
  [,drive] [,slack-approvals] [,outbound-conditions] [,contract-intake]
  [,matters] [,vendors] [,staff] [,works] [,materials] [,rights-sources]
  [,vendor-merge] [,matter-merge] [,matter-delete] [,backlog-comment]
  [,gmail] [,cloudsign] [,gmail-inbound]
  [,slack,slack-dispatch]
  [,matter-slack]
```

### 有効化プロファイル（案件系のみ・他機能未併用の例）

| プロファイル | `_WRITE_SCOPES` | 追加 substitution |
|---|---|---|
| A: 基本案件編集のみ | `drafts,documents,pdf,matters` | `_MATTER_WRITES_ENABLED=true` `_CONFIRM_MATTER_WRITES=MATTER_MANAGEMENT_LEGALBRIDGE_VALIDATION_ONLY` |
| A+Drive: ＋案件フォルダ | `drafts,documents,pdf,drive,matters` | A ＋ `_DRIVE_STORAGE_ENABLED=true` `_CONFIRM_DRIVE_STORAGE=DRIVE_LEGALBRIDGE_VALIDATION_ONLY` `_GOOGLE_DRIVE_FOLDER_ID=<親>` |
| B: ＋名寄せ | `drafts,documents,pdf,matters,matter-merge` | A ＋ `_MATTER_MERGE_ENABLED=true` `_CONFIRM_MATTER_MERGE=MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY` |
| C: ＋削除 | `drafts,documents,pdf,matters,matter-merge,matter-delete` | B ＋ `_MATTER_DELETE_ENABLED=true` `_CONFIRM_MATTER_DELETE=MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY` |
| D: ＋Slack 連携（フル・現行 gating） | `drafts,documents,pdf,slack-approvals,matters,matter-merge,matter-delete,slack,slack-dispatch,matter-slack` | C ＋ Slack フルスタック（下記） |

**Profile D の Slack フルスタック（現行 verify の連鎖依存）**：`matter-slack` は `SLACK_DELIVERY_MODE=live` を要求し、
`SLACK_DELIVERY_MODE=live` は `SLACK_DISPATCH_ENABLED=true` を要求する（verify L141）。`SLACK_DISPATCH_ENABLED=true` は
承認書込み・通知履歴・通知承認の全 ON と dry-run 宛先マップ・Bot トークン secret を要求する（L167–178）。
そのため案件Slackメンションだけを点けても、DM承認ディスパッチ一式まで有効化される。追加 substitution：

```
_MATTER_SLACK_ENABLED=true
_INTEGRATION_MODE=live
_SLACK_DELIVERY_MODE=live
_SLACK_DISPATCH_ENABLED=true   _CONFIRM_SLACK_DISPATCH=SLACK_DISPATCH_VALIDATION_ONLY
_SLACK_APPROVAL_WRITES_ENABLED=true   _CONFIRM_SLACK_APPROVAL_WRITES=SLACK_APPROVAL_WRITES_VALIDATION_ONLY
_SLACK_NOTIFICATION_HISTORY_ENABLED=true
_SLACK_NOTIFICATION_APPROVALS_ENABLED=true
_SLACK_DRY_RUN_USER_MAP=<email=SLACKID[,email2=SLACKID2]>   # UNRESOLVED/空は不可・ID は ^[UW][A-Z0-9]{8,}$
_SLACK_LEGAL_CONSULT_CHANNEL=<チャンネルID>
_SLACK_BOT_TOKEN_SECRET=<secret名>   # 既定 SLACK_BOT_TOKEN・xoxb- トークンを格納した secret
```

> DB：Slack 履歴/承認テーブル（`lb_v2_slack_notification_history`／`_approvals`）は grant 006 で付与済み。
> matter-slack のスレッド表は grant 024。実送信には Bot が対象チャンネルに参加済みで `chat:write`／`conversations` スコープを持つこと。
> メンション対象の staff→Slack ID は DB から解決する（dry-run マップは承認ディスパッチ側の検証宛先）。
>
> 併用注意：Drive を有効化する場合 `drive` は `slack-approvals` の**前**（正準順）に入る（例：`...,pdf,drive,slack-approvals,matters,...`）。

### 実行例（プロファイル C：基本＋名寄せ＋削除）

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild-write-test.yaml \
  --substitutions="^|^_REGION=asia-northeast1|_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=cloudrun-iam|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY|_WRITE_SCOPES=drafts,documents,pdf,matters,matter-merge,matter-delete|_MATTER_WRITES_ENABLED=true|_CONFIRM_MATTER_WRITES=MATTER_MANAGEMENT_LEGALBRIDGE_VALIDATION_ONLY|_MATTER_MERGE_ENABLED=true|_CONFIRM_MATTER_MERGE=MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY|_MATTER_DELETE_ENABLED=true|_CONFIRM_MATTER_DELETE=MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY"
```

## 4. 有効化の確認

```bash
# capability 一覧に該当機能が出ていること（IAP/IAM 経由の認証付きで叩く）
curl -s https://<service-url>/api/v2/runtime | jq '.writeCapabilities'
#  → ["drafts","documents","pdf","matters","matter-merge","matter-delete", ...]
```

- UI：設定 > **案件名寄せ**（`matter-merge`）、案件詳細の**危険操作**（`matter-delete`）、
  Drive ファイルの**案件文書に登録**（`matters`＋Drive）、案件詳細の **Slack パネル**（`matter-slack`）が現れる。
- GRANT 未適用のまま有効化すると、書込み時に `*_GRANT_MISSING`／`*_FORBIDDEN_DB`（503）を返す（安全側）。

## 5. 個別停止・ロールバック

- 機能停止：該当 `_*_ENABLED=false`（または `_MODE=disabled`）に戻し、`_WRITE_SCOPES` から当該 scope を除いて**再デプロイ**（正準順は維持）。
- GRANT は残置してもアプリ側フラグ OFF で書込み経路は塞がる。厳格に剥奪する場合は各 `REVOKE` を別途実施（本ランブックでは付与のみ管理）。
- 破壊操作（名寄せ・削除）は確認トークン（`COMMIT_MATTER_MERGE` / `COMMIT_MATTER_DELETE`）を UI/API で都度要求するため、フラグ ON でも誤操作は二重に防がれる。
