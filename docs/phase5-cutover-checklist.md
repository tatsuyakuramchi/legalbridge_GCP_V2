# Phase 5 載せ替え・最終デプロイ チェックリスト（1枚）

外部連携（Gmail送受信 / CloudSign / Slack）を write-test サービスで点火するための、
DB 作業 → シークレット → ネットワーク → デプロイ → 点火 → 検証 → 切戻しの一気通貫手順。
**外部送信は不可逆**。各ステップを順に、チェックを付けながら実施する。

- 対象サービス：`legalbridge-v2-write-test`（本番DB `legalbridge` primary）
- プロジェクト：`legalbridge-488506` / リージョン：`asia-northeast1`
- 管理接続 `RUNTIME_ADMIN_DSN`：DDL/GRANT 権限を持つ Cloud SQL 管理接続
- コードは本ブランチ HEAD を使用（マージ後にデプロイする運用なら既定ブランチへマージしてから）

---

## 0. 事前確認（コード）

- [ ] `cd apps/legalbridge && npm ci && npm run typecheck && npm test && npm run build` が全緑
- [ ] `git status` がクリーン（未コミットなし）・対象ブランチが origin に push 済み
- [ ] `git log --oneline -1` が想定コミット

## 1. DB 作業（preflight → 本適用。順不同で A/B/D、C は 021→023）

いずれも `psql "$RUNTIME_ADMIN_DSN" -f <preflight>` で現状確認 → 本適用。詳細は `phase5-db-followups.md`。

- [ ] **A. Gmail送信履歴** `019_gmail_send_history_production_grants.sql`
      `-v confirm_gmail_send_history=GRANT_PRODUCTION_GMAIL_SEND_HISTORY`
- [ ] **B. 受信取込台帳** `020_inbound_contract_intake_production_grants.sql`
      `-v confirm_inbound_intake=GRANT_PRODUCTION_INBOUND_INTAKE`
- [ ] **D. CloudSign依頼履歴** `022_cloudsign_request_history_production_grants.sql`
      `-v confirm_cloudsign_history=GRANT_PRODUCTION_CLOUDSIGN_HISTORY`
- [ ] **C. 依頼者メール露出**：まず `021_matter_overview_requester_introspect.sql` を流し、
      本番の現行ビュー定義が `023` の再現部と一致（ドリフト無し）を確認 → 一致なら
      `023_matter_overview_requester_email.sql`
      `-v confirm_matter_overview_requester=EXTEND_PRODUCTION_MATTER_OVERVIEW_REQUESTER`
      （ドリフト時は 023 の SELECT を実定義へ差し替えてから適用）

> 各 grants の事後 preflight を再実行し、runtime に想定権限（A:SELECT,INSERT /
> B,D:SELECT,INSERT,UPDATE）が出ることを確認。

## 2. シークレット（Secret Manager）

点火するコネクタの分だけ。値は標準入力から投入しシェル履歴に残さない。

- [ ] **CloudSign client_id**：`cloudsign-client-id` を作成し、ランタイムSA
      `legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com` へ
      `roles/secretmanager.secretAccessor` を付与（手順は `phase5-cloudsign-ignition.md` §1）
- [ ] **Slack bot token**（Slack点火時のみ）：`SLACK_BOT_TOKEN`（`xoxb-`）
- [ ] **GWS SA 鍵**（Drive/Gmail送受信 点火時のみ）：`_GWS_SA_KEY_SECRET`

## 3. ネットワーク

- [ ] **CloudSign**：デプロイ/Cloud Run の egress が `api.cloudsign.jp`（sandbox: `api-sandbox.cloudsign.jp`）へ到達可能
- [ ] **CloudSign 送信元IP許可**：CloudSign 管理に Cloud Run の固定egress IP を登録（未登録だと 403）
- [ ] **Gmail送受信**：対象SAに DWD（`gmail.send` / `gmail.readonly`）と対象メールボックス委任

## 4. 最終デプロイ（最新コード＋起票済みフラグ一括）

`--substitutions` はカンマを含むため `^|^` 区切り。**外部送信を点火しない安全既定**（各 `*_MODE` は
未指定＝disabled / `INTEGRATION_MODE=local`）でまず最新コードを載せ替え、点火は §5 で段階的に行う。

```bash
gcloud builds submit \
  --config infra/gcp/cloudbuild-write-test.yaml \
  --substitutions="^|^_REGION=asia-northeast1|_SERVICE=legalbridge-v2-write-test|_IMAGE=legalbridge-v2-write-test|_CLOUD_SQL_INSTANCE=legalbridge-488506:asia-northeast1:legalbridge-db|_DB_NAME=legalbridge|_DB_USER=legalbridge_v2_runtime|_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password|_SERVICE_ACCOUNT=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com|_PRIMARY_DB_MODE=production|_CONFIRM_PRODUCTION_PRIMARY=CUTOVER_V2_PRIMARY_TO_LEGALBRIDGE|_CONFIRM_DOCUMENT_TABLES=PRODUCTION_DOCUMENT_TABLES_PREFLIGHT_CONFIRMED|_AUTH_MODE=cloudrun-iam|_AUTH_ADMIN_EMAILS=tatsuya.kuramochi@arclight.co.jp|_CONFIRM_CLOUDRUN_IAM=CLOUDRUN_IAM_PROXY_VALIDATION_ONLY|_WRITE_SCOPES=drafts,documents,pdf"
```

- [ ] ビルド成功（`verify-isolation` ゲート通過）→ 新リビジョンが配信
- [ ] `GET /api/v2/admin/diagnostics`：`externalWritesDisabled=true`（まだ送信不可＝安全）

## 5. 段階点火（1コネクタずつ・§4 に追加 substitution を重ねて再デプロイ）

推奨順：Drive → Gmail受信 → Slack → Gmail送信 → CloudSign。各点火後にスモークテスト。

- [ ] **Gmail送信**：`|_INTEGRATION_MODE=live|_WRITE_SCOPES=drafts,documents,pdf,gmail|_GMAIL_DELIVERY_MODE=live|_CONFIRM_GMAIL_DISPATCH=GMAIL_DISPATCH_VALIDATION_ONLY|_GMAIL_SENDER=<送信元>|_GMAIL_SEND_HISTORY_ENABLED=true|_GWS_SA_KEY_SECRET=<鍵secret名>`
      → preview→dispatch 1通→再dispatchが `duplicate`(200)
- [ ] **Gmail受信**：`|_WRITE_SCOPES=...,gmail-inbound|_GMAIL_INBOUND_MODE=live|_CONFIRM_GMAIL_INBOUND=GMAIL_INBOUND_VALIDATION_ONLY|_GMAIL_INBOUND_MAILBOX=<箱>|_GMAIL_INBOUND_INTAKE_ENABLED=true`
      → contracts 一覧→register→registered 一覧
- [ ] **CloudSign**：`|_INTEGRATION_MODE=live|_WRITE_SCOPES=...,cloudsign|_CLOUDSIGN_MODE=live|_CONFIRM_CLOUDSIGN_DISPATCH=CLOUDSIGN_DISPATCH_VALIDATION_ONLY|_CLOUDSIGN_CLIENT_ID_SECRET=cloudsign-client-id|_CLOUDSIGN_ALLOWED_RECIPIENTS=<検証宛先>|_CLOUDSIGN_REQUEST_HISTORY_ENABLED=true`
      → 手順は `phase5-cloudsign-ignition.md` §3（preview→許可外422→実依頼→duplicate→status）
- [ ] **Slack**：`phase5-integration-readiness.md` ③（test-dispatch でトークン/経路検証）

> スコープはカンマ区切り＝`^|^` 区切りのままで可。点火するコネクタのスコープを
> `_WRITE_SCOPES` に積み増す（`verify-write-test` の順序一致に注意）。

## 6. 検証（点火後）

- [ ] `GET /api/v2/runtime` の `writeCapabilities` に点火したコネクタが出る
- [ ] `GET /api/v2/admin/diagnostics`：`externalWritesDisabled=false`（`INTEGRATION_MODE=live` 時）
- [ ] 各コネクタの最小疎通（§5 のスモーク）が成功

## 7. 切戻し

- [ ] 送信一括停止：`_INTEGRATION_MODE=local` で再デプロイ（送信系すべてブロック・読取は維持）
- [ ] 個別停止：該当 `*_MODE=disabled` または `_WRITE_SCOPES` から当該スコープを外す
- [ ] 隔離台帳（`lb_v2_*`）は append 専用で残置無害。無効化はフラグ `*_ENABLED=false`

---

**注記**：DDL/デプロイ/シークレット投入はいずれも本番資格情報を要する運用操作であり、
開発セッション（Claude Code）からは実行しない（egress・権限の制約）。本チェックリストの
コマンドを運用環境で順に実行すること。
