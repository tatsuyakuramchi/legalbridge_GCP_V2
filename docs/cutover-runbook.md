# V1→V2 サービス載せ替え Runbook（2026-08-10 起草）

V2（本リポジトリ）を本番サービスとして V1（legalbridge_ai_gcp）から載せ替えるまでの全手順。
監査（`cutover-readiness-audit.md`）・gap 台帳（`v1-v2-gap-remaining.md`）・Phase 9 点火手順
（`phase9-automation-ignition.md`）を1本に束ねる。**上から順に消し込む**チェックリスト構成。

## 0. 現在地（2026-08-10 デプロイ・点火完了時点）

- コード：Phase 1〜11 Tier 1＋監査修正 S-A〜S-F（build 82aa5b31…）。
- 適用済み grant：001〜030・032〜042（**031 のみ未適用** — 下記 2-1）。
- 有効スコープ：drafts, documents, pdf, slack-approvals, matters, matter-merge, matter-delete,
  document-void, document-reissue, excel-batch, settings, workflow-rules, contract-master,
  slack, slack-dispatch, matter-slack。
- ジョブ基盤 JOBS_ENABLED=true（**Cloud Scheduler は未作成**＝手動/未点火）。
- 連携：Slack live／Gmail・CloudSign・Drive・Backlog は disabled/dry-run。
- 認証：cloudrun-iam（admin 1名のみ。legal/requester は未開放）。

## 1. 残実装（コード）— cutover 前に必要

| # | 内容 | 状態 |
|---|---|---|
| 1-1 | **Phase 16-3：Slack インテーク** | ✅ 16-3a〜16-3c 実装済（受信口＋/法務依頼＝明細行・既存課題紐付け・納期変更込み＋/法務検索・grant 044）。点火は `phase16-cutover-gaps.md`（公開 ingress 決定が前提） |
| 1-2 | Phase 16-1：スニペットのサーバ共有化 | ✅ 実装済（guarded・grant 045＋`_SNIPPETS_WRITE_ENABLED=true`＋WRITE_SCOPES へ `snippets`（contract-master の直後）。点火は `phase16-cutover-gaps.md`） |
| 1-3 | Phase 16-2：契約チェック API | ✅ 実装済（読取専用・grant 不要・全ロール。/法務検索 16-3b の前提解消） |
| 1-4 | Phase 16-4：添付アップロード（multipart） | ✅ 実装済（新規 grant 不要。点火＝Drive ストレージ構成＋`_ATTACHMENT_UPLOAD_ENABLED=true`＋WRITE_SCOPES へ `attachments`（snippets の直後）。`phase16-cutover-gaps.md`） |
| 1-5 | 9-7 Backlog Webhook 自動起票（受信→legal_requests 作成） | ✅ 実装済（課題追加→自動取込＋Slack経由は受付済み遷移＋type=2 状態同期。点火＝grant 046＋`_BACKLOG_INTAKE_ENABLED=true`＋`_BACKLOG_WEBHOOK_TOKEN_SECRET`。公開 ingress（2-4）が前提。`phase9-automation-plan.md` 9-7） |
| 1-6 | V2 帳票への会社プロファイル差込（app_settings 参照。現状ハードコード） | 未着手（小） |

> B 群（納期変更・DQ トリアージ等）は V1 併走中は V1 側で運用＝cutover ブロッカーではない。

## 2. 点火メニュー（実装済み・スイッチ待ち）

### 2-1. 満了自動遷移（grant 031 未適用）
```bash
psql "" -f infra/gcp/sql/031_production_contract_expiry_preflight.sql || true
psql "" -v confirm_contract_expiry=GRANT_PRODUCTION_CONTRACT_EXPIRY \
  -f infra/gcp/sql/031_production_contract_expiry_grants.sql
```
substitutions：`_CONTRACT_EXPIRY_TRANSITION_ENABLED=true`＋`_CONFIRM_CONTRACT_EXPIRY=<verify の要求値>`。
※トークン名・要求値は 031 ファイルと verify-write-test.sh の該当 case を参照。

### 2-2. マスタ書込（台帳の Create/Update を解禁）
grant は適用済み（009/010/011 系）。**043（名寄せの documents.vendor_id）だけ追加適用**：
```bash
psql "" -v confirm_vendor_merge_documents=GRANT_PRODUCTION_VENDOR_MERGE_DOCUMENTS \
  -f infra/gcp/sql/043_production_vendor_merge_documents_grants.sql
```
substitutions：`_VENDOR_WRITES_ENABLED/_STAFF_WRITES_ENABLED/_WORK_WRITES_ENABLED/_MATERIAL_WRITES_ENABLED/
_RIGHTS_SOURCE_WRITES_ENABLED/_VENDOR_MERGE_ENABLED=true`＋対応する `_CONFIRM_*`（verify の要求値）＋
`_WRITE_SCOPES` へ正準順で `vendors,staff,works,materials,rights-sources,vendor-merge` を挿入
（canonical: drafts,documents,pdf,[drive,]slack-approvals,[outbound-conditions,contract-intake,]matters,
vendors,staff,works,materials,rights-sources,vendor-merge,matter-merge,…）。

### 2-3. Cloud Scheduler（督促ジョブの自動化）
`phase9-automation-ignition.md` §Scheduler の通り：JOBS_TRIGGER_TOKEN を使い
`lb-v2-daily-checks`（毎朝）／`lb-v2-inspection-digest`（週次）／`lb-v2-cloudsign-sync`（CloudSign live 後）を作成。

### 2-4. 外部 Webhook（CloudSign/Backlog）＋ Slack 受信（Phase 16-3）
**公開 ingress の判断が前提**（Cloud Run IAM は外部 OIDC 無しの caller を通せない）。選択肢は
`phase9-automation-ignition.md` §ingress 参照（推奨：受信専用の別 Cloud Run サービスを allUsers＋
アプリ層トークン/署名検証で公開し、本体は IAM のまま）。決定後：
`_CLOUDSIGN_WEBHOOK_TOKEN_SECRET`/`_BACKLOG_WEBHOOK_TOKEN_SECRET` を Secret 登録→substitutions 設定。
Slack（16-3）は Slack App の signing secret 検証で同じ受信サービスに同居させる。

### 2-5. 統合 live 化（Drive / Gmail / CloudSign）
- Drive：`phase5-integration-readiness.md`＋`drive-integration.md`。SA 鍵 Secret・フォルダID →
  `_DRIVE_STORAGE_ENABLED=true`＋`_CONFIRM_DRIVE_STORAGE`。（grant 039 で drive_link UPDATE は付与済み）
- Gmail 送信/受信・CloudSign：`gmail-cloudsign.md`／`phase5-cloudsign-ignition.md`。CloudSign live 後に
  2-3 の cloudsign-sync と 2-4 の Webhook を有効化すると executed 遷移が自動化される（grant 031/039 適用済み前提）。

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
| 5-2 | V1 の cron/GAS トリガ停止（daily-checks 等は V2 Scheduler に移譲済みであること） |
| 5-3 | V1 Slack コマンドの向き先を V2 受信口へ切替（16-3 完了後） |
| 5-4 | 観察期間（2週間目安）後、V1 サービス停止・インフラ縮退 |

## 6. cutover 判定チェックリスト
- [ ] Phase 16-3（Slack インテーク）実装・点火済み
- [x] Phase 16-1/2/4 実装済み（点火は 16-1＝grant 045、16-4＝Drive 構成が前提）
- [ ] grant 031・043 適用済み
- [ ] マスタ書込スコープ点火済み（2-2）
- [ ] Scheduler 3 ジョブ稼働（2-3）
- [ ] Webhook 受信 live（2-4）・CloudSign/Gmail/Drive live（2-5）
- [ ] legal/requester 開放＋スモーク合格（3）
- [ ] 正式サービス名で稼働（4）
- [ ] V1 読み取り専用化→停止（5）

> 未決の業務判断（保留中）：非アプリユーザー向けポータル（U3/4/5）の廃止可否／LegalOn（U9）・RPT（Phase 14）の
> 実利用有無／Ringi（11-9）。回答があり次第このチェックリストに反映する。
