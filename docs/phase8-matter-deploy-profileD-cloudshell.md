# Profile D（案件管理フル＋Slack）Cloud Shell 実行ガイド

`docs/phase8-matter-enablement-runbook.md` の **Profile D（フル・現行 gating）** を Cloud Shell で
実際に流すための手順書。GRANT 024〜029 適用 → Cloud Build デプロイ → 有効化確認まで。

対象サービス：`legalbridge-v2-write-test`（本番 `legalbridge` DB・Cloud Run IAM 認証）。

## 事前に用意する 3 値

| プレースホルダ | 内容 |
|---|---|
| `<法務相談チャンネルID>` | Slack 投稿先チャンネルID（`C0XXXX…`）。**Bot が参加済み**で `chat:write`／`conversations` スコープ保有 |
| `<dry-run宛先マップ>` | `email=SlackユーザーID`（カンマ区切り可）。ID は `^[UW][A-Z0-9]{8,}$`。例：`tatsuya.kuramochi@arclight.co.jp=U01ABCDEFGH` |
| Secret `SLACK_BOT_TOKEN` | Secret Manager に `xoxb-…` を格納した secret が存在すること（無ければ先に作成） |

## Step 0｜リポジトリを最新化

```bash
cd ~/legalbridge_gcp_v2
git fetch origin
git checkout claude/github-analysis-development-1s2tht
git pull origin claude/github-analysis-development-1s2tht
git log --oneline -1     # 最新コミットを確認
```

## Step 1｜Cloud SQL Auth Proxy を起動（127.0.0.1:5432 待受）

まず後片付け＆プリインストール確認（無駄なダウンロードを避ける）：

```bash
kill %1 2>/dev/null        # 途中で止めた proxy ジョブがあれば停止
rm -f cloud-sql-proxy      # 途中ダウンロードのファイルを削除
which cloud-sql-proxy cloud_sql_proxy 2>/dev/null
```

出力に応じて分岐：

- **(A) `cloud_sql_proxy`（v1）が存在** → ダウンロード不要：
  ```bash
  cloud_sql_proxy -instances=legalbridge-488506:asia-northeast1:legalbridge-db=tcp:5432 &
  ```
- **(B) `cloud-sql-proxy`（v2）が存在**：
  ```bash
  cloud-sql-proxy legalbridge-488506:asia-northeast1:legalbridge-db &
  ```
- **(C) 何も無い** → 取得してから起動：
  ```bash
  curl -L --retry 3 -o cloud-sql-proxy \
    https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64
  chmod +x cloud-sql-proxy
  ls -l cloud-sql-proxy      # サイズが ~30MB あるか（途中失敗の検知）
  ./cloud-sql-proxy legalbridge-488506:asia-northeast1:legalbridge-db &
  ```

`Listening on 127.0.0.1:5432`（v2）／`Ready for new connections`（v1）が出れば成功。

## Step 2｜管理接続 DSN 設定＆接続テスト

`<管理ユーザー>` は **GRANT 権限を持つロール**（従来 006〜028 の GRANT を流したのと同じ管理者）。
ランタイムユーザー `legalbridge_v2_runtime` ではない。

```bash
export RUNTIME_ADMIN_DSN="postgresql://<管理ユーザー>:<パスワード>@127.0.0.1:5432/legalbridge"
psql "$RUNTIME_ADMIN_DSN" -c "select current_database(), current_user;"
#  → legalbridge / <管理ロール> が返れば OK
```

## Step 3｜本番 GRANT 適用（024〜029・冪等）

> 006/008（Slack 履歴・承認テーブル、matters/matter_tasks の INSERT/UPDATE）は本番切替時に適用済み前提。

```bash
# 課題/文書/送信（8-1/8-2/8-3）
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_issue_links=GRANT_PRODUCTION_MATTER_ISSUE_LINKS \
  -f infra/gcp/sql/025_production_matter_issue_links_grants.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_document_links=GRANT_PRODUCTION_MATTER_DOCUMENT_LINKS \
  -f infra/gcp/sql/026_production_matter_document_links_grants.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_sends=GRANT_PRODUCTION_MATTER_SENDS \
  -f infra/gcp/sql/027_production_matter_sends_grants.sql
# Slack 案件スレッド表（Phase 7・CREATE＋GRANT 自己完結）
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_slack_threads=GRANT_PRODUCTION_MATTER_SLACK_THREADS \
  -f infra/gcp/sql/024_matter_slack_threads_production_grants.sql
# 名寄せ（8-5）
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_sends_matter_id=GRANT_PRODUCTION_MATTER_SENDS_MATTER_ID \
  -f infra/gcp/sql/028_production_matter_sends_matter_id_grants.sql
# 削除（8-6・preflight で FK ON DELETE を確認してから）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/029_production_matter_delete_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_delete=GRANT_PRODUCTION_MATTER_DELETE \
  -f infra/gcp/sql/029_production_matter_delete_grants.sql
```

## Step 4｜デプロイ（Cloud Build → Cloud Run・Profile D フル）

`<…>` 3 箇所を実値に置換。`^|^` 区切り・全体をダブルクオートで囲む。
`WRITE_SCOPES` は verify が**順序込みで完全一致**を要求するため、下記の正準順を崩さない。

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild-write-test.yaml \
  --substitutions="^|^_REGION=asia-northeast1|_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=cloudrun-iam|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY|_WRITE_SCOPES=drafts,documents,pdf,slack-approvals,matters,matter-merge,matter-delete,slack,slack-dispatch,matter-slack|_MATTER_WRITES_ENABLED=true|_CONFIRM_MATTER_WRITES=MATTER_MANAGEMENT_LEGALBRIDGE_VALIDATION_ONLY|_MATTER_MERGE_ENABLED=true|_CONFIRM_MATTER_MERGE=MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY|_MATTER_DELETE_ENABLED=true|_CONFIRM_MATTER_DELETE=MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY|_MATTER_SLACK_ENABLED=true|_INTEGRATION_MODE=live|_SLACK_DELIVERY_MODE=live|_SLACK_DISPATCH_ENABLED=true|_CONFIRM_SLACK_DISPATCH=SLACK_DISPATCH_VALIDATION_ONLY|_SLACK_APPROVAL_WRITES_ENABLED=true|_CONFIRM_SLACK_APPROVAL_WRITES=SLACK_APPROVAL_WRITES_VALIDATION_ONLY|_SLACK_NOTIFICATION_HISTORY_ENABLED=true|_SLACK_NOTIFICATION_APPROVALS_ENABLED=true|_SLACK_DRY_RUN_USER_MAP=<dry-run宛先マップ>|_SLACK_LEGAL_CONSULT_CHANNEL=<法務相談チャンネルID>|_SLACK_BOT_TOKEN_SECRET=SLACK_BOT_TOKEN"
```

## Step 5｜有効化確認

```bash
SVC_URL=$(gcloud run services describe legalbridge-v2-write-test --region asia-northeast1 --format='value(status.url)')
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$SVC_URL/api/v2/runtime" | jq '.writeCapabilities'
#  期待: [...,"matters","matter-merge","matter-delete","slack-approvals","slack-dispatch","matter-slack"]
```

## トラブルシュート

- **verify が `… blocked: …` で停止**：`WRITE_SCOPES` の順序／欠落、または該当フラグ・確認トークンの
  取り違え。エラー文の機能名を上表・runbook 対応表と突き合わせる。
- **`_SLACK_DRY_RUN_USER_MAP` 空/`UNRESOLVED`**：承認ディスパッチのゲートで停止。最低 1 件（例：管理者の `email=Uxxxx`）を渡す。
- **書込み時 `*_GRANT_MISSING`／`*_FORBIDDEN_DB`（503）**：該当 GRANT 未適用。Step 3 の対応行を再実行。
- **proxy ダウンロードが遅い/失敗**：Step 1 のプリインストール確認（A/B）を優先。再取得は `curl -L --retry 3`。

## 個別停止・ロールバック

- 機能停止：該当 `_*_ENABLED=false`（または `_MODE=disabled`）に戻し、`_WRITE_SCOPES` から当該 scope を除いて再デプロイ（正準順は維持）。
- GRANT は残置してもフラグ OFF で書込み経路は塞がる。破壊操作（名寄せ・削除）は実行時に合言葉（`COMMIT_MATTER_MERGE`／`COMMIT_MATTER_DELETE`）を都度要求。
