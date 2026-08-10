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

### 16-3c：動的モーダル群 ✅ 実装済（明細行・紐付け・納期変更）
V1 slackGateway の dispatch_action／views.update 系を移植。**新規 grant・env 不要**（候補抽出は
grant 044 の legal_requests/issue_workflows SELECT で足りる）。点火条件は 16-3a と同一。

- `slack-intake/line-items.ts`（純粋）：明細定義 4 種（発注明細・許諾明細・納品明細・計算明細）を
  **V1 と同一のラベル・placeholder・選択肢**で移植。最大 5 行・増減ボタン（li_add/li_remove）・
  ブロック構築／パース（空行スキップ）／`formatLineItemsText`（V1 同一書式）。
- `modal.ts` 動的化：依頼種別 select に `dispatch_action`。種別に応じて再構築＝
  ①明細対象種別（発注書/個別許諾/検収書/計算書）は明細セクション＋`private_metadata.li_count`、
  ②検収書・計算書は**候補セレクタ（🆕新規作成=__NEW__ 先頭・申請者の未完了依頼25件）＋
  対象契約番号ブロック**（相手方手入力の代わり・V1 同様）、③**納期変更依頼**は別フォーム
  （候補セレクタ＋自由キー入力＋新納期 datepicker(+1日)＋変更理由。V1 と同じ検証：キー形式
  `^[A-Z][A-Z0-9_]*-\d+$`・日付・理由必須）。
- handler：block_actions（種別変更・明細増減）→ 候補をベストエフォートで引いて `views.update`
  （hash 付き）。view_submission 分岐＝
  1. **納期変更**：新規の作業課題は作らず、承認用課題 `[納期変更依頼] KEY → 日付` を起票→
     legal_requests（contract_type='deadline_change'・notes は V1 同一構造 `executed:false`）＋
     台帳＋DM。**V2 差分：実行は法務が承認後**（V1 Phase 22.4 と同じ建付け。自動実行は
     B 群 U7 の納期変更オペ移植時）。
  2. **既存課題への紐付け**：新規課題を作らず対象課題へ**フォーム内容（明細含む）をコメント記録**
     ＋台帳＋DM。V1 の link-trigger-run（文書自動生成）は文書生成パイプライン側の移植と併せて後続。
  3. **検収書（新規）**：契約番号の必須チェック（明細ごと・空欄は共通番号）＋ contract-check
     リポジトリ注入時は**実在チェックと取引先自動補完**（単一契約→取引先名、複数→「複数 (n件)」）。
  4. **計算書（新規）**：番号があれば取引先補完（見つからなくてもブロックしない・V1 同様）。
  明細テキストは Backlog 説明文に付加し、legal_requests.notes にも lineItems を保存。
- 非移植（意図的）：署名URLアップロードリンク・取引先検索ポータルリンク（C 群のポータル廃止
  判断待ち）・支払対象契約検索ページリンク（同）。
- tests 14 件（明細ブロック構築/5件上限/納期変更フォーム/候補セレクタ/パース整形/検証/
  views.update 2種/納期変更 live+dry-run/紐付け/新規遷移/番号必須/実在チェック＋補完）＝**728 緑**。

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
- tests 13 件（全ロール読取・順序・503/403/400/404・insert/update・論理削除・FORBIDDEN_DB）＝**694 緑**。

### 16-1 点火手順
1. `psql -f infra/gcp/sql/045_production_snippets_grants.sql`（token `GRANT_PRODUCTION_SNIPPETS`・
   text_snippets SELECT/INSERT/UPDATE＋seq。DELETE なし）。
2. デプロイ substitutions：`_SNIPPETS_WRITE_ENABLED=true`＋`_WRITE_SCOPES` に `snippets` を
   **contract-master の直後**へ追加。
3. 読取（一覧・コピー）は grant 前でも動作（42P01/未 grant SELECT なら V1 が表を持つ本番では
   grant 045 適用後に表示される）。

## 16-4：添付アップロード ✅ 実装済（multipart 基盤＋案件添付・新規 grant 不要）

V1 worker の `/api/matters/:id/attachments`＋`/api/attachments/by-issue` を V2 の案件中心
モデルへ寄せて移植。生ファイル（Word/PDF 等）を Drive へ格納し、documents 行
（**ATT-YYYY-NNNNN・is_primary=FALSE・lifecycle_status='final'**）として案件に紐付ける。

- `documents/multipart.ts`（純粋）：multipart/form-data の**依存フリーパーサ**（multer 非導入・
  Excel パーサと同じ方針）。boundary 抽出・フィールド/ファイル分離・エスケープ引用符・
  バイナリ中の境界風文字列耐性。express.raw で受けた Buffer を解釈する。
- `documents/drive-storage.ts`：`uploadFile`（任意 MIME の生ファイル格納）を **optional メソッド**
  として追加（既存のテスト用スタブを壊さない）。Google 実装＋Memory 実装。
- `documents/attachments-repository.ts`（Pg/Memory)：ATT 採番は V1 と同じ
  `document_sequences(kind='attachment')` を共有＝**番号帯が V1 と連続**。documents INSERT
  （form_data に original_file_name/mime/size/uploaded_by/uploaded_via）。matters.updated_at
  touch はベストエフォート。**必要 grant は既存 006 のみ＝新規 grant 不要**。
- `documents/attachments-routes.ts`：`POST /matters/:id/attachments`（admin/legal・種別
  counterparty_draft/own_draft/reference＝V1 同一・不明は reference へ縮退・1ファイル 30MB・
  originalName フィールド優先＝multer 文字化け対策の V1 慣行を踏襲）。Drive ファイル名は V1 と同じ
  「**課題番号（無ければ案件コード/M{id}）_アカウント_元ファイル名**」。Drive 失敗 502・42501→503・
  Backlog 課題への気づきコメントは **backlog-comment 点火時のみ**ベストエフォート（失敗しても成功扱い）。
- app.ts：guarded 定型一式（`ATTACHMENT_UPLOAD_ENABLED`×scope `attachments`×**driveStorage.uploadFile
  が使えること**）。capability `attachments`。verify case＋WRITE_SCOPES 順序（snippets の次）。
  cloudbuild `_ATTACHMENT_UPLOAD_ENABLED` 4 箇所。
- クライアント：案件詳細の関連文書セクションに**資料アップロードパネル**（種別選択＋複数ファイル・
  30MB 事前チェック・完了で一覧更新）。登録された ATT 文書はそのまま関連文書一覧に載る。
- **V1 から意図的に変えた点**：課題番号ベースの公開アップロードページ（portal・署名URL）は
  移植しない（C 群のポータル廃止判断待ち。V2 は案件詳細からの導線に一本化）。document_files への
  二重登録も省略（V2 の関連文書は documents.matter_id で一元化）。
- tests 20 件（パーサ 7＋routes 13：成功/命名/種別縮退/503/403/404/400/413/42501/Drive失敗/
  コメント非致命）＝**714 緑**。

### 16-4 点火手順
1. 前提：Drive ストレージが構成済みであること（`GOOGLE_DRIVE_FOLDER_ID`＋SA 鍵。`drive` scope 自体の
   点火は不要＝依存は storage のみ）。
2. substitutions：`_ATTACHMENT_UPLOAD_ENABLED=true`＋`_WRITE_SCOPES` に `attachments` を
   **snippets の直後**へ追加。DB grant の追加適用は不要（006 で充足）。
