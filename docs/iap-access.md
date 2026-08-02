# IAP でCloud RunのURLに直接アクセスする（検証・ブラウザ）

`legalbridge-v2-write-test` は本番 `legalbridge` DB へ書込む検証サービスであり、`--no-allow-unauthenticated` で保護されている。`cloudrun-iam` モードは「到達した全リクエストを単一管理者扱い」にするため、`--allow-unauthenticated` での全面開放は本番法務データの閲覧・書込みをインターネットへ晒すことになり不可。

ブラウザでCloud RunのURLを直接開くには **IAP（Identity-Aware Proxy）** を使う。IAPがGoogleログインで本人確認し、`AUTH_MODE=iap` のアプリは IAP が注入する `x-goog-authenticated-user-email` からロールを解決する。許可ユーザーだけが通過し、URLを知っていてもログインなしでは到達できない。

## 0. 安全境界

- サービスは `--no-allow-unauthenticated` のまま。到達できるのは IAP サービスエージェントのみ
- IAP を通過できるのは `roles/iap.httpsResourceAccessor` を付与したユーザーのみ
- アプリは `x-goog-authenticated-user-email` を信頼するが、IAP有効かつingress制限下では IAP 以外がこのヘッダを注入できないため、検証段階では許容
- Slack実送信は本手順では無効（配信オフ／承認プレビューまで）

## 1. 前提（プロジェクトで一度だけ）

1. **OAuth同意画面**（未設定の場合）：Console → 「APIとサービス」→「OAuth同意画面」→ **内部（Internal）** を選び、アプリ名・サポートメールを設定。組織 `arclight.co.jp` の内部アプリとする。
2. **IAP API 有効化**：

   ```bash
   gcloud services enable iap.googleapis.com --project=legalbridge-488506
   ```

3. **IAP サービスエージェント作成**（invoker付与の対象を先に作る）：

   ```bash
   gcloud beta services identity create --service=iap.googleapis.com --project=legalbridge-488506
   ```

## 2. アプリを IAP モードで再デプロイ

`AUTH_MODE=iap` に切替え、Slackは配信オフへ戻す（承認プレビューは維持）。Driveは実フォルダ `1KA1H525VDve71anot0Wv8p5qsggTiUja`（共有ドライブ `V2_FOLD`、ランタイムSAが `fileOrganizer`）を維持。

```bash
cd ~/legalbridge_GCP_V2 && git checkout main && git pull origin main
gcloud builds submit --config infra/gcp/cloudbuild-write-test.yaml --project=legalbridge-488506 --substitutions="^|^_REGION=asia-northeast1|_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=iap|_CONFIRM_IAP_BACKEND=IAP_BACKEND_READY|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_AUTH_LEGAL_EMAILS=tatsuya.kuramochi@arclight.co.jp|_AUTH_REQUESTER_DOMAINS=arclight.co.jp|_WRITE_SCOPES=drafts,documents,pdf,drive,slack-approvals,outbound-conditions,contract-intake|_CONTRACT_INTAKE_WRITES_ENABLED=true|_CONFIRM_CONTRACT_INTAKE_WRITES=CONTRACT_INTAKE_LEGALBRIDGE_VALIDATION_ONLY|_OUTBOUND_CONDITION_WRITES_ENABLED=true|_CONFIRM_OUTBOUND_WRITES=OUTBOUND_WRITES_LEGALBRIDGE_VALIDATION_ONLY|_OUTBOUND_DB_NAME=legalbridge|_OUTBOUND_DB_USER=legalbridge_v2_runtime|_OUTBOUND_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_DRIVE_STORAGE_ENABLED=true|_CONFIRM_DRIVE_STORAGE=DRIVE_LEGALBRIDGE_VALIDATION_ONLY|_GOOGLE_DRIVE_FOLDER_ID=1KA1H525VDve71anot0Wv8p5qsggTiUja|_BACKLOG_MODE=readonly|_BACKLOG_HOST=arclight.backlog.com|_BACKLOG_PROJECT_KEY=LEGAL|_CONFIRM_BACKLOG_READONLY=BACKLOG_READONLY_VALIDATION_ONLY|_SLACK_NOTIFICATION_HISTORY_ENABLED=true|_SLACK_NOTIFICATION_APPROVALS_ENABLED=true|_SLACK_APPROVAL_WRITES_ENABLED=true|_CONFIRM_SLACK_APPROVAL_WRITES=SLACK_APPROVAL_WRITES_VALIDATION_ONLY|_SLACK_DRY_RUN_USER_MAP=tatsuya.kuramochi@arclight.co.jp=U08217X0A07"
```

> `verify-isolation` の IAP ゲートは、`_CONFIRM_IAP_BACKEND=IAP_BACKEND_READY` と、`AUTH_ADMIN_EMAILS`/`AUTH_LEGAL_EMAILS`/`AUTH_REQUESTER_DOMAINS` がいずれも非空であることを要求する。`resolveRole` は admin を最優先で判定するため、legal に管理者メールを重複指定しても実害はない。

## 3. Cloud Run サービスで IAP を有効化

```bash
gcloud beta run services update legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --iap
```

IAP サービスエージェント（`service-PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com`）への `run.invoker` 付与を求められたら承認する（`--no-allow-unauthenticated` は維持したまま、IAP だけが呼び出せる状態になる）。

## 4. アクセスを許可するユーザーを付与

```bash
gcloud beta run services add-iam-policy-binding legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 \
  --member='user:tatsuya.kuramochi@arclight.co.jp' \
  --role='roles/iap.httpsResourceAccessor'
```

## 5. ブラウザで直接アクセス・確認

```bash
gcloud run services describe legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --format='value(status.url)'
```

出力された `https://legalbridge-v2-write-test-....run.app` を**ブラウザで直接開く**。Googleログイン（`tatsuya.kuramochi@arclight.co.jp`）を求められ、通過するとSPAが開く。

本人解決の確認（ログイン中のブラウザのCookieで、または identity-token で）：

```
GET /api/v2/me  → { "user": { "email": "tatsuya.kuramochi@arclight.co.jp", "role": "admin", "source": "iap" } }
```

`source: "iap"`・`role: "admin"` が出れば IAP 経路が正しく通っている。

## 6. Drive の実地テスト（この直接アクセス上で）

1. 「契約取込」で締結済イン契約を登録（管理者＋合言葉 `COMMIT_PRODUCTION_CONTRACT_INTAKE`）
2. 利用許諾料明細書などの下書き→確定→**PDF生成**
3. PDF確定時に Drive へ保存され、応答に `webViewLink`（`https://drive.google.com/file/d/.../view`）が返る
4. 共有ドライブ `V2_FOLD` に当該PDFが作成され、`appProperties.legalbridgeDocumentId` が付与されていることを確認

Drive保存はランタイムSAの `fileOrganizer` 権限＋共有ドライブ容量で成立する。403（`storageQuotaExceeded` 等）が出る場合は、対象フォルダが共有ドライブでない／SAがメンバーでない可能性を疑う。

## 7. 切戻し

- IAP無効化：`gcloud beta run services update ... --no-iap`（`cloudrun-iam` へ戻す場合はアプリも `_AUTH_MODE=cloudrun-iam` で再デプロイ）
- ユーザー削除：手順4の `add-iam-policy-binding` を `remove-iam-policy-binding` に置換

## 参照

- [契約取込デプロイ手順](contract-intake-deploy.md)
- [Google Drive連携](drive-integration.md)
- [外部連携ロールアウト](integrations-rollout.md)
