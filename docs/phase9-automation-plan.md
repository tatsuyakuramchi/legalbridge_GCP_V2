# Phase 9：自動化基盤＋督促・イベント駆動連携（設計と進捗）

`docs/v1-v2-gap-remaining.md` の最優先ブロック。V2 に欠けていた **Cloud Scheduler 起動口・
Webhook 受信口・督促自動化・外部イベント連携** を、既存 guarded パターン（既定OFF・
共有シークレット・隔離台帳・grant＋verify ゲート）で段階移植する。

## 進捗

- ✅ **9-0 自動化基盤**（済）：`/internal/jobs/:name`（Cloud Scheduler 起動口）・
  `/internal/webhooks/{cloudsign,backlog}`（Webhook 受信口）。ユーザー認証バイパス＋共有シークレット
  （定数時間比較）。既定OFF。runner/handler は注入式（未注入＝実質無効）。tests 10。
- ✅ **9-1(core) daily-checks 判定エンジン**（済・純関数）：納期(7/3/1/超過)・契約更新通告窓・
  満了遷移の判定を `jobs/daily-checks-engine.ts` に移植。tests 11。SQL/Slack/DB更新は未接続。
- ✅ **9-1b/9-2 daily-checks 配線**（済）：grant 030（`lb_v2_job_alert_ledger` CREATE＋GRANT・
  SELECT/INSERT・同日重複抑止の UNIQUE）。`jobs/daily-checks-repository.ts`（Pg/Memory・候補読取
  ＝condition_lines[legacy_role='cli']＋documents[record_type='purchase_order']・fulfilled除外・
  台帳の最新 alert_date を lastAlertAt として渡す・権限未整備は空配列に縮退）。
  `jobs/daily-checks-runner.ts`（エンジンで発火判定→通知→**live のみ台帳へ記録**・dry-run は記録せず
  件数のみ）＋ `DryRunDailyChecksNotifier`。app.ts の jobRunners に `daily-checks` を登録
  （既定 **dry-run**＝安全・実送信は 9-1c で live ノーティファイア注入）。config は 9-0 の
  `JOBS_ENABLED`/`JOBS_TRIGGER_TOKEN`。verify/cloudbuild に `_JOBS_ENABLED`/`_JOBS_TRIGGER_TOKEN_SECRET`
  （Secret Manager 注入）＋ゲート（write-test・IAP/IAM・token 必須）を追加。tests 7。
  **本番テーブルは更新しない**（満了遷移 9-3 は別 opt-in）。
- ✅ **9-1c 実送信**（済）：`jobs/daily-checks-live-notifier.ts`＝`LiveDailyChecksNotifier`。督促を
  法務相談チャンネルへ**1通のダイジェスト**として投稿（既存 `matterSlackChannelAdapter` を再利用）。
  投稿成功で全件 delivered→台帳記録、失敗で全件未達→次回再送。app.ts は Slack live
  （配信live＋Botトークン＋チャンネル）なら Live、それ以外は Dry-run を注入。tests 3。
  宛先DM（申請者個別）は email→Slack ID 解決が要るため将来拡張。
- ✅ **9-3 満了ステータス自動遷移**（済・opt-in）：grant 031（`documents.contract_status` 列 UPDATE・
  token `GRANT_PRODUCTION_CONTRACT_EXPIRY`）。daily-checks 内で満了到達を executed 以外→expired へ。
  既定 OFF（`CONTRACT_EXPIRY_TRANSITION_ENABLED`）。verify で write-test/本番DB/IAP を二重確認。
- ✅ **9-4 検収待ちダイジェスト**（済）：`inspection-digest` runner。詳細は下記スライス節。
- ✅ **9-5 CloudSign Webhook 受信 / 9-7 Backlog Webhook 受信**（済）：grant 032
  （`lb_v2_webhook_receipts` CREATE＋GRANT・token `GRANT_PRODUCTION_WEBHOOK_RECEIPTS`）。
  純関数パーサ（`internal/webhook-parsers.ts`）＋べき等台帳（`recordIfFirst`）＋契約状態ライタ
  （`documents/contract-status-writer.ts`・grant 031 再利用）＋ハンドラ（`integrations/webhook-handlers.ts`）。
  CloudSign 締結→送付履歴更新＋契約 executed、Backlog 課題追加→Slack 通知。すべてべき等・
  判別不能/二重/未知は 200 skip。app.ts で DB があれば自動構築。verify/cloudbuild に
  `_CLOUDSIGN_WEBHOOK_TOKEN_SECRET`/`_BACKLOG_WEBHOOK_TOKEN_SECRET`（既定 BLOCKED・設定時のみマウント）。tests 8。

## 重要な設計判断（実装前に確定した事項）

1. **納期アラートの重複抑止列は現行スキーマに実在しない。**
   V1 は `capability_line_items.last_alert_at` を参照するが、これは互換ビュー
   （`services/worker/src/lib/compatViewSql.ts:37`）で `NULL::timestamp` 固定＝常に NULL。
   よって V1 の「同日重複抑止」は現行データモデルで実質機能していない。
   → **V2 は本番 `condition_lines` を更新しない。** 送信済みアラートを隔離台帳
   `lb_v2_job_alert_ledger`（append-only：`kind, ref_type, ref_id, alert_date, ...`）へ記録し、
   `deriveDeliveryAlerts` に「本日この ref に送ったか」を台帳照合で渡して抑止する。
   これにより本番テーブルへの UPDATE 権限が不要（grant は新規 lb_v2 表のみ・024 と同型）。
2. **満了ステータス自動遷移だけは本番 `documents` の UPDATE。**
   `documents.contract_status` の列レベル UPDATE grant が必要（026 と同型の最小権限）。
   誤遷移リスクがあるため daily-checks 内でも**別フラグ**で opt-in にする。
3. **配信は既存 Slack チャネルアダプタを再利用。**
   納期/契約アラートは「申請者 DM ＋ 部署チャンネル」。V2 では Slack Bot トークン
   （matter-slack と同経路）＋ `SlackRecipientDirectory`（staff→Slack ID）を使う。
   Slack 未設定時はドライラン（送信せず件数だけ返す）。
4. **Webhook はべき等必須。** CloudSign/Backlog は再送してくるため、`external_event_id`
   （CloudSign document id / Backlog request id）で `lb_v2_webhook_receipts` に一意記録し、
   二重処理を防ぐ。契約 `executed` 遷移・自動起票は初回のみ実行。

## 残スライス（設計付き）

### 9-1b：納期アラート 配信（daily-checks 本体）
- 新表 **`lb_v2_job_alert_ledger`**（grant 0NN・CREATE＋GRANT 自己完結・SELECT/INSERT）。
- `jobs/daily-checks-repository.ts`（Pg/Memory）：候補読取＝`condition_lines`（`legacy_role='cli'`・
  `delivery_date` 有・全量検収 `condition_line_status_v.status='fulfilled'` 除外）JOIN `documents`
  （`record_type='purchase_order'` の `backlog_issue_key`）＋台帳から本日送信済 ref を取得。
- runner `daily-checks`：エンジンで発火判定 → Slack 配信（DM＋チャンネル）→ 送信を台帳へ INSERT。
- ルート：`jobRunners["daily-checks"]` を app.ts で注入（9-0 の枠へ）。
- ゲート：`JOBS_ENABLED`＋scope `jobs`＋`JOBS_TRIGGER_TOKEN`。Slack は matter-slack と同経路。
- verify/cloudbuild：`_JOBS_ENABLED`／`_JOBS_TRIGGER_TOKEN`（secret）・scope `jobs` を正準順へ追加。
- tests：候補抽出・台帳抑止・ドライラン件数。

### 9-2：契約更新通告アラート
- 9-1b と同じ runner 内で `deriveContractAlerts` を実行。候補＝`documents`
  （`expiration_date`・`auto_renewal`・`renewal_notice_months`・`alert_lead_months`）。
- 重複抑止も `lb_v2_job_alert_ledger`（`kind='contract_renewal'`）で行う（`documents` を更新しない）。

### 9-3：満了ステータス自動遷移（本番UPDATE・opt-in）✅ 実装済
- **grant 031**（`031_production_contract_expiry_grants.sql`・トークン `GRANT_PRODUCTION_CONTRACT_EXPIRY`）：
  `documents` の列レベル `UPDATE (contract_status)` のみ＋preflight（遷移見込み件数と現行列権限を表示）。
- 別フラグ `CONTRACT_EXPIRY_TRANSITION_ENABLED`（既定OFF）を daily-checks runner が確認。
- repo：`loadExpiryCandidates`（満了日超過かつ draft/awaiting_signature/executed）／`transitionExpired`
  （`UPDATE … SET contract_status='expired'`・遷移可能状態を再確認・**42501 は forbidden で返しジョブ継続**）。
- runner：アラート処理の後に `deriveExpiryTransitions`→`transitionExpired`。summary に
  `expiredTransitions`/`expiryForbidden`。verify/cloudbuild に `_CONTRACT_EXPIRY_TRANSITION_ENABLED`／
  `_CONFIRM_CONTRACT_EXPIRY`（=`CONTRACT_EXPIRY_LEGALBRIDGE_VALIDATION_ONLY`）＋ゲート（JOBS_ENABLED 必須・
  production DB・IAP/IAM）。terminated は触らない。tests 3。

### 9-4：検収待ちダイジェスト ✅ 実装済
- `jobs/inspection-digest-runner.ts`：既存 `PendingInspectionRepository.list("", true, 200)`（検収書未作成の
  発注書）を読取り、`composeInspectionDigest`（件数＋文書番号/案件/課題・上限20行＋「他N件」）で1通に集約。
  **新規 grant 不要**（documents SELECT）・台帳/重複抑止なし（毎回スナップショット）。
- runner `inspection-digest` を app.ts に登録。Slack live なら `matterSlackChannelAdapter` で投稿、
  それ以外は dry-run（`post` 未注入＝件数のみ）。0件は投稿しない。tests 5。

### 9-5：CloudSign Webhook 受信（handler 注入）✅ 実装済
- `internal/webhook-parsers.ts`：`parseCloudSignEvent`（純関数）。untrusted payload から
  `documentID` と `status`（1=先方確認中/2=締結済/3=取消却下）＋`text` を型安全に抽出し、
  `completed/declined/sent/other` に正規化。判別不能は `null`（副作用させない）。
- `internal/webhook-receipts-repository.ts`：`lb_v2_webhook_receipts` へ `(source, external_id)` で
  `recordIfFirst`（INSERT ON CONFLICT DO NOTHING → 初回のみ true）。Memory 実装も併設。
- `documents/contract-status-writer.ts`：`markExecuted`（`documents.contract_status`
  draft/awaiting_signature → executed、9-3 と同じ grant 031 を再利用、42501 は forbidden で受信は成功）。
- `integrations/webhook-handlers.ts` `createCloudSignWebhookHandler`：べき等記録 →
  `cloudsign-request-repository.updateStatus` で送付履歴更新 → 締結時に契約 executed。
  未知ドキュメント/二重送信/判別不能はすべて 200 skip（再送を誘発しない）。
- grant 032：`lb_v2_webhook_receipts`（CREATE＋GRANT SELECT/INSERT・token `GRANT_PRODUCTION_WEBHOOK_RECEIPTS`）。
- 設定：`CLOUDSIGN_WEBHOOK_TOKEN`（9-0 で追加済）。app.ts で DB があれば handler を自動構築。
- verify/cloudbuild：`_CLOUDSIGN_WEBHOOK_TOKEN_SECRET`（既定 BLOCKED）→ 設定時のみ Secret Manager から
  `CLOUDSIGN_WEBHOOK_TOKEN` をマウント。write-test サービス限定。tests は parsers＋handler で 8。

### 9-6：CloudSign 一括ステータス同期
- runner `cloudsign-sync`：未確定 `cloudsign_request_history` を一括で `getDocument` 照会し後追い更新
  （既存 FetchCloudSignApiClient 再利用）。INTEGRATION_MODE=live 前提。

### 9-7：Backlog Webhook 自動起票 ✅ 実装済
- `internal/webhook-parsers.ts`：`parseBacklogIssueCreated`（純関数）。課題追加(type=1)のみを対象化し、
  `projectKey-key_id` で issueKey を合成。更新(type≠1)や projectKey 欠落は `null`。
- `integrations/webhook-handlers.ts` `createBacklogWebhookHandler`：`(backlog, issueKey:created)` で
  べき等化し、Slack live 時のみ法務相談チャンネルへ新規依頼を通知（`notify` 未注入なら記録のみ）。
  二重は 200 skip。設定：`BACKLOG_WEBHOOK_TOKEN`（9-0 で追加済）。
- verify/cloudbuild：`_BACKLOG_WEBHOOK_TOKEN_SECRET`（既定 BLOCKED）→ 設定時のみ `BACKLOG_WEBHOOK_TOKEN`
  をマウント。write-test サービス限定。
- 注：現時点は「受信＋通知」まで。V2 依頼取込（Phase 3 requests）への自動投入は後続で拡張余地。

## デプロイ（Cloud Scheduler / Webhook 配線・別途）
- Cloud Scheduler ジョブ：`POST https://<svc>/internal/jobs/daily-checks` に
  `X-Jobs-Token: <JOBS_TRIGGER_TOKEN>` を付与、平日 09:00 JST 等。OIDC（SA）＋共有シークレット二重。
- CloudSign/Backlog 管理画面で Webhook URL（`/internal/webhooks/...`）＋トークンを登録。
- secret：`JOBS_TRIGGER_TOKEN` / `CLOUDSIGN_WEBHOOK_TOKEN` / `BACKLOG_WEBHOOK_TOKEN` を Secret Manager へ。

## セキュリティ注記
- `/internal/*` はユーザー認証バイパス。**必ず**共有シークレット＋（本番は）Cloud Run IAM の二重で保護。
- Webhook は外部由来ペイロード＝untrusted。契約 `executed` 等の副作用は署名/トークン検証とべき等化の後のみ。
- 破壊的遷移（満了・締結）は専用フラグで opt-in。既定 OFF。
