# 締結済契約取込 書込みデプロイ手順

締結済イン契約の登録、後日のアウト条件追記、個別利用許諾条件書・利用許諾料明細書の作成を、本番`legalbridge` DBへ書込む形で有効化するための手順である。`infra/gcp/cloudbuild-write-test.yaml`の`verify-isolation`ゲートを通過した場合だけデプロイされる。

## 1. この構成で有効になる範囲

`WRITE_SCOPES=drafts,documents,pdf,contract-intake`、`CONTRACT_INTAKE_WRITES_ENABLED=true`のとき、`legalbridge_v2_runtime`ロールで次の書込みが有効になる。

- 締結済イン契約の登録：`POST /api/v2/contract-intakes`（`works / work_materials / material_categories / material_rights_sources / contracts / contract_works / work_relations / documents / condition_lines(in) / condition_line_regions / condition_line_languages / document_sequences`へINSERT）
- 登録済み契約へのアウト条件追記：`POST /api/v2/contract-intakes/:documentId/outbound-conditions`（`condition_lines(out) / condition_line_regions / condition_line_languages`へINSERTのみ、既存行の更新・削除なし）
- 文書下書き生成：`POST /api/v2/contract-intakes/:documentId/document-drafts`（`drafts`スコープ併用）
- 文書確定・発番、PDF：`documents`・`pdf`スコープ

いずれも管理者ロール限定で、確定登録は合言葉`COMMIT_PRODUCTION_CONTRACT_INTAKE`を要求する。検証（`/validate`）とDBプリフライト（`/preflight`）は書込みゲートが無効でも読取だけ実行できる。Slack・Backlog・Drive・Gmail・CloudSignへの送信は行わない。

## 2. 常時維持する安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ
- アプリは登録後の自動削除・上書きをしない（アウト条件は`condition_lines`へ追記のみ）
- Cloud Runは`--no-allow-unauthenticated`、認証は`cloudrun-iam`または`iap`
- 有効スコープは`WRITE_SCOPES`と完全一致でなければデプロイを停止する

## 3. 前提条件（デプロイ前に完了）

1. **ランタイムロール**：`legalbridge_v2_runtime`を作成済み（006/007は存在前提。パスワードはSecret Manager外へ残さない）。
2. **権限付与（preflightで確認後に本付与）**：

   ```bash
   # 読取専用preflight（変更なし）
   psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/006_production_v2_runtime_privileges_preflight.sql
   psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/007_production_contract_intake_privileges_preflight.sql

   # 本付与（documents / condition_lines / sequences 等）
   psql "$RUNTIME_ADMIN_DSN" \
     -v confirm_production_v2_runtime=CREATE_PRODUCTION_V2_RUNTIME_FOUNDATION \
     -f infra/gcp/sql/006_production_v2_runtime_foundation.sql

   # 本付与（works / materials / contracts / contract_works / condition_line_* 等）
   psql "$RUNTIME_ADMIN_DSN" \
     -v confirm_contract_intake_grants=GRANT_PRODUCTION_CONTRACT_INTAKE \
     -f infra/gcp/sql/007_production_contract_intake_grants.sql
   ```

   006はアウト条件が使う`condition_lines`のINSERTと`condition_lines_id_seq`も付与する。007は`condition_line_regions/languages`とその各sequenceを付与する。両方の適用でイン登録・アウト追記の両方が揃う。

3. **Secret Manager**：`legalbridge-v2-runtime-db-password`にランタイムパスワードを登録し、デプロイに使うサービスアカウントへ`secretmanager.secretAccessor`を付与。
4. **認証**：`cloudrun-iam`検証では単一管理者`tatsuya.kuramochi@arclight.co.jp`。利用者へ`roles/run.invoker`を付与。
5. **本番文書テーブルpreflight**：`005_production_v2_cutover_preflight.sql`で件数・スキーマを確認済み（`_CONFIRM_DOCUMENT_TABLES`の根拠）。

## 4. デプロイ（Cloud Run IAM 検証構成）

`_WRITE_SCOPES`の値がカンマを含むため、`--substitutions`の区切り文字を`^|^`で`|`に変更する（既定のカンマ区切りだと`documents`以降がキー扱いになり`Bad syntax for dict arg`で失敗する）。値全体をダブルクオートで囲み、`|`がシェルのパイプに解釈されないようにする。

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild-write-test.yaml \
  --project=legalbridge-488506 \
  --substitutions="^|^_REGION=asia-northeast1|_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=cloudrun-iam|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY|_WRITE_SCOPES=drafts,documents,pdf,contract-intake|_CONTRACT_INTAKE_WRITES_ENABLED=true|_CONFIRM_CONTRACT_INTAKE_WRITES=CONTRACT_INTAKE_LEGALBRIDGE_VALIDATION_ONLY"
```

その他のsubstitution（Slack・Backlog・Outbound専用DB等）は既定の`BLOCKED`/`false`のままにする。

> 既存のアウト条件書込み（別モジュール`OUTBOUND_CONDITION_WRITES_ENABLED`）を同じサービスで併用する場合は、`|_WRITE_SCOPES=drafts,documents,pdf,outbound-conditions,contract-intake|_OUTBOUND_CONDITION_WRITES_ENABLED=true|_CONFIRM_OUTBOUND_WRITES=OUTBOUND_WRITES_LEGALBRIDGE_VALIDATION_ONLY|_OUTBOUND_DB_NAME=legalbridge|_OUTBOUND_DB_USER=legalbridge_v2_runtime|_OUTBOUND_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password`を追加する（本番モードではアウト側ユーザー/Secretも`legalbridge_v2_runtime`）。

`verify-isolation`は次を検証する。

- サービスが`legalbridge-v2-write-test`、DBが`legalbridge`、ユーザーが`legalbridge_v2_runtime`、パスワードSecretが一致
- `AUTH_MODE`が`cloudrun-iam`または`iap`（`disabled`不可）
- `WRITE_SCOPES`が有効化した能力（`drafts,documents,pdf,contract-intake`）と完全一致

> 注：アウト条件追記は本番`legalbridge` DBの`condition_lines`へ書くため、別DBの`OUTBOUND_CONDITION_WRITES_ENABLED`は不要。`contract-intake`スコープだけで有効になる。

## 5. デプロイ後の検証

```bash
# サービスURLとIDトークンを取得し、認証付きで確認
SERVICE_URL=$(gcloud run services describe legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)

# 1) /health
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/health" | python3 -m json.tool

# 2) 新リビジョンの確認：登録済み契約一覧APIがJSON {"items": [...]} を返す
#    （旧イメージにはこのGETルートが無く、本番モードではSPAのHTMLを返すため区別できる）
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/contract-intakes" | python3 -m json.tool
```

`/health`が次を返すこと。

- `accessMode: "readwrite"`
- `writeCapabilities`に`drafts`,`documents`,`pdf`,`contract-intake`が含まれる
- `database.currentDatabase: "legalbridge"`、`database.readOnly: false`、`database.reachable: true`
- ステータス200（read-only不一致・DB到達不能なら503）

`/api/v2/runtime`で`writeFeaturesEnabled: true`、`authMode: "cloudrun-iam"`を確認する。

### ブラウザでUIを開く

サービスは`--no-allow-unauthenticated`のため、認証付きプロキシ経由でUIを開く。

```bash
gcloud run services proxy legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --port=8080
```

Cloud Shellでは起動後に「ウェブでプレビュー → ポート 8080」で開く。`cloudrun-iam`モードにより、`_AUTH_ADMIN_EMAILS`で指定した単一管理者として扱われる。

## 6. 運用フロー（イン先確定 → アウト後日）

1. 「契約取込」画面で締結済イン契約を登録（原作・素材・自社作品・イン条件）。確定は管理者＋合言葉。
2. 登録直後は利用許諾料明細書の下書きを作成できる。
3. 許諾先が決まった段階で、下部「登録済み契約から文書を作成」で対象契約を選び、アウト条件を追記する（本番DBへINSERT）。
4. アウト条件追記後、個別利用許諾条件書の下書きを許諾先ごとに作成する。
5. 下書き→確定→（必要ならPDF）は既存フローを使う。

## 7. 切戻し・無効化

- 直前リビジョンへ戻す：

  ```bash
  gcloud run revisions list --service=legalbridge-v2-write-test \
    --region=asia-northeast1 --project=legalbridge-488506
  gcloud run services update-traffic legalbridge-v2-write-test \
    --region=asia-northeast1 --project=legalbridge-488506 \
    --to-revisions=KNOWN_GOOD_REVISION=100
  ```

- 書込みを止める：`CONTRACT_INTAKE_WRITES_ENABLED=false`かつ`WRITE_SCOPES`から`contract-intake`を除いて再デプロイ、または`WRITE_FEATURES_ENABLED=false`。
- DBレコードは自動巻戻ししない。誤登録時は登録ID（`contractId`/`documentId`/`condition_lines`）を記録し、DB側で個別対応する。

詳細な段階開放ゲートは[Production Readiness Runbook](production-readiness.md)を参照。
