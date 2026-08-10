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

### 16-3b：/法務検索 ✅ 実装済
16-2 の契約チェックエンジンを**同プロセス直呼び**（V1 現行世代と同じ・REST ホップなし）。
- `slack-intake/search-modal.ts`（純粋）：検索モーダル（キーワード・スラッシュ引数を事前入力）／
  結果モーダル＝取引先名＋**締結ピル（業務委託／ライセンス／出版 ✅締結済・—未締結）**＋個別許諾/出版条件
  件数＋推奨アクション。複数候補は5件まで・未検出は再検索の案内。「🔎 検索し直す」（views.update で
  入力モーダルへ戻る）＋「🔗 Backlogで関連課題を検索」リンク（host/projectKey 設定時のみ）。
- handler：`/法務検索`（/legal-search）コマンド＋`legal_search_modal` の view_submission＋
  `legal_search_again` の block_actions。contractCheck 未注入時は「利用不可」応答。
- 非移植（V1 との差）：チャンネル許可リスト（後続 opt-in）・署名URL「Webで詳細」（ポータル判断待ち）・
  Backlog ステータス付加。tests 5 件＝**681 緑**。
- 点火は 16-3a と同一（Slack App に `/法務検索` コマンドを追加登録するだけ・新規 secret/grant 不要）。

### 16-3c（残）
明細行（最大5行・views.update・dispatch_action 動的モーダル）／既存課題への紐付け（candidates＋
link-trigger）／納期変更モーダル（dispatch_action 依存）／署名URLアップロードリンク（ポータル廃止判断待ち）。

## 16-2：契約チェック API ✅ 実装済（読取専用・grant 不要）

V1 services/api/contractCheckService.ts（API 世代・914L）を最小構成で移植。**判定文字列は V1 と同一**
（唯一 V1:844 の「契約書案 of 法務レビュー」typo は修正）。

- `contract-check/engine.ts`（純関数）：`normalizeName`（NFKC→空白除去→法人格語除去→括弧除去）・
  用途マスタ 17 件の TS 定数（V1 は静的シード表＝grant 不要化）・master サマリ（**V1 の「最後の行勝ち」
  非決定を final・正本優先に改良**・void 除外）・license/publication 条件整形・`buildPurposeResult`
  （カテゴリ別基本契約の存在×用途接頭辞×再許諾/海外フラグ）・`buildSuggestedAction`・未検出定型。
- `contract-check/repository.ts`（Pg/Memory）：vendors 3段ランキング検索（完全→原文部分→正規化部分・
  is_active のみ・NFKC は JS 側）・vendor 文書一括 SELECT・番号ルックアップ（正本・final のみ）。
  **documents/vendors への SELECT のみ＝新規 grant 不要**。
- `contract-check/routes.ts`：`GET /contract-check/purposes`＋`POST /contract-check/search`
  （単一/複数≤5/未検出の V1 互換 shape）＋`POST /contract-check/lookup-number`。全ロール利用可。
- 移植から**意図的に落としたもの**：稟議ディスパッチ（ringi_* 表なし）・decision log 書込・Backlog
  ステータス enrich（N 回の HTTP・後続で opt-in）・external_assets/cloudsign_requests 結合・
  42883/42703 レガシーフォールバック・documentsByCategory（V2 は DocumentRegistry が担う）。
- tests 12 件（正規化・判定分岐・フラグ格上げ・master 優先順位・API 3 endpoints・バリデーション）。676 緑。
- これで 16-3b の `/法務検索` は同プロセスでこの engine/repository を呼べる（V1 現行世代と同じ構成）。

## 16-1：スニペットのサーバ共有化 ✅ 実装済（guarded・grant 045）

Phase 6 の localStorage 完結（U17 退化）を解消し、V1 の `text_snippets`（0151）を V2 が
全社共有で読み書きする。V1 同様、削除は論理削除（`is_active=false`）＝DELETE grant 不要。

- `snippets/snippets-repository.ts`（Pg/Memory）：カテゴリ `special_terms`／`work_item`／`other`。
  一覧は有効行のみ `category, sort_order, id` 順（**表未作成 42P01 は空縮退＝V1 同様**）。
  保存は id 有無で upsert（更新は `updated_at=now()`）。無効化は `is_active=false`。
- `snippets/snippets-routes.ts`：`GET /snippets`＝認証済み**全ロール**（requester も文書作成で
  使うため）・`{snippets, writeEnabled}`。`POST /snippets`＋`POST /snippets/:id/deactivate`＝
  guarded（admin/legal・scope `snippets`・42501→`SNIPPETS_FORBIDDEN_DB` 503・未存在→404）。
- app.ts：guarded-write 定型一式（`SNIPPETS_WRITE_ENABLED`×scope `snippets`×safe-write bypass
  `POST /snippets(/:id/deactivate)`）。capability `snippets` を writeCapabilities に公開。
- クライアント `TextSnippets.tsx`：共有一覧（カテゴリ別グループ・検索・コピー全ロール）＋
  編集フォーム（capability 保持者のみ・分類/タイトル/表示順/本文）。**旧ローカル保存の下書きは
  「この端末の下書き」節に残し、「共有へ移行」（サーバ保存→ローカル削除）／「削除」導線を提供**。
- verify-write-test.sh：`SNIPPETS_WRITE_ENABLED` case＋WRITE_SCOPES 順序（contract-master の次に
  `snippets`）。cloudbuild：`_SNIPPETS_WRITE_ENABLED` 4 箇所。
- tests 13 件（全ロール読取・順序・503/403/400/404・insert/update・論理削除・FORBIDDEN_DB）＝**707 緑**。

### 16-1 点火手順
1. `psql -f infra/gcp/sql/045_production_snippets_grants.sql`（token `GRANT_PRODUCTION_SNIPPETS`・
   text_snippets SELECT/INSERT/UPDATE＋seq。DELETE なし）。
2. デプロイ substitutions：`_SNIPPETS_WRITE_ENABLED=true`＋`_WRITE_SCOPES` に `snippets` を
   **contract-master の直後**へ追加。
3. 読取（一覧・コピー）は grant 前でも動作（42P01/未 grant SELECT なら V1 が表を持つ本番では
   grant 045 適用後に表示される）。

## 16-4 添付アップロード
未着手（台帳参照）。
