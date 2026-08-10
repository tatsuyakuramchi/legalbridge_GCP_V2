# Phase 9 自動化基盤 点火ランブック（Cloud Scheduler / Webhook）

Phase 9（督促・満了・検収・CloudSign 同期・外部 Webhook）を **既存の Profile D デプロイに
上乗せ**で点火するための手順書。GRANT 030〜032 適用 → シークレット作成 → 再デプロイ →
Cloud Scheduler ジョブ登録 → スモークまで。

対象サービス：`legalbridge-v2-write-test`（本番 `legalbridge` DB・Cloud Run IAM 認証）。
前提：`docs/phase8-matter-deploy-profileD-cloudshell.md` の Profile D が適用済み
（revision が 100% トラフィックで稼働中）。

---

## 0｜構成マップ（何を点火するか）

| 機能 | エンドポイント / runner | 起動方法 | 必要 GRANT | 必要フラグ | 破壊性 |
|---|---|---|---|---|---|
| 督促アラート（納期・契約更新通告） | `POST /internal/jobs/daily-checks` | Cloud Scheduler | 030 | `JOBS_ENABLED` | 台帳のみ（本番不変） |
| 満了ステータス自動遷移 | daily-checks 内 | （同上） | 031 | `CONTRACT_EXPIRY_TRANSITION_ENABLED` | **本番 documents UPDATE**（opt-in） |
| 検収待ちダイジェスト | `POST /internal/jobs/inspection-digest` | Cloud Scheduler | 不要 | `JOBS_ENABLED` | なし（読取のみ） |
| CloudSign 一括同期 | `POST /internal/jobs/cloudsign-sync` | Cloud Scheduler | 022(既) + 031 | `JOBS_ENABLED` + CloudSign live | 締結時のみ契約 executed |
| CloudSign 締結 Webhook | `POST /internal/webhooks/cloudsign` | 外部（CloudSign） | 032 + 031 | `CLOUDSIGN_WEBHOOK_TOKEN` | 締結時のみ契約 executed |
| Backlog 課題 Webhook | `POST /internal/webhooks/backlog` | 外部（Backlog） | 032 | `BACKLOG_WEBHOOK_TOKEN` | なし（Slack 通知のみ） |

- すべて **既定 OFF**。`/internal/*` はユーザー認証をバイパスし、**共有シークレット**（`X-Jobs-Token` /
  `X-Webhook-Token`）で保護する。
- **ジョブ（Cloud Scheduler）は今すぐ点火できる**（Scheduler が OIDC を提示できるため）。
- **Webhook は公開到達性の判断が要る**（§7 の注意を必読）。まずジョブだけ点火する構成を推奨。

---

## 1｜リポジトリ最新化 & 管理接続

```bash
cd ~/legalbridge_gcp_v2
git fetch origin && git checkout claude/github-analysis-development-1s2tht
git pull origin claude/github-analysis-development-1s2tht
git log --oneline -1
```

Cloud SQL Auth Proxy 起動 → 管理 DSN 設定は Profile D ランブックの Step 1〜2 と同一：

```bash
# 例（v2 proxy が居る場合）
cloud-sql-proxy legalbridge-488506:asia-northeast1:legalbridge-db &
export RUNTIME_ADMIN_DSN="postgresql://<管理ユーザー>:<パスワード>@127.0.0.1:5432/legalbridge"
psql "$RUNTIME_ADMIN_DSN" -c "select current_database(), current_user;"
```

---

## 2｜本番 GRANT 適用（030 / 031 / 032・冪等）

```bash
# 030: 督促アラート台帳（lb_v2_job_alert_ledger・CREATE＋GRANT SELECT/INSERT）
psql "$RUNTIME_ADMIN_DSN" -v confirm_job_alert_ledger=GRANT_PRODUCTION_JOB_ALERT_LEDGER \
  -f infra/gcp/sql/030_job_alert_ledger_production_grants.sql

# 032: Webhook べき等台帳（lb_v2_webhook_receipts・CREATE＋GRANT SELECT/INSERT）
#      CloudSign 同期(cloudsign-sync)の締結→executed でも 031 を使うため、Webhook を使わなくても
#      CloudSign 同期を回すなら 031 は必要（下記）。032 は Webhook を使う場合のみ。
psql "$RUNTIME_ADMIN_DSN" -v confirm_webhook_receipts=GRANT_PRODUCTION_WEBHOOK_RECEIPTS \
  -f infra/gcp/sql/032_webhook_receipts_production_grants.sql

# 031: 契約状態 UPDATE（documents.contract_status 列レベル）。
#      満了遷移(9-3)・CloudSign 締結→executed(9-5/9-6)で共用。まず preflight で影響件数を確認。
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/031_production_contract_expiry_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_contract_expiry=GRANT_PRODUCTION_CONTRACT_EXPIRY \
  -f infra/gcp/sql/031_production_contract_expiry_grants.sql
```

> **最小構成で始めるなら**：030 のみ適用（督促＋検収ダイジェストが回る・本番不変）。
> CloudSign 締結の自動反映（同期/Webhook）を使う段で 031、Webhook を公開する段で 032 を追加。

---

## 3｜共有シークレットを Secret Manager に作成

トークンは十分な乱数で。既存 secret がある場合は `create` の代わりに `versions add`。
ランタイム SA（`legalbridge-v2-preview@…`）に `secretAccessor` を付与する。

```bash
SA=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com

# Cloud Scheduler 用（ジョブ点火に必須）
JOBS_TOKEN=$(openssl rand -hex 32)
printf '%s' "$JOBS_TOKEN" | gcloud secrets create JOBS_TRIGGER_TOKEN --data-file=- \
  --replication-policy=automatic 2>/dev/null \
  || printf '%s' "$JOBS_TOKEN" | gcloud secrets versions add JOBS_TRIGGER_TOKEN --data-file=-
gcloud secrets add-iam-policy-binding JOBS_TRIGGER_TOKEN \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor

# Webhook 用（§7 を読んでから・使う場合のみ）
CS_WEBHOOK_TOKEN=$(openssl rand -hex 32)
printf '%s' "$CS_WEBHOOK_TOKEN" | gcloud secrets create CLOUDSIGN_WEBHOOK_TOKEN --data-file=- \
  --replication-policy=automatic 2>/dev/null \
  || printf '%s' "$CS_WEBHOOK_TOKEN" | gcloud secrets versions add CLOUDSIGN_WEBHOOK_TOKEN --data-file=-
gcloud secrets add-iam-policy-binding CLOUDSIGN_WEBHOOK_TOKEN \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor

BL_WEBHOOK_TOKEN=$(openssl rand -hex 32)
printf '%s' "$BL_WEBHOOK_TOKEN" | gcloud secrets create BACKLOG_WEBHOOK_TOKEN --data-file=- \
  --replication-policy=automatic 2>/dev/null \
  || printf '%s' "$BL_WEBHOOK_TOKEN" | gcloud secrets versions add BACKLOG_WEBHOOK_TOKEN --data-file=-
gcloud secrets add-iam-policy-binding BACKLOG_WEBHOOK_TOKEN \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

`$JOBS_TOKEN` は §5 の Scheduler ヘッダーに使うため控えておく（後から
`gcloud secrets versions access latest --secret=JOBS_TRIGGER_TOKEN` でも取得可）。

---

## 4｜再デプロイ（Profile D の substitutions に上乗せ）

Profile D の `gcloud builds submit`（`docs/phase8-matter-deploy-profileD-cloudshell.md` Step 4）の
`^|^…` 文字列の **末尾に**、下記を追記して再実行する。`_WRITE_SCOPES` の正準順は変えない。

**ジョブ最小構成（推奨・まずこれ）**：
```
|_JOBS_ENABLED=true|_JOBS_TRIGGER_TOKEN_SECRET=JOBS_TRIGGER_TOKEN
```

**満了遷移も有効化する場合**（031 適用済みが前提）：
```
|_CONTRACT_EXPIRY_TRANSITION_ENABLED=true|_CONFIRM_CONTRACT_EXPIRY=CONTRACT_EXPIRY_LEGALBRIDGE_VALIDATION_ONLY
```

**Webhook も有効化する場合**（§7 の到達性を解決済みが前提・032 適用済み）：
```
|_CLOUDSIGN_WEBHOOK_TOKEN_SECRET=CLOUDSIGN_WEBHOOK_TOKEN|_BACKLOG_WEBHOOK_TOKEN_SECRET=BACKLOG_WEBHOOK_TOKEN
```

> verify ゲート：`JOBS_ENABLED=true` は write-test 限定＋`JOBS_TRIGGER_TOKEN_SECRET` 必須＋IAP/IAM。
> `CONTRACT_EXPIRY_TRANSITION_ENABLED=true` は確認トークン＋`JOBS_ENABLED=true`＋本番 DB 一致＋IAP/IAM。
> Webhook secret を設定すると write-test 限定でマウントされる。既定（BLOCKED）は挙動不変。

デプロイ後、cloudsign-sync は CloudSign live（Profile D で `CLOUDSIGN_MODE=live` かつ client_id/baseUrl 設定時）
かつ送信履歴台帳（`CLOUDSIGN_REQUEST_HISTORY_ENABLED=true`）がある時のみ登録される。

---

## 5｜Cloud Scheduler ジョブ登録

サービス URL と invoker を用意（Scheduler が OIDC でサービスを呼べるように run.invoker を付与）：

```bash
SVC_URL=$(gcloud run services describe legalbridge-v2-write-test --region asia-northeast1 \
  --format='value(status.url)')
SA=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com
gcloud run services add-iam-policy-binding legalbridge-v2-write-test --region asia-northeast1 \
  --member="serviceAccount:$SA" --role=roles/run.invoker
JOBS_TOKEN=$(gcloud secrets versions access latest --secret=JOBS_TRIGGER_TOKEN)
```

各ジョブは **OIDC（Cloud Run IAM）＋ `X-Jobs-Token`（共有シークレット）の二重**で保護する。

```bash
# 督促アラート：平日 09:00 JST
gcloud scheduler jobs create http lb-v2-daily-checks \
  --location asia-northeast1 --time-zone "Asia/Tokyo" --schedule "0 9 * * 1-5" \
  --uri "$SVC_URL/internal/jobs/daily-checks" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$SVC_URL" \
  --headers "X-Jobs-Token=$JOBS_TOKEN,Content-Type=application/json" --message-body '{}'

# 検収待ちダイジェスト：平日 09:05 JST
gcloud scheduler jobs create http lb-v2-inspection-digest \
  --location asia-northeast1 --time-zone "Asia/Tokyo" --schedule "5 9 * * 1-5" \
  --uri "$SVC_URL/internal/jobs/inspection-digest" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$SVC_URL" \
  --headers "X-Jobs-Token=$JOBS_TOKEN,Content-Type=application/json" --message-body '{}'

# CloudSign 一括同期：3 時間ごと（CloudSign live 時のみ意味を持つ・未構成なら no-op）
gcloud scheduler jobs create http lb-v2-cloudsign-sync \
  --location asia-northeast1 --time-zone "Asia/Tokyo" --schedule "0 */3 * * *" \
  --uri "$SVC_URL/internal/jobs/cloudsign-sync" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$SVC_URL" \
  --headers "X-Jobs-Token=$JOBS_TOKEN,Content-Type=application/json" --message-body '{}'
```

> **daily-checks は Profile D では live 送信**（`SLACK_DELIVERY_MODE=live`）＝法務相談チャンネルへ
> 実投稿する。初回は §6 の手動実行で内容を確認してから Scheduler を有効化するのが安全。
> 一時的に投稿を止めたい場合は `gcloud scheduler jobs pause lb-v2-daily-checks`。

---

## 6｜スモークテスト（手動実行）

Scheduler を待たずに手動で叩いて summary を確認する（実行ユーザーに run.invoker が必要）：

```bash
SVC_URL=$(gcloud run services describe legalbridge-v2-write-test --region asia-northeast1 --format='value(status.url)')
JOBS_TOKEN=$(gcloud secrets versions access latest --secret=JOBS_TRIGGER_TOKEN)
ID=$(gcloud auth print-identity-token)

# 督促（live なら Slack へ投稿される点に注意）
curl -s -X POST -H "Authorization: Bearer $ID" -H "X-Jobs-Token: $JOBS_TOKEN" \
  "$SVC_URL/internal/jobs/daily-checks" | jq
#  期待: {ok:true, name:"daily-checks", result:{dryRun,deliveryAlerts,contractAlerts,sent,failed,
#         recorded,expiredTransitions,expiryForbidden}}

curl -s -X POST -H "Authorization: Bearer $ID" -H "X-Jobs-Token: $JOBS_TOKEN" \
  "$SVC_URL/internal/jobs/inspection-digest" | jq

curl -s -X POST -H "Authorization: Bearer $ID" -H "X-Jobs-Token: $JOBS_TOKEN" \
  "$SVC_URL/internal/jobs/cloudsign-sync" | jq
#  CloudSign 未 live なら result.configured=false（no-op）

# 認可の確認：トークン無しは 401、無効ジョブ名は 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $ID" \
  "$SVC_URL/internal/jobs/daily-checks"                     # → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $ID" \
  -H "X-Jobs-Token: $JOBS_TOKEN" "$SVC_URL/internal/jobs/nope"   # → 404
```

`expiryForbidden > 0` は 031 未適用（満了遷移フラグ ON なのに GRANT 無し）を意味する → §2 の 031 を実行。

---

## 7｜外部 Webhook の公開到達性（重要・要判断）

CloudSign / Backlog は **Google OIDC トークンを提示できない**。現行サービスは
`--no-allow-unauthenticated`（Cloud Run IAM）で保護されているため、外部からの Webhook は
**アプリのシェアードシークレット検証に届く前に Cloud Run IAM 層で 403** になる。

したがって Webhook を実際に受けるには、次のいずれかを先に決める必要がある：

- **(A) 専用の公開経路を用意**：Webhook 受信専用に別サービス／リビジョン（`--allow-unauthenticated`）を
  立て、共有シークレットのみで保護。アプリのコードは同一（`/internal/webhooks/*`）。
- **(B) API Gateway / Cloud Endpoints を前段**に置き、トークン検証＋バックエンド（IAM 認証）へ橋渡し。
- **(C) 当面 Webhook は無効のまま**、CloudSign は §5 の **cloudsign-sync（ポーリング）で代替**。
  Backlog は既存 readonly 取込（Phase 3）で運用。→ **検証フェーズの推奨**。

> したがって §4 の Webhook substitutions と §2 の 032 は、(A)/(B) を決めるまで **適用しない**。
> ジョブ（Scheduler）は上記制約と無関係にそのまま点火できる。
> (A)/(B) 決定後、CloudSign/Backlog 管理画面で Webhook URL（`<公開URL>/internal/webhooks/{cloudsign,backlog}`）
> と `X-Webhook-Token` を登録する。

---

## 8｜個別停止・ロールバック

- **ジョブ一時停止**：`gcloud scheduler jobs pause lb-v2-daily-checks`（`resume` で再開）。
- **ジョブ削除**：`gcloud scheduler jobs delete lb-v2-daily-checks`。
- **機能全体 OFF**：`_JOBS_ENABLED=false` で再デプロイ → `/internal/jobs/*` が 404（Scheduler は 404 を受ける）。
- **満了遷移だけ OFF**：`_CONTRACT_EXPIRY_TRANSITION_ENABLED=false` で再デプロイ（督促・検収は継続）。
- **Webhook だけ OFF**：該当 secret substitution を外す（未マウント＝token 無し＝404 で自動無効）。
- GRANT は残置してもフラグ OFF で書込み経路は塞がる。台帳（030/032）は append-only・破壊操作なし。

---

## 9｜トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| ジョブが 404（Scheduler ログ） | `_JOBS_ENABLED=true` 未反映、またはジョブ名の綴り違い。再デプロイ／URI 確認。 |
| ジョブが 401 | `X-Jobs-Token` 不一致。Scheduler ヘッダーと secret 最新版を突合。 |
| Scheduler が 403（PERMISSION_DENIED） | invoker SA に run.invoker 未付与、または OIDC audience がサービス URL 不一致。 |
| `result.expiryForbidden > 0` | 031 未適用。§2 の 031 を実行。 |
| `result.configured=false`（cloudsign-sync） | CloudSign が live 未構成、または履歴台帳 OFF。Profile D の CloudSign 変数を確認。 |
| verify が `Jobs endpoint blocked: …` | write-test 以外／token 未設定／AUTH_MODE が iap・cloudrun-iam でない。 |
| Webhook が届かない | §7 の到達性（Cloud Run IAM が外部を拒否）。(A)/(B) を未決なら (C) で運用。 |
