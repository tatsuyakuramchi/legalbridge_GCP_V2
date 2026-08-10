# Phase 16：載せ替え必須ギャップ（U 群トリアージ確定分）

台帳 `v1-v2-gap-remaining.md` Phase 16 の実装記録。16-3（Slack インテーク）は載せ替え必須（2026-08-10 確定）。

## 16-3a：Slack 法務依頼インテーク受信口 ✅ 実装済（第1スライス）

V1 の Cloud Run 世代（services/api/slackGateway.ts・Phase 31）を正として移植。GAS 世代の足場
（keepWarm・API 中継 `/api/intake/create`・worker 自己POST 分割）は移植しない。

### 実装
- `integrations/slack-signature.ts`：v0 HMAC 署名検証（リプレイ窓 300 秒）。**V1 は secret 未設定で
  素通し（fail-open）だったが V2 は fail-closed**。
- `internal/slack-intake-routes.ts`：`POST /internal/slack/commands`／`/internal/slack/interactivity`。
  ユーザー認証バイパス＋署名検証。form-encoded を rawBody 保持で受ける（署名は生ボディに対して計算）。
  未設定（secret/handler なし）は 404。
- `slack-intake/modal.ts`（純粋）：`/法務依頼` モーダル＝依頼種別（V1 と同じ 9 種）＋件名＋希望納期
  （+7日初期値）＋詳細＋相手方3項目（任意）。パース・バリデーション（`response_action:"errors"` 形式）・
  完了/エラービュー。**16-3a は静的モーダル**（dispatch_action なし＝block_actions 不要）。
- `slack-intake/handler.ts`：コマンド→`views.open`（Bot トークン）。提出→Backlog 起票（種別名→
  課題種別解決・priority 中）→`legal_requests`＋`issue_workflows('文書生成依頼')` INSERT→隔離台帳→
  完了ビュー（実課題キー入り）。通知（依頼者DM＋部署チャンネル=department_workflow_rules）は応答後の
  ベストエフォート。**Backlog 未接続（mode≠live）は dry-run**＝隔離台帳のみ・共有表と起票は行わない。
- `slack-intake/intake-repository.ts`（Pg/Memory）：legal_requests には V1 の AFTER INSERT トリガ
  （0103）があり matters/matter_issues が自動生成される（V2 の案件モデルと自動接続）。
- `backlog-web-api.ts` に `createIssue`（issueTypes を名前解決・summary/description/priority=3）。
- **grant 044**：`lb_v2_slack_intake_ledger` 新設（追記専用）＋ legal_requests / issue_workflows の
  SELECT,INSERT＋seq。guard で matters/matter_issues INSERT の事前付与を検査（トリガ要件）。
  token `GRANT_PRODUCTION_SLACK_INTAKE`。preflight はトリガの SECURITY 属性・一意制約も表示。
- config `SLACK_INTAKE_ENABLED`／`SLACK_SIGNING_SECRET`。verify ゲート（write-test 限定＋署名 secret＋
  Bot トークン＋IAP/IAM）。cloudbuild `_SLACK_INTAKE_ENABLED`・`_SLACK_SIGNING_SECRET_NAME`
  （Secret 名→SLACK_SIGNING_SECRET に注入）。
- tests 15 件（署名 fail-closed/改竄/リプレイ・404/401・views.open・起票+記録+台帳・errors・
  dry-run・42501 のエラービュー・モーダル定義・説明文）。**664 緑**。

### 3秒制約の設計
V1 現行世代と同じ方針：コマンドは `views.open` まで同期（min-instances 前提）。提出は Backlog 起票＋
DB 書込まで同期（実課題キーを完了ビューに出す）→通知のみ応答後ベストエフォート
（Cloud Run の CPU スロットリングで遅延しうるが受付は成立済み）。

### 点火（本番）
1. **公開 ingress の決定が前提**（Slack は OIDC を付けられない。`phase9-automation-ignition.md` §ingress
   と同じ選択肢＝受信専用サービス公開を推奨）。
2. Slack App：slash command `/法務依頼` → `https://<受信URL>/internal/slack/commands`、
   Interactivity → `…/internal/slack/interactivity`。scopes: `commands`, `chat:write`（views.open は
   Bot トークンで可）。App の **Signing Secret** を Secret Manager へ（例 `SLACK_SIGNING_SECRET`）。
3. ```bash
   psql "" -f infra/gcp/sql/044_production_slack_intake_preflight.sql || true
   psql "" -v confirm_slack_intake=GRANT_PRODUCTION_SLACK_INTAKE \
     -f infra/gcp/sql/044_production_slack_intake_grants.sql
   ```
4. substitutions：`_SLACK_INTAKE_ENABLED=true`＋`_SLACK_SIGNING_SECRET_NAME=<Secret名>`。
   実起票には `_BACKLOG_MODE=live`＋`_BACKLOG_HOST`/`_BACKLOG_PROJECT_KEY`（未設定なら dry-run＝
   隔離台帳のみで安全に E2E 検証できる）。

### 16-3b 以降（残）
明細行（最大5行・views.update）／既存課題への紐付け（candidates＋link-trigger）／納期変更モーダル／
`/法務検索`（16-2 契約チェック API に依存）／署名URLアップロードリンク（ポータル廃止判断待ち）。

## 16-1 スニペット共有化／16-2 契約チェック API／16-4 添付アップロード
未着手（台帳参照）。
