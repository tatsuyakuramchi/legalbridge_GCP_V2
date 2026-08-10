# lb-v2-receiver — 外部 Webhook / Slack 受信専用リレー（runbook 2-4）

本体（`legalbridge-v2-write-test`）は Cloud Run 統合 IAP の背後にあり、CloudSign / Backlog / Slack は
Google OIDC を提示できないため直接届かない。本サービスは **allUsers 公開の最小リレー**として受け、
許可された 4 パスのみを OIDC（audience = IAP `programmaticClients` のクライアント ID）付きで本体へ転送する。

- 許可パス（POST のみ）: `/internal/webhooks/cloudsign`・`/internal/webhooks/backlog`・
  `/internal/slack/commands`・`/internal/slack/interactivity`（他は 404）
- 実際の認証は**本体側のアプリ層検証**（`X-Webhook-Token` 共有シークレット／Slack v0 署名・fail-closed）。
  リレーは DB もシークレットも持たない。
- 依存ゼロ（Node 22 標準のみ）。ボディ上限 1MB・転送ヘッダ allowlist・受信 Authorization は破棄。

## デプロイ

```bash
# 専用 SA（最小権限：IAP 通過のみ）
gcloud iam service-accounts create lb-v2-receiver --display-name="LB V2 webhook receiver relay"
gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run \
  --service=legalbridge-v2-write-test --region=asia-northeast1 \
  --member="serviceAccount:lb-v2-receiver@legalbridge-488506.iam.gserviceaccount.com" \
  --role=roles/iap.httpsResourceAccessor

# デプロイ（公開・小さく固定）
UPSTREAM=$(gcloud run services describe legalbridge-v2-write-test --region asia-northeast1 --format='value(status.url)')
AUDIENCE=988056987352-k521jsfnimvejpt9tj5doe2k6mcgdvu6.apps.googleusercontent.com   # lb-v2-scheduler と同じ IAP クライアント
gcloud run deploy lb-v2-receiver --source infra/receiver --region asia-northeast1 \
  --allow-unauthenticated --no-iap \
  --service-account lb-v2-receiver@legalbridge-488506.iam.gserviceaccount.com \
  --set-env-vars "UPSTREAM=${UPSTREAM},AUDIENCE=${AUDIENCE}" \
  --memory 256Mi --max-instances 3 --min-instances 0
```

## スモーク

```bash
RECV_URL=$(gcloud run services describe lb-v2-receiver --region asia-northeast1 --format='value(status.url)')
curl -sS "$RECV_URL/healthz"
# 許可外パスは 404（リレー自身が遮断）
curl -sS -o /dev/null -w "%{http_code}\n" "$RECV_URL/api/v2/matters"
# 許可パスは本体まで届く（webhook token 未設定の間は本体が 404 を返す＝経路開通の確認になる）
curl -sS -X POST "$RECV_URL/internal/webhooks/backlog" -H "Content-Type: application/json" -d '{}'
```

## 外部サービスへの登録（本体側の secret 設定・点火後）

- Backlog: プロジェクト設定 → Webhook → `https://<RECV_URL>/internal/webhooks/backlog?token=<BACKLOG_WEBHOOK_TOKEN>`
  （または `X-Webhook-Token` ヘッダ）
- CloudSign: Webhook URL → `https://<RECV_URL>/internal/webhooks/cloudsign`（トークンはヘッダ/クエリ）
- Slack App: slash commands／Interactivity の Request URL → `https://<RECV_URL>/internal/slack/…`
  （検証は signing secret）
