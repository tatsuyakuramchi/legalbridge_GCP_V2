# Local to GCP Runbook

## 1. ローカル開発

```bash
cp .env.example .env
npm install
docker compose up -d db
npm run dev
```

UIは`http://localhost:5173`、APIは`http://localhost:8080`で起動する。

## 2. 本番相当コンテナ

```bash
docker compose up --build
curl http://localhost:8080/health
```

統合アプリがUIとAPIを同じポートで配信する。

## 3. ローカルDBの扱い

`infra/local-db`は既存テーブルのうち初期開発に必要な最小部分だけを再現するfixtureである。本番DBへ適用しない。

本番接続前に、本番スキーマの読取専用ダンプ又はCloud SQL Cloneで互換確認する。V2からmigrationを自動実行しない。

## 4. GCP準備

1. Artifact Registry repositoryを作成
2. Cloud Build、Cloud Run、Secret Manager、Cloud SQL Admin APIを有効化
3. Cloud Buildサービスアカウントへ必要最小限の権限を付与
4. Secret Managerへ読取専用DBユーザーのパスワードを登録
5. Cloud Runを認証必須でデプロイ

## 5. デプロイ

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild.yaml \
  --substitutions \
_REGION=asia-northeast1,\
_SERVICE=legalbridge-v2-preview,\
_AR_REPOSITORY=legalbridge,\
_IMAGE=legalbridge-v2,\
_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db,\
_DB_NAME=legalbridge,\
_DB_USER=legalbridge_v2_readonly,\
_DB_PASSWORD_SECRET=legalbridge-v2-readonly-db-password,\
_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com
```

Cloud Build設定の初期値は`INTEGRATION_MODE=local`である。外部送信を行う`live`への変更は、各adapterの実装・権限・冪等性テスト完了後に個別に行う。

## 6. 本番DB参照プレビュー

`legalbridge-v2-preview`は既存本番サービスと分離し、以下を常時設定する。

- `DB_ACCESS_MODE=readonly`
- `REQUIRE_DATABASE=true`
- `INTEGRATION_MODE=local`
- Cloud SQL接続ユーザーは`legalbridge_v2_readonly`
- Cloud Runは`--no-allow-unauthenticated`

アプリはGET、HEAD、OPTIONS及び入力検証・HTMLプレビューに必要なPOSTだけを許可し、その他のPOST、PUT、PATCH、DELETEをHTTP 403で拒否する。DB接続にも`default_transaction_read_only=on`を設定し、`/health`はDBセッションが読取専用でなければ503を返す。

初回だけ、Cloud Shellで次を準備する。パスワードはコマンドライン引数やGitHubへ記録しない。

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  --project=legalbridge-488506

gcloud iam service-accounts create legalbridge-v2-preview \
  --display-name="LegalBridge V2 read-only preview" \
  --project=legalbridge-488506

gcloud projects add-iam-policy-binding legalbridge-488506 \
  --member="serviceAccount:legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"

read -s -p "Readonly DB password: " DB_RO_PASSWORD
echo
printf %s "$DB_RO_PASSWORD" | gcloud secrets create legalbridge-v2-readonly-db-password \
  --data-file=- \
  --replication-policy=automatic \
  --project=legalbridge-488506
unset DB_RO_PASSWORD

gcloud secrets add-iam-policy-binding legalbridge-v2-readonly-db-password \
  --member="serviceAccount:legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=legalbridge-488506
```

Cloud Runへのアクセス権は利用者単位で付与する。

```bash
gcloud run services add-iam-policy-binding legalbridge-v2-preview \
  --region=asia-northeast1 \
  --member="user:YOUR_GOOGLE_ACCOUNT" \
  --role="roles/run.invoker" \
  --project=legalbridge-488506
```

## 7. 段階的開放

1. ローカルfixture
2. Cloud SQL Cloneの読取専用接続
3. 下書きのみ書込み
4. 文書プレビュー
5. 文書発行
6. Drive
7. Slack・Gmail・CloudSign
8. Backlogへの既存範囲内の書戻し
