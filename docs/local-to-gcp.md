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
4. Secret Managerへ`DATABASE_URL`等を登録
5. Cloud Runを認証必須でデプロイ

## 5. デプロイ

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild.yaml \
  --substitutions \
_REGION=asia-northeast1,\
_SERVICE=legalbridge-v2,\
_AR_REPOSITORY=legalbridge,\
_IMAGE=legalbridge-v2,\
_CLOUD_SQL_INSTANCE=PROJECT:REGION:INSTANCE
```

Cloud Build設定の初期値は`INTEGRATION_MODE=local`である。外部送信を行う`live`への変更は、各adapterの実装・権限・冪等性テスト完了後に個別に行う。

## 6. 段階的開放

1. ローカルfixture
2. Cloud SQL Cloneの読取専用接続
3. 下書きのみ書込み
4. 文書プレビュー
5. 文書発行
6. Drive
7. Slack・Gmail・CloudSign
8. Backlogへの既存範囲内の書戻し

