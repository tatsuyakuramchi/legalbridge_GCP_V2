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
- cloudsign-sync：CloudSign 未構成の間はランナー未登録（404）。→ **2-5 CloudSign live 後に resume**。

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
     （scopes: commands, chat:write。Backlog 未 live の間は dry-run＝隔離台帳のみで安全に検証可）。
   - CloudSign Webhook は 2-5 の CloudSign live と同時に（secret は作成済み）

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

- **057（取引先マスタ）**＝今後作成する文書への対策。安全。まずこれを流す。
- **058（確定済み文書の form_data）**＝既存文書の修正。**確定済みデータの改変**なので業務判断のうえで。
  再発行では直らない（`document-reissue` は form_data を引き継ぐ。ARC-PO-2026-0117-R1 が
  同じ値を持っていたことで確認済み）。適用後は対象文書の PDF を再生成すると反映される。

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

送信側は同時に「1案件 = 1スレッド」へ統一される（2回目以降の通知は既存 root への
返信になる）。宛先が変わって既存スレッドの DM と一致しない場合は送信しない
（fail-closed）。読取 OFF のままでも送信側のスレッド集約は有効。

## 3. 利用者開放（認証・ロール）
- `_AUTH_LEGAL_EMAILS`（法務メンバー）・`_AUTH_REQUESTER_DOMAINS`（依頼者ドメイン）を実値に。
- アクセス方式の確定：現 cloudrun-iam（Google アカウントで IAM 付与）か IAP 化（`iap-access.md`）。
  利用者全員に roles/run.invoker（または IAP アクセス）を付与。
- スモーク：legal 1名・requester 1名で主要導線（依頼→作成→出力→検収→請求）を通す。

## 4. サービス名の正式化
現サービスは `legalbridge-v2-write-test`。載せ替え時に：
1. 同構成で `legalbridge-v2`（正式名）を新規デプロイ（cloudbuild の `_SERVICE`/`_IMAGE` 差替え。
   verify の write-test 限定ゲートは正式サービス名を許可するよう更新が必要）。
2. DNS/ブックマーク/Slack リンクの向き先を切替。write-test は検証用として残すか停止。

## 5. V1 停止（段階的）
| 段階 | 内容 |
|---|---|
| 5-1 | V1 を読み取り専用運用に（書込は V2 へ誘導）。共有DBのため両輪書込期間を短く |
| 5-2 | V1 の cron/GAS トリガ停止＋**同時に V2 の lb-v2-daily-checks／lb-v2-inspection-digest を resume**（二重通知防止で PAUSED 中） |
| 5-3 | V1 Slack コマンドの向き先を V2 受信口へ切替（16-3 完了後） |
| 5-4 | 観察期間（2週間目安）後、V1 サービス停止・インフラ縮退 |

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
