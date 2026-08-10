# Phase 11：設定・マスタ書込（運用自立）

V2 の Admin は読取専用ステータスのみ。設定・承認ルート・台帳/契約マスタの編集系が欠落しており、
管理者が V2 だけで運用を自己完結できない（cutover の Tier 1 ブロッカー）。本フェーズで解消する。

## スライス

| # | 機能 | 粒度 | 状態 |
|---|---|---|---|
| 11-1 | システム設定（会社プロファイル） | 中 | ✅ 実装済 |
| 11-2 | 承認ルート/ワークフロールール設定 | 中 | ✅ 実装済 |
| 11-3 | 台帳マスタ CRUD 書込 | 中 | ✅ 実装済（Create/Update は既存・今回 vendor 無効化を追加） |
| 11-4 | 契約マスタ CRUD | 中 | ✅ 実装済（既存契約の更新・状態変更。登録は intake が担う） |
| 11-5 | 原作マテリアル登録ワークフロー | 中 | ✅ 実装済（原作起点の追加/編集 UX。materials write は既存） |
| 11-6〜11-9 | PII同意/bulk/テーマ/稟議 | 小〜中 | 優先低・要判断（Ringi 保留） |

## 11-1：システム設定（会社プロファイル）✅ 実装済

共有 `app_settings`（`key VARCHAR PK / value JSONB`）を V2 が所有・編集する。V1 も同表を参照するため
V1/V2 で自社情報が一貫する。**安全のため編集可能キーは会社プロファイル（表示用・非機密）に allowlist**。
連携トグルや秘密（INTEGRATION_MODE・各種トークン）は env/デプロイ管理のまま＝ここでは触らない。

- `settings/settings-schema.ts`：`COMPANY_PROFILE_FIELDS`（会社名/カナ/郵便番号/住所/TEL/FAX/代表者/
  適格請求書番号(T)/振込先/備考）＋`ALLOWED_SETTING_KEYS`＋`settingsSaveSchema`（allowlist 外キーは 400）。
- **grant 036**（`036_production_app_settings_grants.sql`＋preflight）：`app_settings` に SELECT/INSERT/UPDATE
  （upsert 用）。token `GRANT_PRODUCTION_APP_SETTINGS`。行削除は許可しない。
- `settings/settings-repository.ts`（Pg/Memory）：`get(keys)`（JSONB→文字列・42P01 は空縮退）／
  `save(values)`（`INSERT ... ON CONFLICT (key) DO UPDATE`・JSON 文字列で格納・42501 は throw）。
- `settings/settings-routes.ts`：`GET /settings`（**admin のみ**・現在値＋フィールド定義）＋
  `POST /settings`（guarded・admin のみ・allowlist・42501→FORBIDDEN_DB）。
- config `SETTINGS_WRITE_ENABLED`／app.ts（gating・safe-write scope `settings`・writeCapabilities）／
  verify（write-test＋IAP/IAM＋WRITE_SCOPES 正準順に `settings`）／cloudbuild 全結線。
- UI：`SettingsWorkspace`（マスタ・設定＞システム設定・admin）＝会社プロファイル編集フォーム
  （capability 有効時のみ保存・変更キーのみ送信・未有効化は FeatureLockedNote で閲覧のみ）。
- tests：403/現在値/無効時503/保存/allowlist外400/空400/FORBIDDEN_DB の 7 件。623 緑。

### 点火（本番）
```bash
psql "" -f infra/gcp/sql/036_production_app_settings_preflight.sql || true
psql "" -v confirm_app_settings=GRANT_PRODUCTION_APP_SETTINGS \
  -f infra/gcp/sql/036_production_app_settings_grants.sql
```
Profile D substitutions 末尾へ `|_SETTINGS_WRITE_ENABLED=true`、`_WRITE_SCOPES` の `excel-batch`
直後に `settings` を追加（正準順）。**閲覧は grant/フラグ不要**（app_settings が空でも空表示）、
編集のみ点火が要る。

> 将来：V2 の帳票レンダリング（テンプレート）に会社プロファイルを差し込む配線は別スライスで
> （現状 app_settings は保存されるが V2 レンダリングは未参照＝V1 と共有データの先行整備）。

## 11-3：台帳マスタ CRUD ✅ 実装済

**調査で判明**：gap 台帳の 11-3 は自動監査が読取専用の `/ledgers/:type` ファサードだけを見て
過大計上していた。実際には **Create/Update は Phase 2/4/8 で実装済み**：
- 取引先 `vendors/write-*`（create/update）／作品 `works/write-*`（create/update・**有効/無効トグル既存**）／
  担当者 `staff/*`／原作マテリアル `materials/write-*`。
- ただしこれらは**現行デプロイの WRITE_SCOPES に含まれておらず未有効**（cutover 時に有効化が必要＝
  コードでなくデプロイ設定）。

唯一の実ギャップは **取引先の論理削除（有効/無効）**（作品は既に有効/無効トグルあり）。本スライスで解消：
- `vendors/write-schema.ts`：create/update に `isActive`（既定 true）を追加。
- `vendors/write-repository.ts`：COLUMNS に `isActive→is_active`、`find` が `is_active` を返す。
  **新規 GRANT 不要**（`vendors.is_active` UPDATE は grant 009 で付与済み・名寄せが既に使用）。
- UI：`LedgerWorkspace` の取引先編集フォームに「有効/無効」トグルを追加（作品と同型）。
- tests：取引先を無効化して再取得で反映される 1 件。624 緑。

### cutover での「マスタ書込」有効化（コード不要・デプロイ設定）
Create/Update/無効化を本番で使うには WRITE_SCOPES に該当スコープを足す：
`vendors`（取引先）・`works`（作品）・`materials`（原作マテリアル）・`staff`（担当者）と、
各 `*_WRITES_ENABLED=true`＋確認トークン＋対応 GRANT（既存の 009〜013/017 等）。
> 台帳マスタの CRUD 自体は揃っている。cutover 時に「どのマスタ編集を V2 で解禁するか」を選んで有効化する。

## 11-2：承認ルート（department_workflow_rules）✅ 実装済

部門ごとの承認者/押印担当/責任者の Slack ID・部署チャンネル・有効フラグを管理する。共有
`department_workflow_rules`（department UNIQUE・V1 の通知/承認ルーティングも参照）を V2 が upsert。

- `settings/workflow-rules-schema.ts`：`workflowRuleSchema`（department 必須・Slack ID は U/W/C 形式か空・
  isActive 既定 true）。
- **grant 037**（`037_production_workflow_rules_grants.sql`＋preflight）：`department_workflow_rules` に
  SELECT/INSERT/UPDATE＋シーケンス USAGE（upsert・新部門 INSERT 用）。DELETE は付与しない（is_active で無効化）。
  token `GRANT_PRODUCTION_WORKFLOW_RULES`。V1 既存テーブル＝CREATE しない。
- `settings/workflow-rules-repository.ts`（Pg/Memory）：`list`（42P01 空縮退）／`upsert`
  （ON CONFLICT (department)・42501 throw）。
- `settings/workflow-rules-routes.ts`：`GET /workflow-rules`（admin）＋`POST /workflow-rules`
  （guarded・admin・department 一意・42501→FORBIDDEN_DB）。
- config `WORKFLOW_RULES_WRITE_ENABLED`／app.ts（gating・scope `workflow-rules`・writeCapabilities）／
  verify（write-test＋IAP/IAM＋WRITE_SCOPES 正準順）／cloudbuild 全結線。
- UI：`WorkflowRulesWorkspace`（マスタ・設定＞承認ルート・admin）＝部門別一覧＋編集フォーム
  （承認者/押印/責任者 Slack ID・チャンネル・有効/無効・新規部門追加・capability 有効時のみ保存）。
- tests：403/一覧/無効時503/upsert 一意/不正 Slack ID 400/部門空 400/FORBIDDEN_DB の 7 件。631 緑。

### 点火（本番）
```bash
psql "" -f infra/gcp/sql/037_production_workflow_rules_preflight.sql || true
psql "" -v confirm_workflow_rules=GRANT_PRODUCTION_WORKFLOW_RULES \
  -f infra/gcp/sql/037_production_workflow_rules_grants.sql
```
Profile D substitutions 末尾へ `|_WORKFLOW_RULES_WRITE_ENABLED=true`、`_WRITE_SCOPES` の `settings`
直後に `workflow-rules` を追加。閲覧は grant/フラグ不要・編集のみ点火要。

> 将来：V2 の Slack 承認/通知ルーティングが department_workflow_rules を参照する配線は別スライス
> （現状は保存され V1 が参照する共有データの先行整備）。

## 11-5：原作マテリアル登録ワークフロー ✅ 実装済

**調査**：materials write（create/update・work_materials）は Phase 4 で実装済みで、create は元々
work_id 必須＝作品スコープ。素材タブ読取のみだったのは UI で、バックエンドは揃っていた。V1 の
「原作→素材起点で作成/編集」の実体＝**作品詳細から素材を追加/編集する UX**を本スライスで補完。

- `WorkDetail`（権利・条件＞作品）の素材タブに **原作起点の素材フォーム**を追加：
  - `canEditMaterials`（既存 `materials` capability）有効時のみ「素材を追加」＋各行「編集」。
  - 新規は現在の作品 id を workId として `POST /materials`、更新は `PATCH /materials/:id`（既存 API 再利用）。
  - 素材名・種別・役割・取得区分・権利区分・権利者・備考・**ロイヤリティ対象（金銭条件付帯）**トグル。
- **新規 grant/config/endpoint なし**（既存 materials write を作品起点で呼ぶだけ）。tests 631 緑（既存維持）。

> **見送り（将来）**：①素材の安全削除＝work_materials に is_active 列が無く、ハード DELETE は
> 参照（condition_lines 等）チェック＋DELETE grant が要るため別スライス。②「金銭条件付帯必須」の
> ハード強制＝現状は isRoyaltyBearing フラグまで（条件明細への必須リンクは条件オペ Phase 13 と併せて検討）。

## 11-4：契約マスタ CRUD ✅ 実装済

**調査で判明**：gap 台帳の 11-4 は「登録・更新・状態変更」を想定していたが、**契約の新規登録(INSERT)は
既に contract-intake（`contracts/intake-repository.ts`）が担っている**（締結済インバウンド契約の取込）。
実ギャップは **既存 contracts 行の中核項目編集とライフサイクル状態変更**。ここに絞って実装した。

- `contracts/contract-master-schema.ts`：`LIFECYCLE_STAGES`（requested〜terminated の 9 値）＋
  `contractUpdateSchema`（表題・有効期間・自動更新・更新通知/アラート月数・レビュー期日。**全 optional・
  部分更新**＝省略キーは触らない。transform は optional の undefined でも走るため `undefined` はそのまま
  返して出力にキーを増やさない＝**部分 PATCH が他列を null で潰さない**）＋`contractStatusSchema`。
- **grant 038**（`038_production_contract_master_grants.sql`＋preflight）：`contracts` に**列単位 UPDATE**
  （lifecycle_stage / contract_status / contract_title / effective_date / expiration_date / auto_renewal /
  renewal_notice_months / alert_lead_months / review_due_date の 9 列のみ）。token
  `GRANT_PRODUCTION_CONTRACT_MASTER`。全列 UPDATE・DELETE は付与しない（SELECT は 006/intake で既存、
  primary_vendor_id は 018 で既存）。
- `contracts/contract-master-repository.ts`（Pg/Memory）：`list(q)`（文書番号/表題/種別 ILIKE・締結/起票日 desc）／
  `find(id)`／`update(id, input)`（`FIELD_COLUMNS` 動的 assignment・in 演算子で存在キーのみ）／
  `setStatus(id, {lifecycleStage})`（**lifecycle_stage のみ更新**。contract_status は V1 の文書レベル語彙を持つ
  legacy 列のため触らない＝S-A/P0-7 で修正済み）。
- `contracts/contract-master-routes.ts`：`GET /contracts`（**admin/legal**・q 検索）＋
  `PATCH /contracts/:id`（guarded・部分更新）＋`PATCH /contracts/:id/status`（guarded・状態変更）。
  42501→CONTRACT_MASTER_FORBIDDEN_DB(503)／CONTRACT_NOT_FOUND→404。
- config `CONTRACT_MASTER_WRITE_ENABLED`／app.ts（gating・scope `contract-master`・safe-write は
  `PATCH /contracts/:id(/status)`・writeCapabilities 両所・OR-chain）／verify（write-test＋IAP/IAM＋
  WRITE_SCOPES 正準順で workflow-rules 直後に `contract-master`）／cloudbuild 全結線。
- UI：`ContractMasterWorkspace`（マスタ・設定＞契約マスタ・admin/legal）＝一覧＋検索、行内で表題・有効期間・
  自動更新の**インライン編集**、状態は**セレクトで即時変更**（capability 有効時のみ・未有効化は
  FeatureLockedNote で閲覧のみ）。
- tests：403(読取)／一覧／検索／無効時503／中核更新／空更新400／404／状態変更／不正状態400／
  編集不可403／FORBIDDEN_DB の 11 件。**642 緑**。

### 点火（本番）
```bash
psql "" -f infra/gcp/sql/038_production_contract_master_preflight.sql || true
psql "" -v confirm_contract_master=GRANT_PRODUCTION_CONTRACT_MASTER \
  -f infra/gcp/sql/038_production_contract_master_grants.sql
```
Profile D substitutions 末尾へ `|_CONTRACT_MASTER_WRITE_ENABLED=true`、`_WRITE_SCOPES` の `workflow-rules`
直後に `contract-master` を追加（正準順）。**閲覧は grant/フラグ不要**（admin/legal は既存 SELECT で見える）、
編集のみ点火が要る。

## Phase 11 まとめ（cutover Tier 1 完了）
11-1 設定 ／ 11-2 承認ルート ／ 11-3 台帳マスタ（Create/Update 既存＋vendor 無効化）／
11-4 契約マスタ（既存契約の更新・状態変更）／ 11-5 原作起点マテリアル登録 を実装。
**cutover Tier 1（運用自立＝管理者が V2 だけで設定・マスタ・承認ルート・契約を自己完結）が揃った**。
残 11-6〜11-9（優先低・Ringi 保留）。

## 次スライス候補
- Phase 12（データ保守・検出→修復）／cutover runbook（Phase 7・各種点火＋master WRITE_SCOPES 有効化）
