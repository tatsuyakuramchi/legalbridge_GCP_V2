# Google Drive 連携（V1準拠）

確定文書PDFを共有ドライブへ保存するDrive連携の設定手順。認証・スコープ・共有ドライブの扱いは V1（`LegalBridge_AI_GCP` の `googleDriveService.ts`）に合わせている。

## 1. V1に合わせた実装

`apps/legalbridge/src/server/documents/drive-storage.ts` の `GoogleDriveStorage`：

- **認証優先順位**（V1と同一）
  1. `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`（実在する鍵ファイル）— Secret Managerからマウントした専用Workspace SA。ランタイムSAがDrive未許可のときの本命
  2. `GOOGLE_APPLICATION_CREDENTIALS`（ADC）
  3. Cloud Run / メタデータのランタイムSA
- **スコープはフル `https://www.googleapis.com/auth/drive`**（`drive.file` だと人が作成して共有しただけの既存フォルダを `parents` 指定できず404になる）
- **共有ドライブ必須**：全呼び出しで `supportsAllDrives=true`。SAは個人Drive容量が0なので、**SAに共有された共有ドライブ内フォルダ**へ書く
- **webViewLink合成**：共有ドライブ内バイナリでは空で返ることがあるため、`file id` から `https://drive.google.com/file/d/<id>/view` を合成
- 文書IDは `appProperties.legalbridgeDocumentId` で冪等管理（再確定時は再アップロードしない）

`google-auth-library` を利用（`googleapis` フルではなく認証のみの軽量パッケージ）。

## 2. 環境変数

| 変数 | 用途 |
|---|---|
| `GOOGLE_DRIVE_FOLDER_ID` | 保存先の共有ドライブ フォルダID |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | 専用SA鍵のマウントパス（例 `/secrets/gws-service-account.json`）。未設定/不在ならADCへフォールバック |
| `DRIVE_ENVIRONMENT_TAG` | 保存ファイルの `appProperties.legalbridgeEnvironment`（既定 `validation`） |

## 3. 前提（V1の資産を再利用）

V1が本番で使っている**専用Workspace SA鍵**と**共有ドライブフォルダ**をそのまま再利用するのが最短。フォルダはSAへ共有済みなので追加共有は不要。

```bash
# V1 worker から実フォルダIDと鍵Secret名を確認（値は環境依存）
gcloud run services describe legalbridge-document-worker \
  --region=asia-northeast1 --project=legalbridge-488506 \
  --format="yaml(spec.template.spec.containers[0].env, spec.template.spec.volumes)"
# → GOOGLE_DRIVE_FOLDER_ID と、マウントしている Secret 名（gws-service-account 等）を控える
```

デプロイに使うSA（`legalbridge-v2-preview@…`）へ、その鍵Secretのアクセス権を付与：

```bash
gcloud secrets add-iam-policy-binding <GWS_SA_KEY_SECRET> \
  --member="serviceAccount:legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project=legalbridge-488506
```

> 別SA鍵/別フォルダにする場合は、共有ドライブのフォルダをその鍵のSAメール（`client_email`）へ「コンテンツ管理者」で共有する。共有が無いと権限があっても `files.create` が404/403になる（V1で確認済み）。

## 4. デプロイ（契約取込 + Drive を同一サービスで有効化）

`cloudbuild-write-test.yaml` の Drive ゲートを通す。`--substitutions` はカンマを含むため `^|^` 区切り＋ダブルクオート（[契約取込デプロイ手順](contract-intake-deploy.md) と同様）。`<...>` は実値へ置換。

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild-write-test.yaml \
  --project=legalbridge-488506 \
  --substitutions="^|^_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=cloudrun-iam|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY|_WRITE_SCOPES=drafts,documents,pdf,drive,contract-intake|_CONTRACT_INTAKE_WRITES_ENABLED=true|_CONFIRM_CONTRACT_INTAKE_WRITES=CONTRACT_INTAKE_LEGALBRIDGE_VALIDATION_ONLY|_DRIVE_STORAGE_ENABLED=true|_CONFIRM_DRIVE_STORAGE=DRIVE_LEGALBRIDGE_VALIDATION_ONLY|_GOOGLE_DRIVE_FOLDER_ID=<SHARED_DRIVE_FOLDER_ID>|_GWS_SA_KEY_SECRET=<GWS_SA_KEY_SECRET>|_DRIVE_ENVIRONMENT_TAG=validation"
```

`verify-isolation` の Drive ゲートは、サービス名・フォルダID/鍵Secretの設定・認証（iap/cloudrun-iam）・`WRITE_SCOPES` に `drive` を含むことを検証する。デプロイ時、鍵Secretは `/secrets/gws-service-account.json` にファイルとしてマウントされる。

> `WRITE_SCOPES` の順序は `drafts,documents,pdf,drive,…` に合わせる（`verify-isolation` は完全一致で照合）。

## 5. 検証

```bash
SERVICE_URL=$(gcloud run services describe legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/health" | python3 -m json.tool
```

- `writeCapabilities` に `drive` が含まれる
- 文書を1件確定し、レスポンスの `integrations.drive` が保存済みリンクになる（初回は保存、再確定は既存リンク）
- 共有ドライブの対象フォルダにPDFが作成され、`webViewLink` が開ける

## 6. 無効化・切戻し

- 一時停止：`_DRIVE_STORAGE_ENABLED=false` かつ `WRITE_SCOPES` から `drive` を除いて再デプロイ
- 直前リビジョンへ戻す手順は[契約取込デプロイ手順](contract-intake-deploy.md#7-切戻し無効化)と同じ
