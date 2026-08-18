# V1→V2 サービス載せ替え Runbook（2026-08-10 起草）

V2（本リポジトリ）を本番サービスとして V1（legalbridge_ai_gcp）から載せ替えるまでの全手順。
監査（`cutover-readiness-audit.md`）・gap 台帳（`v1-v2-gap-remaining.md`）・Phase 9 点火手順
（`phase9-automation-ignition.md`）を1本に束ねる。**上から順に消し込む**チェックリスト構成。

## 0. 現在地（2026-08-10 デプロイ・点火完了時点）

- コード：Phase 1〜16 全実装（runbook §1 完了）＋監査修正 S-A〜S-F（build a4806a35…）。
- 適用済み grant：**001〜046 すべて適用済み**（031・043・044・045・046 は 2026-08-10 に適用・検証済み。残る DB 作業なし）。
- 有効スコープ：drafts, documents, pdf, slack-approvals, matters, **vendors, staff, works,
  materials, rights-sources, vendor-merge**（2026-08-10 点火）, matter-merge, matter-delete,
  document-void, document-reissue, excel-batch, settings, workflow-rules, contract-master,
  **snippets**（同）, slack, slack-dispatch, matter-slack。
  満了自動遷移 CONTRACT_EXPIRY_TRANSITION_ENABLED=true（同・実行は daily-checks ジョブ起動時）。
- ジョブ基盤 JOBS_ENABLED=true（**Cloud Scheduler は未作成**＝手動/未点火）。
- 連携：Slack live／Drive live（2026-08-10）／**Backlog readonly live（2026-08-11 点火・arclight.backlog.com/LEGAL）**／Gmail・CloudSign は disabled。
- 認証：cloudrun-iam（admin=tatsuya.kuramochi@arclight.co.jp。**単独運用のため §3 の追加開放は不要と決定**・2026-08-11）。

### 0-1. 2026-08-17 の反映内容（build c1a3df50・revision 00105-wkx）

- **メモリ 2Gi**（`--memory=1Gi` からの引き上げ）。PDF 生成の Chromium が 1Gi・同時2件で
  OOM（実測 1057 MiB）になり、Drive 保存が HTTP 503 で落ちていた。
- 帳票の出方：敬称（区分優先＋取引先マスタ優先）／個人取引先では担当者・部署・代表者を
  引かない（V1 と同規則）／「代表者名 (＋様)」に敬称／A4 と改ページ制御／特約の重複出力／
  発注書の合計・納期・支払日の自動集計。
- フォーム：マスタで消した項目をフォームからも消す／定型文リンク／基本契約ピッカーの修正
  （`HAS_BASE_CONTRACT` を立てる・発注番号を壊さない）／複製2種（相手先違い・内容違い）。
- 案件 Slack：V1 の `matter_slack_threads` を読むフォールバック（grant 054 と対）。
  **✅ 2026-08-18 に会話表示まで確認**（Slack App へ `channels:history` を付与し再インストール）。
- 失敗表示：JSON でない応答（Cloud Run の 503 など）を実際の失敗内容として出す。

適用済み SQL（この日）：053 / 054 / 055 / 056 / 057（対象0件）/ 058（11件修正）。

## 1. 残実装（コード）— cutover 前に必要

> **2026-08-10：本節の残実装はすべて完了**（1-1〜1-6 ✅）。以降は §2 点火メニューと業務判断のみ。

| # | 内容 | 状態 |
|---|---|---|
| 1-1 | **Phase 16-3：Slack インテーク** | ✅ 16-3a〜16-3c 実装済（受信口＋/法務依頼＝明細行・既存課題紐付け・納期変更込み＋/法務検索・grant 044）。点火は `phase16-cutover-gaps.md`（公開 ingress 決定が前提） |
| 1-2 | Phase 16-1：スニペットのサーバ共有化 | ✅ 実装済（guarded・grant 045＋`_SNIPPETS_WRITE_ENABLED=true`＋WRITE_SCOPES へ `snippets`（contract-master の直後）。点火は `phase16-cutover-gaps.md`） |
| 1-3 | Phase 16-2：契約チェック API | ✅ 実装済（読取専用・grant 不要・全ロール。/法務検索 16-3b の前提解消） |
| 1-4 | Phase 16-4：添付アップロード（multipart） | ✅ 実装済（新規 grant 不要。点火＝Drive ストレージ構成＋`_ATTACHMENT_UPLOAD_ENABLED=true`＋WRITE_SCOPES へ `attachments`（snippets の直後）。`phase16-cutover-gaps.md`） |
| 1-5 | 9-7 Backlog Webhook 自動起票（受信→legal_requests 作成） | ✅ 実装済（課題追加→自動取込＋Slack経由は受付済み遷移＋type=2 状態同期。点火＝grant 046＋`_BACKLOG_INTAKE_ENABLED=true`＋`_BACKLOG_WEBHOOK_TOKEN_SECRET`。公開 ingress（2-4）が前提。`phase9-automation-plan.md` 9-7） |
| 1-6 | V2 帳票への会社プロファイル差込（app_settings 参照。現状ハードコード） | ✅ 実装済（自社差込ピッカー＋intake ブリッジが COMPANY_* を参照・未設定は従来値へ縮退＝grant/env 追加なし。設定は 11-1 の設定画面＝settings scope 点火で編集可） |

> B 群（納期変更・DQ トリアージ等）は V1 併走中は V1 側で運用＝cutover ブロッカーではない。

## 2. 点火メニュー（実装済み・スイッチ待ち）

### 2-0. デプロイの定石（フラグ据え置きの再デプロイ）

**通常はこのスクリプト1本で足りる**（下の手順を1本化し、認証切れ・引き継ぎ失敗・
必須フラグ欠落を送信前に検出する）：

```bash
cd ~/legalbridge_GCP_V2 && git pull origin <ブランチ>

infra/gcp/deploy-write-test.sh                                   # 現行フラグのまま再デプロイ
infra/gcp/deploy-write-test.sh _SLACK_CONVERSATION_READ_MODE=live  # 一部だけ変更
DRY_RUN=1 infra/gcp/deploy-write-test.sh ...                     # 送信せず内容確認
```

**デプロイ先の既定は正式名 `legalbridge-v2`**（§4 の載せ替え後・2026-08-18 に変更）。
旧 `legalbridge-v2-write-test` へ出すときだけ明示する:

```bash
SERVICE=legalbridge-v2-write-test infra/gcp/deploy-write-test.sh
```

出力の `主要フラグ` に `_SERVICE` が出るので、**送信前に必ずデプロイ先を確認する**。
ファイル名が `deploy-write-test.sh` のままなのは参照している文書が多いため。改名は
§5 の旧サービス撤去とあわせて行う。

事前チェックで止まる主な条件：gcloud 未認証／substitutions が 100 未満（引き継ぎ失敗）
／CloudSign 宛先許可リストにメールアドレスでない要素が混ざっている／Slack 読取 live なのに
bot token・通知履歴が未設定。

宛先許可リストは **空＝無制限**（V1 と同じ）。社内宛だけで検証したい間はアドレスを列挙し、
本番運用では空にする。空にできるのはデプロイ時だけで、設定画面の空欄保存は「env を使う」
意味になり解除にはならない点に注意。

```bash
infra/gcp/deploy-write-test.sh '_CLOUDSIGN_ALLOWED_RECIPIENTS='                    # 無制限へ
infra/gcp/deploy-write-test.sh '_CLOUDSIGN_ALLOWED_RECIPIENTS=a@x.co.jp,b@x.co.jp' # 限定へ
```

以下は同じことを手で行う場合の内訳（スクリプトが使えないときの参照用）。

前回のデプロイ設定（substitutions 104キー）を**確実に**引き継ぐには、
「配信中の Cloud Run リビジョンのイメージタグ＝ビルドID」から逆引きする
（`gcloud builds list` の最新 SUCCESS を掴む方式は、別サービスのビルドを拾い
`Write-test deployment blocked: isolated DB confirmation is missing.` で止まる事故があるため使わない）：

```bash
cd ~/legalbridge_GCP_V2 && git pull origin <ブランチ>
IMG=$(gcloud run services describe legalbridge-v2-write-test --region asia-northeast1 \
  --format="value(spec.template.spec.containers[0].image)")
LAST_BUILD="${IMG##*:}"
gcloud builds describe "$LAST_BUILD" --format=json | jq '{substitutions}' > /tmp/build-flags.json
jq -r '.substitutions | keys | length' /tmp/build-flags.json        # 104 前後であること
jq -r '.substitutions._WRITE_SCOPES' /tmp/build-flags.json          # 末尾 condition-repair
SUBS=$(jq -r '.substitutions | to_entries | map("\(.key)=\(.value)") | join("|")' /tmp/build-flags.json)
gcloud builds submit --config infra/gcp/cloudbuild-write-test.yaml --substitutions "^|^${SUBS}" .
```

フラグを変える点火デプロイは、この `SUBS` 生成の前に `/tmp/build-flags.json` を
jq で編集してから同じ手順で submit する。

### 2-0b. Cloud SQL への接続（psql を使う前に）

SQL の適用・確認は Cloud SQL Auth Proxy 経由で行う。毎回同じところで詰まるので
スクリプトにまとめた:

```bash
infra/gcp/start-sql-proxy.sh          # 5432 で貼り直す（PORT= で変更可）
```

踏みやすい失敗:
- **`Error 401 … ACCESS_TOKEN_TYPE_UNSUPPORTED`／`Invalid Credentials`**
  … アクセストークンの失効（寿命は約1時間）。スクリプトを再実行する。
- **`invalid token JSON from metadata: EOF`**
  … ADC（メタデータサーバ）では認証できない。`--token` を明示する（スクリプトは常に明示）。
- **`address already in use`** … 前のプロセスが残っている。スクリプトが先に停止する。
- `~/cloud-sql-proxy` は**ファイル**（ディレクトリではない）。`Bus error` はダウンロード途中で
  切れた壊れたバイナリ。サイズ（約 32MB）を確認して取り直す。

成功時のログには `Authorizing with OAuth2 token` が出る。

### 2-1. 満了自動遷移 ✅ 点火済み（2026-08-10・grant 031＋flag true。自動実行は 2-3 Scheduler の daily-checks 作成後）
```bash
psql "" -f infra/gcp/sql/031_production_contract_expiry_preflight.sql || true
psql "" -v confirm_contract_expiry=GRANT_PRODUCTION_CONTRACT_EXPIRY \
  -f infra/gcp/sql/031_production_contract_expiry_grants.sql
```
substitutions：`_CONTRACT_EXPIRY_TRANSITION_ENABLED=true`＋`_CONFIRM_CONTRACT_EXPIRY=<verify の要求値>`。
※トークン名・要求値は 031 ファイルと verify-write-test.sh の該当 case を参照。

### 2-2. マスタ書込 ✅ 点火済み（2026-08-10・vendors/staff/works/materials/rights-sources/vendor-merge＋snippets）
grant は適用済み（009/010/011 系＋**043 も 2026-08-10 適用済み**）。DB 作業なし＝substitutions のみ：
```bash
psql "" -v confirm_vendor_merge_documents=GRANT_PRODUCTION_VENDOR_MERGE_DOCUMENTS \
  -f infra/gcp/sql/043_production_vendor_merge_documents_grants.sql
```
substitutions：`_VENDOR_WRITES_ENABLED/_STAFF_WRITES_ENABLED/_WORK_WRITES_ENABLED/_MATERIAL_WRITES_ENABLED/
_RIGHTS_SOURCE_WRITES_ENABLED/_VENDOR_MERGE_ENABLED=true`＋対応する `_CONFIRM_*`（verify の要求値）＋
`_WRITE_SCOPES` へ正準順で `vendors,staff,works,materials,rights-sources,vendor-merge` を挿入
（canonical: drafts,documents,pdf,[drive,]slack-approvals,[outbound-conditions,contract-intake,]matters,
vendors,staff,works,materials,rights-sources,vendor-merge,matter-merge,…）。

### 2-3. Cloud Scheduler ✅ 作成・疎通確認済み（2026-08-10・3ジョブとも意図的に PAUSED）
`lb-v2-daily-checks`（平日9:00）／`lb-v2-inspection-digest`（平日9:05）／`lb-v2-cloudsign-sync`（3時間毎）を
作成し、**統合 IAP 経由の疎通を確認済み**（構成の詳細＝IAP OAuth クライアント `lb-v2-scheduler` を
programmaticClients に登録し audience に使用・SA へ iap.httpsResourceAccessor 付与、は
`phase9-automation-ignition.md` §5 冒頭の実地知見を参照）。
**PAUSED の理由と resume 条件**：
- daily-checks／inspection-digest：V1 cron（`daily-checks`・`legalbridge-daily-scheduler`）併走中の
  **二重通知防止**。→ **5-2（V1 cron 停止）と同時に `gcloud scheduler jobs resume` で起動**。
  満了自動遷移（2-1）も daily-checks resume まで実行されない。
- cloudsign-sync：**✅ 2026-08-17 resume 済み**（ENABLED・3時間毎 JST）。強制実行で
  Cloud Run が **HTTP 200** を返すことを確認（ランナー登録済み＝CloudSign live 構成を認識）。
  Slack 投稿をしないジョブなので V1 併走中でも二重通知にならない。

**このサービスは IAP の背後にあるため、`curl` に `gcloud auth print-identity-token` を付けても
ジョブ起動口は叩けない**（`401 Invalid IAP credentials: Audience doesn't match the allowlisted
oauth clients`）。ユーザー資格情報では audience を指定できないため、動作確認は
`gcloud scheduler jobs run` で本番と同じ経路（Scheduler の OIDC → IAP）を通すこと。
なお `jobs run` は **ENABLED でないと使えない**（`Job.state must be ENABLED for RunJob`）ので、
「resume する前に試す」ことはできない。順序は **resume → 強制実行 → 確認 →（失敗なら pause に戻す）**。
結果は Cloud Run のリクエストログで見る（アプリ側の応答コードが出る）:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="legalbridge-v2-write-test"
   AND httpRequest.requestUrl:"/internal/jobs/<job>"' \
  --project legalbridge-488506 --limit 3 --freshness 10m \
  --format='value(timestamp, httpRequest.status, httpRequest.userAgent)'
```

`200`＝成功／`404`＝ランナー未登録（`JOB_NOT_FOUND`）／`401`＝`X-Jobs-Token` 不一致。

### 2-4. 外部 Webhook（CloudSign/Backlog）＋ Slack 受信（Phase 16-3）
**ingress 方式は決定・実装済み（2026-08-10）**：受信専用リレー `lb-v2-receiver`（`infra/receiver/`・
依存ゼロ Node・allUsers 公開・許可4パスのみ・1MB 上限・ヘッダ allowlist）が、メタデータサーバの
OIDC（audience=IAP `programmaticClients` のクライアント ID＝2-3 と同じ `lb-v2-scheduler`）を付けて
IAP 越しに本体へ転送する。実認証は本体のアプリ層（X-Webhook-Token／Slack v0 署名・fail-closed）。
Backlog/CloudSign はカスタムヘッダ不可のため、リレーが `?token=` → `X-Webhook-Token` 変換を行う。
デプロイ・スモークは `infra/receiver/README.md`。進捗（2026-08-10）＝
① ✅ リレー稼働（`lb-v2-receiver`・SA lb-v2-receiver@＋iap.httpsResourceAccessor。
   公開→IAP→本体の経路をスモークで確認）
② ✅ Backlog 分点火：secret `BACKLOG_WEBHOOK_TOKEN`/`CLOUDSIGN_WEBHOOK_TOKEN` 作成、
   本体 build 3dfd59e0 で `_BACKLOG_WEBHOOK_TOKEN_SECRET`＋`_BACKLOG_INTAKE_ENABLED=true` 点火。
   **実スモーク成功**（不正トークン401／正トークンで intakeCreated:true＝legal_requests 書込＋
   0103 トリガの案件自動生成まで動作確認・テスト行は掃除済み）
③ 残り＝外部登録（**Backlog と Slack をまとめて実施予定**・インフラ側は準備完了）：
   - Backlog：コンソールに Webhook URL（`<RECV_URL>/internal/webhooks/backlog?token=<BACKLOG_WEBHOOK_TOKEN>`・
     イベント=課題の追加/更新）を登録 → テスト課題1件で lb_v2_webhook_receipts／legal_requests を確認。
   - Slack App：作成 → signing secret を `SLACK_SIGNING_SECRET` secret へ →
     `_SLACK_INTAKE_ENABLED=true`＋`_SLACK_SIGNING_SECRET_NAME=SLACK_SIGNING_SECRET` で再デプロイ →
     slash `/法務依頼`・`/法務検索`＋Interactivity の Request URL を `<RECV_URL>/internal/slack/…` に設定
     （scopes: commands, chat:write。**案件 Slack パネルの会話取得には `channels:history` も必要**
     ＝法務相談チャンネルの `conversations.replies`。依頼者DM の履歴を読むなら `im:history` も。
     Backlog 未 live の間は dry-run＝隔離台帳のみで安全に検証可）。
   - CloudSign Webhook：**受け口の疎通確認済み（2026-08-17）**。
     URL は `<RECV_URL>/internal/webhooks/cloudsign?token=<CLOUDSIGN_WEBHOOK_TOKEN>`
     （`RECV_URL` は `lb-v2-receiver` の Cloud Run URL）。CloudSign はカスタムヘッダーを
     送れないため、リレーが `?token=` → `X-Webhook-Token` に変換する。
     スモーク結果＝不正トークン **401** ／ 正トークン **200**
     `{"ok":true,"skipped":"unknown document","status":"sent"}`（存在しない書類IDなので更新なし）。
     テスト行は `lb_v2_webhook_receipts` から削除済み。
     CloudSign が送る `status` は **1=送信済 / 2=締結 / 3=却下**。`(documentID, status)` で
     べき等化しているため再送は `skipped:"duplicate"`。締結時は
     `lb_v2_cloudsign_requests.status` 更新＋契約を `executed`（grant 022 / 031）。
     取りこぼしは 3 時間毎の cloudsign-sync が拾う（二重経路）。

### 2-5. 統合 live 化（Drive / Gmail / CloudSign）
- **Drive ✅ 点火済み（2026-08-10）**：ADC 方式（鍵 Secret 不要・V1 本番と同じ）・保存先 V2_FOLD
  （`1KA1H525VDve71anot0Wv8p5qsggTiUja`・ランタイム SA がコンテンツ管理者）。同デプロイで
  **16-4 添付アップロードも解禁**（WRITE_SCOPES に `drive`＋`attachments`）。
  `DRIVE_ENVIRONMENT_TAG=validation` のまま＝**§4 正式サービス名化の際に `production` へ切替**。
  ブラウザスモーク（文書確定→Drive保存／案件詳細→資料アップロード）で実ファイル確認のこと。
- Gmail 送信/受信・CloudSign（残）：`gmail-cloudsign.md`／`phase5-cloudsign-ignition.md`。
  - **連携の運用パラメータ（宛先 allowlist・送信元・チャンネル等の非秘密 7 項目）は
    設定画面「連携設定」タブから編集可能・即時反映（デプロイ不要）**（2026-08-11・同一インスタンス
    即時＋他インスタンス約1分以内・`phase11-settings-master.md` 11-1b）。
    live/disabled 切替は従来どおりデプロイ管理（点火統制は不変）。
  - **APIキー・トークン 7 件は設定画面「APIキー」タブから投入可能**（2026-08-11・
    `phase11-settings-master.md` 11-1c。保存先は Secret Manager のみ・書き込み専用・
    有効化済み連携のローテーションは即時反映）。対象：Backlog APIキー／Slack Bot トークン／
    Slack 署名シークレット／CloudSign クライアントID／Webhook トークン2件／ジョブ起動トークン。
    GWS SA 鍵（JSON）のみ従来どおり Cloud Shell。**初回のみ下の権限付与を実行**：
    ```bash
    SA=legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com
    for S in backlog-api-key SLACK_BOT_TOKEN slack-signing-secret cloudsign-client-id \
             CLOUDSIGN_WEBHOOK_TOKEN BACKLOG_WEBHOOK_TOKEN JOBS_TRIGGER_TOKEN; do
      gcloud secrets describe "$S" >/dev/null 2>&1 || gcloud secrets create "$S" --replication-policy=automatic
      for R in roles/secretmanager.secretVersionAdder roles/secretmanager.viewer roles/secretmanager.secretAccessor; do
        gcloud secrets add-iam-policy-binding "$S" --member="serviceAccount:$SA" --role="$R" --quiet >/dev/null
      done; echo "OK: $S"
    done
    ```
  - CloudSign：client_id を画面の APIキータブから `cloudsign-client-id` へ（リポジトリ厳禁）＋宛先 allowlist（任意・空=無制限）＋
    `_CLOUDSIGN_MODE=live`＋`_CONFIRM_CLOUDSIGN_DISPATCH`＋`_CLOUDSIGN_REQUEST_HISTORY_ENABLED`。
    live 後に cloudsign-sync resume＋CloudSign Webhook 登録（token secret 作成済み）で executed 遷移が自動化。
    システム外で作った契約書は案件に **PDF で添付**すれば、その添付から直接依頼できる
    （テンプレート不要・Drive の実体をそのまま送る）。PDF 以外は依頼時に理由付きで止まる。
  - Gmail：送信元アドレス決定＋Workspace 管理者の DWD 設定＋SA 鍵 Secret（`_GWS_SA_KEY_SECRET`・
    Gmail の JWT 署名は鍵必須）→ `_GMAIL_DELIVERY_MODE=live`＋`_CONFIRM_GMAIL_DISPATCH`＋`_GMAIL_SENDER`。

### 2-6. 表示・編集ギャップ第1波（2026-08-11・`display-edit-gap-audit.md`）
- データ破壊バグ2件（素材編集の備考消失・数量ベース受領の¥0黙殺）とアウト条件の集計漏れを修正（フラグ不要・デプロイのみ）。
- 担当者・権利者・作品ステータス・契約更新通告等の編集UIを追加（既存スコープで有効）。
- **条件明細の相手方補修**のみ要点火：グラント不要（018再利用）。デプロイ時に
  `_CONDITION_LINE_REPAIR_ENABLED=true`＋`_CONFIRM_CONDITION_LINE_REPAIR=CONDITION_LINE_REPAIR_LEGALBRIDGE_VALIDATION_ONLY`
  ＋`_WRITE_SCOPES` 末尾に `,condition-repair` を追加。

### 2-7. 文書テンプレートの投入（DB シード・フラグ不要）

テンプレート本体（Handlebars）とフォーム定義（`field_schema`）は DB の
`document_templates` / `document_template_versions` に入る。アプリ側のコード変更は不要で、
適用した時点で「文書作成」の一覧に出る（＝デプロイとは独立）。

適用は 2-0 の proxy＋`RUNTIME_ADMIN_DSN` を用意した上で：

```bash
psql "$RUNTIME_ADMIN_DSN" -v confirm_nda_revision=REVISE_NDA_TEMPLATE_V2 \
  -f infra/gcp/sql/049_nda_template_revision.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_payment_templates=SEED_PAYMENT_INVOICE_TEMPLATES \
  -f infra/gcp/sql/048_payment_invoice_templates.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_license_out=SEED_LICENSE_OUT_TEMPLATE \
  -f infra/gcp/sql/050_license_out_template.sql
```

いずれも二重適用ガード付き（既存なら `already exists` で安全に停止）。
適用後は各ファイル末尾の確認クエリで **`current_version_id` が NULL でない**ことを見る
（NULL なら一覧に出ない）。

| SQL | template_key | prefix | 状態 |
| --- | --- | --- | --- |
| 048 | `payment_notice` / `invoice` | ARC-PAY / ARC-INV | ✅ 適用済み（2026-08-14） |
| 049 | `nda`（v2 改訂） | 既存 | ✅ 適用済み（2026-08-13） |
| 050 | `license_out_en` | ARC-LOUT | ✅ 適用済み（2026-08-14・version 89） |
| 051 | `igla_license_en`（IGLA 本体） | ARC-IGLA | ✅ 適用済み（91項目・version 1） |
| 052 | `igla_license_annex_en`（IGLA 付属書1/2/3） | ARC-IGLAX | ✅ 適用済み（72項目・version 1） |
| 053 | `purchase_order` / `intl_purchase_order`（単一明細フォールバックの出し分け） | 既存 | ✅ 適用済み（2026-08-17） |

**054**（テンプレートではなく grant）：V1 の `matter_slack_threads` に **SELECT のみ**を付与し、
V1 で立てた案件スレッドを V2 が引き継げるようにする。V1 データは書き換えない。
**✅ 適用済み（2026-08-17）** — 適用時点で V1 21件／V2 3件／重複0件。未適用のままだと、
V1 でスレッドを立てた案件が V2 では「未作成」に見え、作成すると同じ案件に2本目の root が立つ。

```bash
psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
  -v confirm_matter_slack_thread=GRANT_PRODUCTION_MATTER_SLACK_THREAD_READ \
  -f infra/gcp/sql/054_production_matter_slack_thread_grants.sql
```

**055**：入力しても出力に反映されない項目をフォームから外す（053 と同じく現行版の
`field_schema` のみ書き換え・`html_source` 無変更・冪等）。対象は
`inspection_certificate`（発注日/総明細数/総予定回数/紐付け発注番号）・
`purchase_order` と `license_master`（番号の手動上書き）・`service_master`（契約開始日）。
`documents.form_data` には触れないので既存データの値は残る。
**✅ 適用済み（2026-08-17）** — 7項目を除去して残存0件。版は据え置き
（`inspection_certificate` 12／34項目・`license_master` 5／22項目・
`purchase_order` 22／50項目・`service_master` 8／22項目）。

```bash
psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
  -v confirm_orphan_fields=REMOVE_ORPHAN_FORM_FIELDS \
  -f infra/gcp/sql/055_remove_orphan_form_fields.sql
```

**056**：発注書の「基本契約あり」「基本契約名 / 番号」をフォームに出す。**✅ 適用済み（2026-08-17・version 22／50項目／html_len 21484 で前後不変）**。この2項目は
`type='hidden'` で画面に出ないまま、テンプレートの条項を出し分けていた
（真＝準拠契約「締結済みの基本契約（〇〇）に基づき発行される」／偽＝適用約款
「別紙スポット契約用約款が適用される」）。つまり法的な前提が変わる分岐を画面から
設定できなかった。`HAS_BASE_CONTRACT` を boolean、`MASTER_CONTRACT_REF` を text＋
`showWhen`（チェック時のみ表示）にする。053・055 と同じく現行版の `field_schema` のみ
書き換え・`html_source` 無変更・版据え置き・冪等。既存文書の出方は変わらない
（`form_data` 無変更＝過去の発注書は従来どおりスポット約款側）。

あわせて**コード側**も直した：「DBから引用 → 契約・文書」で契約を選んでも
`HAS_BASE_CONTRACT` が立たず、契約名だけ入って条項はスポット約款のままだった。
同じ処理が契約番号を `ORDER_NO` にも書いており、発注書では `ORDER_NO` が自分の
発注番号なので **PDF の発注番号が契約番号に化けていた**（`ORDER_NO` への書き込みは
ラベルが「親…」「基本契約…」のテンプレートに限定）。

```bash
psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
  -v confirm_base_contract_fields=SHOW_PURCHASE_ORDER_BASE_CONTRACT \
  -f infra/gcp/sql/056_purchase_order_base_contract_fields.sql
```

**057 / 058**：個人取引先の「担当者名／担当部署」に**口座名義カナ**が入っていた分の後始末。
発注書テンプレートは宛先ブロックに
`{{#if VENDOR_CONTACT_NAME}}{{VENDOR_CONTACT_DEPARTMENT}}　{{VENDOR_CONTACT_NAME}} 様{{/if}}`
を出すため、「斎田明也 様」の下に「サイタ　アキヤ　サイタ　アキヤ 様」が並んでいた。
個人の取引先に「担当者」は無く、カナは口座名義欄が持つ値なので担当者欄から外す。
対象は**担当者名（または担当部署）が口座名義カナと完全一致する行のみ**（前後・全角空白差は無視）。
本当の担当者名には触らない。

- **057（取引先マスタ）**＝**✅ 適用済み（2026-08-17）。対象 0 件**＝現行マスタは既にきれいだった。混入は過去のもので、V2 の引用処理が個人でも担当者欄を引いていたことが出力側の原因（コードで修正）。
- **058（確定済み文書の form_data）**＝**✅ 適用済み（2026-08-17・11 件）**。R2 を含む全件で残存 0・金額と口座名義は無傷。
  再発行では直らない（`document-reissue` は form_data を引き継ぐ。ARC-PO-2026-0117-R1 が
  同じ値を持っていたことで確認済み）。適用後は対象文書の PDF を再生成すると反映される。

**V1 との差**：V1 の発注書フォームは個人取引先では担当者・部署・代表者を明示的に空にしている
（`purchaseOrder.tsx` の `fillVendorFrom`「担当者・部署は法人の概念。個人取引先では空にする」）。
V2 はマスタの値をそのまま引いていたため、担当者名に何か入っていれば個人でも PDF に出た。
V2 側もこの規則に揃えた（個人＝担当者/部署/代表者は空、法人の「代表者名 (＋様)」は敬称込み）。

```bash
psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
  -v confirm_vendor_contact_kana=CLEAR_VENDOR_CONTACT_KANA \
  -f infra/gcp/sql/057_vendor_contact_kana_cleanup.sql

psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
  -v confirm_document_contact_kana=REPAIR_DOCUMENT_CONTACT_KANA \
  -f infra/gcp/sql/058_repair_document_contact_kana.sql
```

どちらも冪等。ローカル DB に本番同形のデータ（汚染2件＋法人の正しい担当者1件）を仕込んで
検証済み：汚染のみ消え、法人の担当者・口座名義・金額・特約は無傷。

**敬称（御中／様）は SQL 不要**。`vendors.entity_type` を正として描画時に解決するよう
コード側で直した（`registry-repository` の `find`/`findByNumber` が `vendors` を LEFT JOIN し、
宛名がマスタの名称（`vendor_name`/`trade_name`/`pen_name`）と一致するときだけ区分を採用する）。
`legalbridge_v2_runtime` の `vendors` SELECT は 006 で付与済みなので追加の grant も要らない。
既存文書は**再デプロイだけで直る**（`documents.form_data` は書き換えない）。マスタ側の区分が
間違っている場合はマスタを直せば全文書に効く。

未対応として残しているのは `pub_license_terms` の5項目（翻訳版・海外版の許諾有無／
対象地域言語／販売形態／計算式／料率）と `service_master` の乙種別。これらは
「項目が余っている」のではなく **テンプレート側に出力が無い**ため、消すと入力手段が
失われる。出力を追加する＝テンプレート改訂（新版）になるので別途対応する。

053 だけは新規テンプレートではなく **現行版の `field_schema` の書き換え**（`html_source` は
無変更）。明細が0件のときだけ単一明細フォールバック項目を出すようにし、発注書からは
未使用の `PAYMENT_METHOD` を落とす。**版は上げない**：新版を作って `current_version_id` を
差し替えると、既存文書の `template_version_id` と食い違って PDF 再発行・CloudSign 依頼が
`StoredDocumentTemplateVersionError` で全滅する。出力が変わる改訂のときだけ新版を作ること。
何度流しても結果は同じ（冪等）。

IGLA（051/052）は Deal Sheet の取引モデルで Schedule 1（License-Out）/ Schedule 2
（Product-Out）の出力を切り替える2部構成。本体と付属書は別文書なので、付属書を使う
案件では両方から作成し、Deal Sheet 第4節の Incorporated と付属書側の出力選択をそろえる。

### 2-8. 案件 Slack 会話履歴（`slack-matter-thread-history-fix-plan.md`）

案件詳細の「コミュニケーション」に Slack スレッドを時系列表示する。既存の
`lb_v2_slack_notification_history` の `slack_channel_id` / `slack_message_ts` を
スレッドアンカーとして再利用するため **DB スキーマ変更・grant 追加は不要**。

読取は既定 OFF。点火はデプロイ時の substitutions のみ：

```bash
jq '.substitutions._SLACK_CONVERSATION_READ_MODE = "live"' /tmp/build-flags.json > /tmp/bf.json && mv /tmp/bf.json /tmp/build-flags.json
# 任意：発言者が LegalBridge か依頼者かの判定精度を上げる（省略可）
jq '.substitutions._SLACK_BOT_USER_ID = "U0XXXXXXXXX"' /tmp/build-flags.json > /tmp/bf.json && mv /tmp/bf.json /tmp/build-flags.json
```

前提（verify がデプロイ前に検査する）：`_SLACK_BOT_TOKEN_SECRET` 設定済み・
`_SLACK_NOTIFICATION_HISTORY_ENABLED=true`（アンカーの供給元のため）。

**Slack App 側**：DM スレッドの読取に `im:history` が必要。付与後は再インストール
（ワークスペース管理者の承認が要る場合あり）。未付与のまま live にしても案件画面は
壊れず、Slack パネルだけが「参照権限がありません」と表示する。

**scope は機能ごとに別**（混同しやすい。2026-08-17 に実地で確認）：

| 機能 | 読む場所 | 必要な scope |
|---|---|---|
| 依頼者DM のスレッド履歴（`_SLACK_CONVERSATION_READ_MODE`） | DM | `im:history` |
| **案件 Slack パネル**（`matter_slack_threads`・`SLACK_LEGAL_CONSULT_CHANNEL`） | **公開チャンネル** | **`channels:history`** |
| 設定画面「通知」タブの**チャンネル選択UI**（`conversations.list`） | チャンネル一覧 | `channels:read`（非公開も選ぶなら `groups:read`） |

`channels:read` は未付与でも構わない。その場合は選択UIの代わりに**チャンネルIDの直接入力**に
なるだけで、通知設定そのものは行える（一覧取得の失敗はエラーにせず理由を画面に出す）。

**2026-08-18 時点の実トークンのスコープ**（`auth.test` のレスポンスヘッダより）:
`chat:write, im:write, users:read, commands, files:read, im:history, groups:read,
channels:history, groups:history, groups:write, incoming-webhook`
→ `groups:read` はあるが **`channels:read` が無い**。法務相談チャンネルは公開（`C…`）なので、
一覧を出したければ `channels:read` を追加して**再インストール**する（スコープ追加だけでは
トークンに付かない。再発行された Bot トークンは設定画面「APIキー」タブから入れ直す）。
`conversations.list` は公開＋非公開をまとめて要求すると片方のスコープ不足で全体が
`missing_scope` になるため、その場合は種別ごとに取り直して**取れる方だけ**を出す。

案件スレッドは V1 が法務相談チャンネルへルート投稿しているため、実データは全件
チャンネル（`channel_id` が `C` 始まり・V1 21件／V2 3件＝24件すべて）。`im:history` では
読めない。**✅ 2026-08-18 解決**（`channels:history` 付与＋再インストール → V1 由来の
スレッドも本文表示を確認）。

踏んだ落とし穴：**アプリ設定に scope を足しただけでは効かない**。トークンに付くのは
インストール時点の scope で、再インストールするまで古いままになる。設定画面を見ても
判別できないので、トークン自身に何が付いているかを Slack に聞く:

```bash
TOKEN=$(gcloud secrets versions access latest --secret=SLACK_BOT_TOKEN --project legalbridge-488506)
curl -sS -D- -o /dev/null -H "Authorization: Bearer $TOKEN" \
  https://slack.com/api/auth.test | grep -i '^x-oauth-scopes'
unset TOKEN
```

再インストールでトークン文字列は変わらなかったため、Secret 更新も再デプロイも不要だった。
変わった場合は Secret に新版を足し、`gcloud run services update --update-secrets=...` で
新リビジョンを作る（`:latest` はインスタンス起動時に解決されるため）。
`missing_scope` が消えたのに本文が出ないときは `not_in_channel`＝bot がチャンネル未参加。


送信側は同時に「1案件 = 1スレッド」へ統一される（2回目以降の通知は既存 root への
返信になる）。宛先が変わって既存スレッドの DM と一致しない場合は送信しない
（fail-closed）。読取 OFF のままでも送信側のスレッド集約は有効。

## 3. 利用者開放（認証・ロール）
- `_AUTH_LEGAL_EMAILS`（法務メンバー）・`_AUTH_REQUESTER_DOMAINS`（依頼者ドメイン）を実値に。
- アクセス方式の確定：現 cloudrun-iam（Google アカウントで IAM 付与）か IAP 化（`iap-access.md`）。
  利用者全員に roles/run.invoker（または IAP アクセス）を付与。
- スモーク：legal 1名・requester 1名で主要導線（依頼→作成→出力→検収→請求）を通す。

## 4. サービス名の正式化（`legalbridge-v2-write-test` → `legalbridge-v2`）

**Cloud Run のサービス名は変更できない。** 新しい名前でサービスを作り、向き先を移し、
旧サービスを畳む、という手順になる。旧サービスは削除するまで動き続けるので、
各段階で切り戻せる。

### 4-0. 前提（コード側・2026-08-18 対応済み）

- `verify-write-test.sh` の安全ゲートは**承認済みサービス名を1箇所で持つ**ようになった
  （`APPROVED_SERVICES="legalbridge-v2-write-test legalbridge-v2"`）。以前は 40 箇所に
  直書きされており、名前を変えると全ゲートで弾かれてデプロイできなかった。
  環境変数では上書きできない（安全ゲートを実行時に広げる手段を残さない）。
- 判定は `infra/gcp/verify-cases.sh` で固定してある（31 ケース・0.2 秒）。
  `deploy-write-test.sh` の事前検査で毎回走るので、ゲートを緩める変更は送信前に止まる。
- `deploy-write-test.sh` に `FLAGS_FROM` を追加した。**まだ存在しないサービスへ初めて出す**
  ときに、稼働中のサービスから 106 キーの substitutions を引き継げる。
  デプロイ先は `SERVICE` を正とする（`_SERVICE=` を引数で渡すとエラーにする＝
  引き継ぎ元と食い違って旧サービスへ上書きする事故を防ぐ）。

### 4-1. 新サービスをデプロイ

```bash
SERVICE=legalbridge-v2 FLAGS_FROM=legalbridge-v2-write-test \
  DRY_RUN=1 infra/gcp/deploy-write-test.sh
```

`_SERVICE` が `legalbridge-v2`、`substitutions: 106 キー`、他のフラグが現行と同じことを
確認してから `DRY_RUN=1` を外す。この時点では**誰も新サービスを見ていない**ので、
失敗しても現行運用に影響はない。

**✅ 2026-08-18 実施済み**：`https://legalbridge-v2-lkyrgniooa-an.a.run.app` /
revision `legalbridge-v2-00001-h7g` / メモリ 2Gi。安全ゲート（`verify-isolation` ステップ）が
本番ビルドで `legalbridge-v2` を承認済みサービスとして受け入れることを確認。
ビルドは IAP を設定しない（`--no-allow-unauthenticated` のみ）ため、この時点で
ブラウザから開くと 403。**それが正常**で、到達できるようになるのは 4-2 のあと。

### 4-2. IAP を新サービスにも通す

新サービスは IAP の背後に置く（`run.googleapis.com/iap-enabled: true`）。必要なのは:

- IAP OAuth クライアント `lb-v2-scheduler`
  （`988056987352-k521jsfnimvejpt9tj5doe2k6mcgdvu6.apps.googleusercontent.com`）を
  新サービスの IAP 設定 `accessSettings.oauthSettings.programmaticClients` に登録
- Scheduler の SA（`legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com`）に
  `roles/iap.httpsResourceAccessor`
  （`gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run --service=legalbridge-v2 --region=asia-northeast1`）
- 利用者（admin）のアクセス権

詳細な制約は `phase9-automation-ignition.md` §5 の実地知見を参照
（IAP はサービス URL を audience にした OIDC を受け付けない、等）。

**✅ 2026-08-18 実施済み**（programmaticClients の登録を除く）。実地でやったことは以下。
**推測でコマンドを打たず、現行サービスの設定を読んで合わせる**のが確実だった。

```bash
# ① IAP 有効化（gcloud 580 には --iap がある。無ければコンソール）
gcloud run services update legalbridge-v2 --project legalbridge-488506 \
  --region asia-northeast1 --iap
```

注釈が現行と揃うことを確認（`iap-enabled: 'true'` と `ingress: all`）。

**権限は2層あり、別物**。ここが最も間違えやすい:

| 層 | ロール | 誰に |
|---|---|---|
| Cloud Run の入口 | `roles/run.invoker` | Scheduler SA `legalbridge-v2-preview@`／IAP サービスエージェント `service-988056987352@gcp-sa-iap`／管理者 |
| IAP の入口 | `roles/iap.httpsResourceAccessor` | リレー SA `lb-v2-receiver@`／Scheduler SA `legalbridge-v2-preview@`／管理者 |

**リレー SA は `run.invoker` に入っていない**（IAP 側だけで許可される）。逆に IAP
サービスエージェントは `run.invoker` にだけ入る（`--iap` が自動で付ける）。
両方を現行サービスから読んで差分を埋める:

```bash
gcloud run services get-iam-policy legalbridge-v2-write-test --project legalbridge-488506 \
  --region asia-northeast1 --format='value(bindings.role, bindings.members)'
gcloud beta iap web get-iam-policy --resource-type=cloud-run \
  --service=legalbridge-v2-write-test --region=asia-northeast1 --project legalbridge-488506
```

新サービス側が空（`etag: ACAB`）なら、そのメンバーをそのまま付与する。

```bash
# 現行サービスの IAP 注釈（これと同じ状態を新サービスにも作る）
gcloud run services describe legalbridge-v2-write-test --project legalbridge-488506 \
  --region asia-northeast1 --format=yaml | grep -i -B2 -A2 iap
```

**programmaticClients の登録もコマンドで足りる**（2026-08-18 実地確認）。既存の知見は
「IAP OAuth Admin API は廃止済み→コンソール」だったが、廃止されたのは**クライアントの
作成**だけで、設定の読み書きは `gcloud iap settings get/set` で完結する。現行から読んで
そのまま新サービスへ流す:

```bash
gcloud iap settings get --resource-type=cloud-run \
  --service=legalbridge-v2-write-test --region=asia-northeast1 --project legalbridge-488506

cat > /tmp/iap-settings.yaml <<'YAML'
accessSettings:
  oauthSettings:
    programmaticClients:
    - 988056987352-k521jsfnimvejpt9tj5doe2k6mcgdvu6.apps.googleusercontent.com
YAML
gcloud iap settings set /tmp/iap-settings.yaml --resource-type=cloud-run \
  --service=legalbridge-v2 --region=asia-northeast1 --project legalbridge-488506
```

これが無いと Scheduler の OIDC が `Invalid JWT audience` で弾かれる。ブラウザからの
アクセスは登録前でも通る（人の認証は OAuth クライアントではなく IAP のログインで行うため）。

IAM の付与はコマンドで足りる:

```bash
gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run \
  --service=legalbridge-v2 --region=asia-northeast1 \
  --member="serviceAccount:legalbridge-v2-preview@legalbridge-488506.iam.gserviceaccount.com" \
  --role=roles/iap.httpsResourceAccessor
```

**4-2 が終わったかどうかの見分け方**：未認証で叩いたときの応答が Cloud Run の 403 から
**IAP の応答**（`x-goog-iap-generated-response: true`）に変わる。ブラウザ相当のリクエストでは
401 ではなく `302` で `accounts.google.com` へのリダイレクトになる。

**✅ 2026-08-18 完了**（`legalbridge-v2`・IAP 有効／2層の IAM を現行と一致／
programmaticClients 登録／302 リダイレクトを確認）。

```bash
curl -s -o /dev/null -D- https://legalbridge-v2-lkyrgniooa-an.a.run.app/ | head -5
```

**4-2 が済むまで 4-3・4-4 に進まないこと。** 先に向き先を移すと、IAP を通っていない
新サービスへジョブと webhook が飛んで全部失敗する（切り戻しは可能だが無駄な失敗が残る）。

### 4-3. Scheduler 3 ジョブの向き先を変える

**✅ 2026-08-18 実施済み。** 3ジョブとも audience は **IAP クライアント ID**
（`988056987352-k521js…`）で、サービス非依存だったため **`--uri` だけ**の差し替えで済んだ。
`phase9-automation-ignition.md` の作成コマンド例は `--oidc-token-audience "$SVC_URL"` のままで
実態と食い違っている（冒頭の実地知見の方が正しい）。**例を写さず、現行ジョブを読むこと**:

```bash
for job in lb-v2-daily-checks lb-v2-inspection-digest lb-v2-cloudsign-sync; do
  gcloud scheduler jobs describe "$job" --project legalbridge-488506 \
    --location asia-northeast1 \
    --format='value(name, httpTarget.uri, httpTarget.oidcToken.audience, httpTarget.oidcToken.serviceAccountEmail, state)'
done
```

`uri` のホスト部分だけを新サービスの URL に差し替える（audience・SA・ヘッダは据え置き）:

```bash
NEW_URL=$(gcloud run services describe legalbridge-v2 --project legalbridge-488506 \
  --region asia-northeast1 --format='value(status.url)')
for pair in "lb-v2-daily-checks:daily-checks" "lb-v2-inspection-digest:inspection-digest" \
            "lb-v2-cloudsign-sync:cloudsign-sync"; do
  gcloud scheduler jobs update http "${pair%%:*}" --project legalbridge-488506 \
    --location asia-northeast1 --uri "$NEW_URL/internal/jobs/${pair##*:}"
done
```

### 4-4. 受信リレーの転送先を変える

```bash
gcloud run services update lb-v2-receiver --project legalbridge-488506 \
  --region asia-northeast1 --update-env-vars UPSTREAM="$NEW_URL"
```

**外部サービス（CloudSign／Backlog／Slack）に登録した URL は変更不要。** 登録先は
すべてリレー（`lb-v2-receiver`）で、リレーの URL は変わらない。これが「webhook は
リレー宛に登録する」設計の効きどころ。

### 4-5. 動作確認

```bash
# ジョブ（ENABLED のものだけ。PAUSED では jobs run が使えない）
gcloud scheduler jobs run lb-v2-cloudsign-sync --project legalbridge-488506 --location asia-northeast1
sleep 20
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="legalbridge-v2"
   AND httpRequest.requestUrl:"/internal/jobs/cloudsign-sync"' \
  --project legalbridge-488506 --limit 3 --freshness 10m \
  --format='value(timestamp, httpRequest.status)'

# webhook（リレー経由・不正トークンで 401、正トークンで 200）
```

`200` が新サービス側のログに出れば、Scheduler → IAP → 新サービスが通っている。
**旧サービス側に同時刻のログが出ないこと**も併せて見る（切替漏れの検出）。

**✅ 2026-08-18 確認済み**：新サービスに 200／旧サービスに記録なし／webhook はリレー経由で
新サービスのハンドラが応答（`{"ok":true,"skipped":"unknown document","status":"sent"}`）。

なお `gcloud run services update` が表示する Service URL は
`https://lb-v2-receiver-988056987352.asia-northeast1.run.app` 形式になることがあるが、
CloudSign に登録済みの `https://lb-v2-receiver-lkyrgniooa-an.a.run.app` と**同じサービスを指す**
（Cloud Run の新旧2形式）。外部登録の変更は不要。

### 4-6. 利用者の向き先と旧サービスの扱い

ブックマーク・Slack のリンク・ドキュメントを新 URL へ。旧サービスは**すぐ削除しない**。
観察期間（§5-4 と同じ 2 週間目安）を置き、問題が出れば 4-3／4-4 を旧 URL に戻すだけで
切り戻せる。畳むときは Cloud Run サービスを削除する（`APPROVED_SERVICES` から
`legalbridge-v2-write-test` を外すかどうかは、検証用として残すか次第）。

### 切り戻し

| 段階 | 戻し方 |
|---|---|
| 4-1 まで | 何もしない（新サービスは誰も見ていない） |
| 4-3 後 | Scheduler の `--uri` を旧 URL へ戻す |
| 4-4 後 | リレーの `UPSTREAM` を旧 URL へ戻す |
| 4-6 後 | 利用者へ旧 URL を案内（旧サービスが生きている限り即時） |

## 5. V1 停止（段階的）
| 段階 | 内容 |
|---|---|
| 5-1 | V1 を読み取り専用運用に（書込は V2 へ誘導）。共有DBのため両輪書込期間を短く |
| 5-2 | V1 の cron/GAS トリガ停止＋**同時に V2 の lb-v2-daily-checks／lb-v2-inspection-digest を resume**（二重通知防止で PAUSED 中） |
| 5-3 | V1 Slack コマンドの向き先を V2 受信口へ切替（16-3 完了後） |
| 5-4 | 観察期間（2週間目安）後、V1 サービス停止・インフラ縮退 |

### 5-2a. Scheduler の棚卸し（2026-08-18 調査）

`gcloud scheduler jobs list` に 6 ジョブ。うち 2 つは **転送先の Cloud Run サービス
`legalbridge-work-service` が既に存在しない**（`gcloud run services list` に無し）。
`legalbridge-backlog-poller` は 10 分ごとに `NOT_FOUND` を出し続けており、
`legalbridge-daily-scheduler` も同様に無効。つまり work-service 由来の通知
（ロイヤリティ支払期日・製造イベント・承認/押印の滞留）は**既に配信されていない**。

| ジョブ | 向き先 | 判定 |
|---|---|---|
| `legalbridge-backlog-poller` | work-service（不在） | 削除 |
| `legalbridge-daily-scheduler` | work-service（不在） | 削除 |
| `daily-checks` | V1 | pause（V2 の lb-v2-daily-checks と入れ替え） |
| `lb-v2-daily-checks` | V2 | resume |
| `lb-v2-inspection-digest` | V2 | resume |
| `lb-v2-cloudsign-sync` | V2 | 既に resume 済み（2-4） |

work-service 通知の V2 移植は**不要**と判断した。根拠（同日実測）:

- `RoyaltyPayment` 0 件（V2 が使う `royalty_payments` は 26 件で別系統）
- `ManufacturingEvent` 0 件 / `manufacturing_events` 0 件
- `IssueWorkflow` 2 件・承認者 0・押印担当 0・最終更新 2026-04-15
- 転送先サービス自体が不在（ログも空）

つまり移植しても空テーブルを読むだけのコードが増える。設定画面（通知ごとの宛先・
ON/OFF・チャンネル選択 UI）は、**実データのある V2 側の通知**——`lb-v2-daily-checks`
の納品/契約アラートと `lb-v2-inspection-digest`——に対して作った（下記 5-2c）。

### 5-2c. 定期通知の設定画面（2026-08-18 実装・デプロイのみで有効）

設定画面に「通知」タブを追加。3 通知それぞれに **ON/OFF** と **投稿先チャンネル** を持つ。

| 通知 | 実行 | 既定の宛先 |
|---|---|---|
| 納期アラート（7日前/3日前/前日/超過） | 平日 9:00 `lb-v2-daily-checks` | 法務相談チャンネル |
| 契約更新アラート（更新拒絶の通告期限） | 平日 9:00 `lb-v2-daily-checks` | 同上 |
| 検収待ちダイジェスト | 平日 9:05 `lb-v2-inspection-digest` | 同上 |

- 保存先は `app_settings`（`NOTIFY_*_ENABLED` / `NOTIFY_*_CHANNEL`）。秘密ではないので
  Secret Manager は使わない。**新規グラント不要**（既存の設定書込スコープで動く）。
- 未保存＝従来どおり（ON・法務相談チャンネル）。**空欄を OFF と解釈しない**——一度も触って
  いない環境で通知が全部止まるため、`false`/`off`/`0`/`no` と読める値だけを停止扱いにする。
- daily-checks は 1 回の実行で 2 種類の通知を出すため、送信直前に台帳 kind で振り分け、
  **宛先ごとに束ねて投稿**する（別チャンネルを指定できる）。片方の投稿が失敗しても、
  もう片方は delivered のまま＝台帳に残り、再送されない。
- **OFF の通知は台帳に記録しない**。再度 ON にしたとき、その時点でまだ条件に合うものだけが飛ぶ。
- 反映は次回の配信から（ランタイム設定の TTL 60 秒に相乗り・デプロイ不要）。
- 投稿先には **Bot を参加させること**（未参加チャンネルは `not_in_channel` で落ちる）。
  一覧UIでは「（Bot 未参加）」と表示する。

### 5-2b. Backlog 取込の二重化が無いことの確認（2026-08-18）

Backlog Webhook を V2 受信リレーへ登録した日に、V1 の `daily-checks` も生きている
（日次 INFO・`legal_requests` は 8月17件/7月75件/6月59件/5月75件）。両方が起票すると
二重登録になるため確認した。結果は重複なし:

```
直近1日で backlog_issue_key の重複 → (0 rows)
LEGAL-284 → legal_requests 1 行（id 466）
LEGAL-284 → matters 1 行（id 218 / MTR-2026-00218）
```

V1 の `daily-checks` は期日チェックであって Backlog 取込ではない（取込は V1 の別経路）。
5-2 で `daily-checks` を pause する時点で V1 側の日次通知は止まる。

### 5-3. Slack スラッシュコマンドを V2 へ向ける（**V1 との切替**）

`/法務依頼`・`/法務検索` は現在 **V1 が受けている**
（`services/api/src/routes/slackGateway.ts` → V1 search-api の `/slack/commands`）。
V1 と V2 は**同じ Slack App**（同じ署名シークレット・同じ Bot トークン）を使っているため、
Request URL を書き換えた瞬間に **V1 の受付は止まり V2 に移る**。並行受付はできない。

したがって順番を守ること。**先に V2 側を起票できる状態にしてから URL を切り替える**。

#### 前提の確認（切替前に必ず）

```bash
# ① 署名シークレットが Secret Manager に入っているか（無ければ Slack App の
#    Basic Information → App Credentials → Signing Secret を設定画面「APIキー」タブから登録）
gcloud secrets versions list slack-signing-secret --project legalbridge-488506 --limit 1

# ② 現在の配信フラグ（_BACKLOG_MODE / _SLACK_INTAKE_ENABLED / _SLACK_SIGNING_SECRET_NAME）
IMG=$(gcloud run services describe legalbridge-v2 --project legalbridge-488506 \
  --region asia-northeast1 --format='value(spec.template.spec.containers[0].image)')
gcloud builds describe "${IMG##*:}" --project legalbridge-488506 --format=json \
  | jq '.substitutions | {_BACKLOG_MODE, _SLACK_INTAKE_ENABLED, _SLACK_SIGNING_SECRET_NAME, _BACKLOG_INTAKE_ENABLED}'

# ③ 受信リレーの URL（Slack に登録する先）
gcloud run services describe lb-v2-receiver --project legalbridge-488506 \
  --region asia-northeast1 --format='value(status.url)'
```

#### `_BACKLOG_MODE=live` が要る理由

V2 の `/法務依頼` は **`BACKLOG_MODE=live` のときだけ Backlog へ起票する**
（`app.ts`：`config.backlogMode === "live" ? dynamicBacklog : undefined`）。
`readonly` のまま URL を切り替えると、依頼は隔離台帳に入るだけで**課題が立たない**——
業務としては依頼が消えたのと同じになる。現状は `readonly`。

`live` は「V1 の worker が権威である間は塞ぐ」ため verify で拒否していた。V1 を畳む前提が
整ったので、**合言葉付きで解禁できるように変更した**（2026-08-18）:

- 合言葉 `_CONFIRM_BACKLOG_LIVE=BACKLOG_LIVE_CUTOVER_V2_AUTHORITATIVE`
  （＝「V2 が権威になった」という宣言そのもの）
- 承認済みサービス・`arclight.backlog.com`/`LEGAL`・IAP/IAM を併せて要求
- コメント書き戻しのゲートは `readonly` 固定をやめ、`disabled` 以外なら通す
  （live へ上げただけでデプロイが落ちないようにするため）

あわせて**読取が live で死ぬ不具合**を直した。`backlogReadClient` と接続確認アダプタが
`readonly` 限定だったため、live へ上げると依頼画面の Backlog 課題一覧が黙って空になっていた。
`backlogReadEnabled()`（`disabled` 以外なら true）に統一。

#### 手順

```bash
# 1) V2 を起票できる状態にする（Slack 受信口の解禁と同時でよい）
infra/gcp/deploy-write-test.sh \
  _BACKLOG_MODE=live \
  _CONFIRM_BACKLOG_LIVE=BACKLOG_LIVE_CUTOVER_V2_AUTHORITATIVE \
  _SLACK_INTAKE_ENABLED=true \
  _SLACK_SIGNING_SECRET_NAME=slack-signing-secret
```

2) Slack App（api.slack.com/apps → 対象アプリ）で Request URL を差し替える。
   `RECV_URL` は上の③で得た受信リレーの URL:

   | 設定箇所 | Request URL |
   |---|---|
   | Slash Commands `/法務依頼` | `<RECV_URL>/internal/slack/commands` |
   | Slash Commands `/法務検索` | `<RECV_URL>/internal/slack/commands` |
   | Interactivity & Shortcuts | `<RECV_URL>/internal/slack/interactivity` |

   必要スコープ `commands` は付与済み。`chat:write` も既にある。

3) スモーク（本番の Backlog に課題が立つので、テスト課題は後で消すこと）:
   - Slack で `/法務依頼` → モーダルが開く（開かなければ署名か bot トークン）
   - 送信 → Backlog LEGAL に課題が立つ／`legal_requests` に 1 行／`matters` に 1 行
   - `/法務検索` → 契約検索が返る

```sql
-- 直近の取込を確認（受信記録＋起票結果）
SELECT id, backlog_issue_key, title, created_at
  FROM legal_requests ORDER BY id DESC LIMIT 5;
```

#### 切り戻し

Slack App の Request URL を V1 の `https://<V1 search-api>/slack/commands`
／`/slack/interactivity` に戻す。V2 側のフラグはそのままでよい（受け口が呼ばれなくなるだけ）。

## 6. cutover 判定チェックリスト
- [ ] Phase 16-3（Slack インテーク）実装・点火済み
- [x] Phase 16-1/2/4 実装済み（点火は 16-1＝grant 045、16-4＝Drive 構成が前提）
- [x] grant 031・043・044・045・046 適用済み（2026-08-10・6項目検証済み）
- [x] マスタ書込スコープ点火済み（2-2・2026-08-10。snippets・満了遷移も同時点火）
- [x] Scheduler 3 ジョブ作成・疎通済み（2-3・2026-08-10。resume は 5-2／CloudSign live 時）
- [x] Webhook 受信 live（2-4・Backlog 分＝リレー＋自動起票スモーク成功。Backlog コンソール登録と Slack App 設定が残）
- [x] Drive live＋添付アップロード解禁（2-5・2026-08-10。タグは §4 で production へ）
- [ ] CloudSign/Gmail live（2-5 残・外部準備待ち：client_id secret／DWD＋SA鍵）
- [ ] legal/requester 開放＋スモーク合格（3）
- [ ] 正式サービス名で稼働（4）
- [ ] V1 読み取り専用化→停止（5）

> 未決の業務判断（保留中）：非アプリユーザー向けポータル（U3/4/5）の廃止可否／LegalOn（U9）・RPT（Phase 14）の
> 実利用有無／Ringi（11-9）。回答があり次第このチェックリストに反映する。
