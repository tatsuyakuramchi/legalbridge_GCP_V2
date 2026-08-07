# CloudSign 点火 Runbook（write-test サービス・検証点火）

CloudSign 電子署名依頼を **write-test サービスで検証点火**するための手順。API契約は V1 実装に突合済み（5-6）、送信冪等＋宛先allowlist も実装済み（5-7）。CloudSign は文書PDFを実描画して外部送信する不可逆操作のため、多重ゲート＋宛先allowlist で守る。

> 前提知識：`docs/gmail-cloudsign.md`（ゲート概要）、`docs/phase5-integration-readiness.md`（⑤）、`docs/phase5-db-followups.md` §D（grant 022）。

## 0. 発火に必要な全条件（多重ゲート）

すべて満たしたときだけ実発火する：

1. `INTEGRATION_MODE=live`（総元栓）
2. `CLOUDSIGN_MODE=live` ＋ 実 `CLOUDSIGN_CLIENT_ID`
3. `WRITE_SCOPES` に `cloudsign`
4. 確認トークン `CONFIRM_CLOUDSIGN_DISPATCH=CLOUDSIGN_DISPATCH_VALIDATION_ONLY`
5. 実行ロール `admin`（dispatch は admin 限定）
6. **宛先allowlist `CLOUDSIGN_ALLOWED_RECIPIENTS`（検証点火では verify が必須化）**
7. ゲート通過（文書が確定済み等）

## 1. 事前準備

1. **CloudSign `client_id`** を入手（本番 or sandbox）。sandbox は `_CLOUDSIGN_BASE_URL=https://api-sandbox.cloudsign.jp`。
2. **宛先allowlist**：検証中に実送信してよい自分・社内の署名者メールをカンマ区切りで用意（例：`tatsuya.kuramochi@arclight.co.jp`）。
3. **冪等履歴テーブル（任意だが推奨）**：grant 022 を本番へ適用（`docs/phase5-db-followups.md` §D）。適用済みなら `_CLOUDSIGN_REQUEST_HISTORY_ENABLED=true`、未適用なら `=false`（冪等は無効・毎回送信）。
   ```bash
   psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/022_cloudsign_request_history_production_preflight.sql || true
   psql "$RUNTIME_ADMIN_DSN" -v confirm_cloudsign_history=GRANT_PRODUCTION_CLOUDSIGN_HISTORY \
     -f infra/gcp/sql/022_cloudsign_request_history_production_grants.sql
   ```
4. **確定済み文書**が最低1件あること（dispatch は `documents` を描画して送る）。無ければ先に文書を確定。
5. Google SA/DWD は **不要**（CloudSign は `client_id` 認証。Drive/Gmail のような鍵委任は使わない）。

## 2. デプロイ（write-test・本番DB primary）

契約取込の本番デプロイ（`docs/contract-intake-deploy.md`）と同じ土台に、`cloudsign` スコープと CloudSign 変数、`_INTEGRATION_MODE=live` を足す。`--substitutions` はカンマを含むため区切りを `^|^` にし、値全体をダブルクオートで囲む。

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild-write-test.yaml \
  --substitutions="^|^_REGION=asia-northeast1|_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=cloudrun-iam|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY|_INTEGRATION_MODE=live|_WRITE_SCOPES=drafts,documents,pdf,cloudsign|_CLOUDSIGN_MODE=live|_CONFIRM_CLOUDSIGN_DISPATCH=CLOUDSIGN_DISPATCH_VALIDATION_ONLY|_CLOUDSIGN_CLIENT_ID=<実client_id>|_CLOUDSIGN_ALLOWED_RECIPIENTS=tatsuya.kuramochi@arclight.co.jp|_CLOUDSIGN_REQUEST_HISTORY_ENABLED=true"
```

- sandbox で試すなら `|_CLOUDSIGN_BASE_URL=https://api-sandbox.cloudsign.jp` を追加。
- `verify-isolation` ゲートが通らなければデプロイされない。特に **allowlist 未設定だと live で停止**する（意図通り）。

## 3. 検証（スモークテスト）

1. **能力ON確認**：`GET /api/v2/runtime` の `writeCapabilities` に `cloudsign`。`GET /api/v2/admin/diagnostics` の `externalWritesDisabled=false`（＝`INTEGRATION_MODE=live`）。
2. **プレビュー（送信しない）**：
   ```
   POST /api/v2/documents/<id>/cloudsign/preview
   { "participants": [ { "email": "tatsuya.kuramochi@arclight.co.jp", "name": "倉持" } ] }
   ```
   → 署名者・文書タイトル・ゲート状態が返る。
3. **許可外拒否の確認**：allowlist 外のメールで dispatch → `422 CLOUDSIGN_RECIPIENT_NOT_ALLOWED`（送信されないこと）。
4. **実依頼（admin）**：allowlist 内の宛先で dispatch → `201`＋`receipt.cloudSignDocumentId`。CloudSign 側に下書き→送信が作成される。
5. **冪等確認**：同一文書で再 dispatch → `200`＋`integrations.cloudsign="duplicate"`（二重送信されないこと）。
6. **ステータス取込**：`GET /api/v2/cloudsign/<cloudSignDocumentId>/status` → `status`（draft/sent/completed…）。履歴有効時は台帳の status も更新される。

## 4. ロールバック

- 送信停止：`_CLOUDSIGN_MODE=disabled`（または `_WRITE_SCOPES` から `cloudsign` を外す、あるいは `_INTEGRATION_MODE=local` で送信系一括停止）→ 再デプロイ。
- 冪等履歴の無効化：`_CLOUDSIGN_REQUEST_HISTORY_ENABLED=false`。台帳テーブルは隔離・append のため残置で無害。

## 5. 既知の非対応（必要時に追加）

- reportees（CC共有先）は V2 未実装（V1 の `addReportee` 相当）。
- 署名者の署名順（`order`）・言語（`language_code`）指定は未対応（V1 は対応）。現状は email/name/organization のみ。
