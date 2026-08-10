# V1→V2 未移植機能 残課題一覧（2026-08-09 監査）

V1（`legalbridge_ai_gcp`）と V2（本リポジトリ）を突き合わせ、**Phase 1〜8 で移植済みの機能を除外した未移植機能**を洗い出したもの。
バックエンドAPI・フロントエンド・自動処理/連携の 3 観点で並列監査し、重複を統合した。

> **2026-08-10 追記**：載せ替え前の再監査で、本台帳に**行が無い未追跡ギャップ 23 件（U1〜U23）**と
> DB スキーマ矛盾・UX 違反を検出。**`docs/cutover-readiness-audit.md` を必ず併読のこと**（P0 は載せ替え前必修）。
> 特に U1 Slack スラッシュコマンド受信口（V1 の依頼インテーク主経路）は本台帳のどの Phase にも未収載。

## 前提・注意

- 既移植（対象外）：金銭/ロイヤリティ/受領/支払/請求（P1）、作品/権利ソース/製品（P2）、Backlog課題read＋コメント書戻し＋変数抽出（P3）、データ品質俯瞰/CSV取込/取引先名寄せ/古ドラフト整理/Excel・CSVパーサ（P4）、Gmail送受信/CloudSign送信・状態/Slackディスパッチ・承認（P5）、エクスポート/運用ガイド/スニペット/案件アーカイブ表示/契約チェック（P6）、案件Slackメンション（P7）、案件管理（課題/文書/送信/Drive/名寄せ/削除・P8）。
- **`docs/v1-v2-parity-checklist.md` は古い**（既移植分を未移植と誤記）。本ファイルが最新の残課題台帳。
- **稟議（Ringi）** は parity-checklist で 2026-08-06 に廃止決定済み（Slack承認＋案件ステータスで代替）。「稟議マスタ（RingiPanel）」の扱いは要トリアージ（廃止に含めるか）。
- 粒度＝実装ボリューム（小/中/大）。優先度は業務影響で暫定付与。着手前にトリアージ推奨。

---

## ⭐ 自動化基盤（Phase 9 で解消済み・2026-08-10 更新）

~~V2 には Cloud Scheduler / cron・Webhook 受信口が一切存在しない~~ → **Phase 9 で実装済み**：
`/internal/jobs/:name`（共有シークレット）＋ daily-checks / inspection-digest / cloudsign-sync ランナー、
`/internal/webhooks/{cloudsign,backlog}` 受信口（冪等・lb_v2_webhook_receipts）。本番点火は未（runbook =
`docs/phase9-automation-ignition.md`）。**残乖離**：9-7 Backlog Webhook は受信記録＋Slack 通知のみで、
V1 の自動起票（legal_requests 作成）は未実装（`cutover-readiness-audit.md` P2 参照）。
また **Slack スラッシュコマンド/インタラクティビティ受信口（U1）は Phase 9 の範囲外のまま未移植**。

---

## Phase 9（提案）：自動化基盤 ＋ 督促・イベント駆動連携

| # | 機能 | V1所在 | 概要 | 粒度 | 優先 |
|---|---|---|---|---|---|
| 9-0 | **自動化基盤** | （新設） | Cloud Scheduler 起動用エンドポイント群＋認証、Webhook 受信口の土台 | 中 | 高（前提） |
| 9-1 | 毎日 納期アラート | `server.ts:5270 /api/management/daily-checks`→`runDailyChecks()` | 発注/明細の納期を走査し 7/3/1日前・超過は平日毎日 Slack DM＋部署ch通知。`last_alert_at`で重複抑止 | 大 | 高 |
| 9-2 | 契約 自動更新 通告期限アラート | 同 `notifyContractAlert()` (daily-checks step2) | `auto_renewal` 契約の通告期限 `alert_lead_months` 前に Slack 通知（1回制御） | 中 | 高 |
| 9-3 | 契約 満了ステータス自動遷移 | daily-checks step3 | `expiration_date < today` の契約を `expired` へ自動更新 | 小 | 中 |
| 9-4 | 検収待ちダイジェスト | `server.ts:823 /api/management/inspection-digest` | 検収待ち明細を PO 単位に集計し Slack へ定期投稿。V2は読取`/pending-inspections`のみ | 中 | 中 |
| 9-5 | CloudSign Webhook 受信 | `server.ts:1601 /api/webhooks/cloudsign` | 締結/却下 push 受信→`cloudsign_requests`更新＋締結時に契約を`executed`へ自動遷移 | 中 | 高 |
| 9-6 | CloudSign 一括ステータス同期 | `server.ts:669 /api/cloudsign/sync-all` | 未確定リクエストを一括照会し後追い取込（バッチ整合）。V2は1件同期のみ | 小〜中 | 中 |
| 9-7 | Backlog Webhook 自動起票 | `server.ts:2643 /api/webhooks/backlog` | 課題作成イベント→`legal_requests`/`issue_workflows`自動生成（自動インテーク） | 中〜大 | 中 |

## Phase 10（提案）：文書運用オペレーション（発行後の管理）

V2 は draft/finalize/pdf/drive-storage は移植済みだが、**発行後の運用系**が欠落。

| # | 機能 | V1所在 | 概要 | 粒度 | 優先 |
|---|---|---|---|---|---|
| 10-1 | 文書アーカイブ画面＋再発行 | FE `ArchivePage.tsx`／BE `management/assets`・`reissue`・`include_history` | 確定文書の一覧・検索・履歴トグル・再編集/再発行導線 | 中 | 中 | ✅ 実装済（状態フィルタ・PDF未生成キュー・バージョン履歴を DocumentRegistry に集約＋再発行 10-1b＝grant 034・新版採番＋旧版supersede＋実績取消） |
| 10-2 | 文書 void（無効化） | `server.ts:14809 documents/:id/void` | 発行文書の無効化＋実績取消（残高復元） | 小 | 中 | ✅ 実装済（grant 033・`docs/phase10-document-operations.md`） |
| 10-3 | PDF 再生成 | `server.ts:12983 regenerate-pdf` | 確定文書の PDF 再生成（Drive 上書き更新） | 小 | 中 | ✅ 実装済（drive scope 従属・grant不要） |
| 10-4 | 一括削除 / 一括項目更新 | `server.ts:13414 bulk-delete`・`13279 bulk-update-fields` | 発行文書の一括削除・一括フィールド更新 | 中 | 低 | ✅ 一括無効化（bulk void・grant 033 共用）実装済。一括項目更新は将来拡張（form_data 広範 grant 要） |
| 10-5 | Excel 一括出力 | FE `ExcelBatchPage.tsx`／BE `15759 export-excel`・`15908 excel-batches/pending` | 検収書/利用許諾料計算書を担当者×支払期日×種別で集計し Excel 一括生成＋Drive保存 | 大 | 中 | ✅ 実装済（集計＝読取・Excel は client 生成・発行済みは隔離台帳 grant 035。Drive 保存でなく DL） |
| 10-6 | 文書ルックアップ | `by-number/:docNumber`・`pending-pdf`・`:id/ringi-links`・`numbering/next`・`mark-as-imported` | 番号検索・PDF未生成一覧・次番号採番・取込済フラグ | 小 | 低 | ✅ 実装済（by-number/pending-pdf/numbering-next・読取・grant不要。ringi=保留・mark-as-imported=見送り） |

## Phase 11（提案）：設定・マスタ書込

V2 の `AdminOverview` は読み取り専用ステータスのみ。**設定・ルート・マスタの編集系が広く欠落**。

| # | 機能 | V1所在 | 概要 | 粒度 | 優先 |
|---|---|---|---|---|---|
| 11-1 | システム設定（会社プロファイル/アプリ設定） | FE `SettingsPage.tsx`／BE `app-settings` | 会社プロファイル・アプリ設定のタブ編集保存 | 中 | 中 | ✅ 実装済（会社プロファイル allowlist・grant 036・`docs/phase11-settings-master.md`。連携トグル/秘密は対象外＝env管理） |
| 11-2 | 承認ルート/ワークフロールール設定 | FE `master/RulesPanel.tsx`／BE `workflow-settings`・`rules` | 部門ごとの承認者/押印担当/管理者 Slack ID・チャンネル（`workflow_rules`） | 中 | 中 | ✅ 実装済（department_workflow_rules upsert・grant 037・`docs/phase11-settings-master.md`。V2 ルーティング参照は将来配線） |
| 11-3 | 台帳マスタ CRUD 書込 | BE `master/ledgers` POST/PUT/DELETE | V2は`GET /ledgers/:type`読取のみ。作成/更新/削除が無い | 中 | 中 | ✅ 実装済（**過大計上だった**：Create/Update は Phase 2/4/8 で実装済・未有効化。今回 vendor 論理削除〈is_active〉追加。cutover は WRITE_SCOPES 有効化で解禁） |
| 11-4 | 契約マスタ CRUD | BE `master/contracts` POST/PUT/DELETE・`:id/status` | intake とは別の契約レジストリ登録・更新・状態変更 | 中 | 中 | ✅ 実装済（**登録は contract-intake が既存**。今回 既存 contracts の列単位更新・ライフサイクル状態変更＝grant 038・`GET /contracts`／`PATCH /contracts/:id(/status)`・admin/legal・`docs/phase11-settings-master.md`） |
| 11-5 | 原作マテリアル登録ワークフロー | FE `master/MaterialEntryPanel.tsx` | 原作→素材検索起点で新規マテリアル作成/編集/安全削除（金銭条件付帯必須）。V2は素材タブ読取のみ | 中 | 中 | ✅ 実装済（materials write は Phase 4 既存・work_id 必須＝作品スコープ。今回 WorkDetail に原作起点の追加/編集 UX。安全削除＝is_active 列なしで別スライス、金銭条件必須のハード強制は将来） |
| 11-6 | PII同意記録 / 会社プロフィール | BE `master/vendors/:code/pii-consent`・`company-profile` | ベンダーPII取得同意の記録・自社プロフィール取得 | 小 | 低 |
| 11-7 | マスタ横断 bulk-export/import | BE `master/bulk-export`・`bulk-import` | マスタ横断の一括書出/取込（個別importはV2にあり） | 小 | 低 |
| 11-8 | テーマ/スキン切替 | FE `layout/Topbar.tsx`・`lib/skin` | 複数スキン＋ダーク/ライト切替（localStorage永続） | 小 | 低 |
| 11-9 | 稟議マスタ（RingiPanel） | FE `master/RingiPanel.tsx` | 稟議マスタ CRUD＋CSV取込＋文書リンク数。**廃止対象か要確認** | 中 | 要確認 |

## Phase 12（提案）：データ保守・整合（検出→修復）

V2 の `DataQuality` は俯瞰（読取サマリ）のみ。**検出→修復の実行導線**が無い。

| # | 機能 | V1所在 | 概要 | 粒度 | 優先 |
|---|---|---|---|---|---|
| 12-1 | 連結チェック＆修復 | FE `DataLinkagePanel.tsx`／BE `admin/data-linkage/check`・`/repair` | 散在/孤児化した同一発注条件を検出し安全修復（DuplicateFinder同梱） | 中 | 中 |
| 12-2 | 未リンクCL 棚卸し 一括リンク | FE `master/UnlinkedConditionsPanel.tsx` | 素材未リンクの利用許諾CLを横断棚卸し→原作マテリアルへ一括後付けリンク | 中 | 中 |
| 12-3 | 課題整合性監査 | BE `audit/issue-consistency` | 課題整合性の監査（data-qualityとは別系統） | 中 | 低 |
| 12-4 | 管理者バックフィル/再同期バッチ | BE `admin/backfill-*`・`admin/resync-*`・`repair-inspection`・`unify/phase2-dryrun` | データ移行/再同期/修復の管理者バッチ群 | 中 | 低（移行完了後は不要の可能性） |

## Phase 13（提案）：条件明細・課題横断オペ

V2 は condition-lines の一覧/summary/receipts は移植済み。**書込オペと横断ビュー**が欠落。

| # | 機能 | V1所在 | 概要 | 粒度 | 優先 |
|---|---|---|---|---|---|
| 13-1 | 明細オペ（link-document/graph-link/void/delete） | `server.ts:15406〜` | 明細への文書紐付け・グラフリンク・イベント無効化・明細削除・検品ドキュメント | 中 | 低 |
| 13-2 | 課題×文書/条件サマリ | `server.ts:14878 issues/:key/documents`・`condition-line-summary` | 課題単位の紐付き文書一覧・条件明細サマリ | 小 | 低 |
| 13-3 | 統一課題ビュー（unified-issues） | `routes/unifiedIssues.ts` | 1契約を背骨に明細・支払実績・兄弟課題を束ねる導出ビュー | 中 | 低 |
| 13-4 | 明細/作品エイリアス ルックアップ | `line-items/lookup`・`works/:id/aliases` | 明細候補検索・作品別名登録/削除 | 小 | 低 |

## Phase 14（提案）：関連当事者取引（RPT）サブシステム

**V2 に痕跡ゼロの完全独立サブシステム。ボリューム大。**

| # | 機能 | V1所在 | 概要 | 粒度 | 優先 |
|---|---|---|---|---|---|
| 14-1 | RPT 法人/株主/役員/議案 | `routes/relatedParty.ts`（`/rpt/entities`ほか）＋GAS `RPT.gs` | 関連当事者の法人・株主構成・役員・取締役会議案(board_resolution)の登録/承認 | 大 | 要判断（利用実態次第） |

## Phase 15（提案）：テンプレート編集・取込・Drive健全性

| # | 機能 | V1所在 | 概要 | 粒度 | 優先 |
|---|---|---|---|---|---|
| 15-1 | テンプレート本体編集/サンプルPDF | BE `templates/:type` POST/DELETE・`preview`・`sample.pdf`・`config/metadata` | テンプレ編集・サンプル描画・config metadata書込。V2は読取＋schema/compatのみ | 中 | 低 |
| 15-2 | 取込キュー各種 | BE `imports/bulk/inspection`・`imports/service-master`・`routes/genericImport.ts` | 検品CSV一括・サービスマスタ取込・汎用テーブル取込 | 中 | 低 |
| 15-3 | Drive ファイル健全性 | BE `drive/file-health`・`drive/verify-files` | Drive上ファイルの存在/整合性チェック | 小 | 低 |
| 15-4 | CloudSign 履歴/ルーティング/バンドル送信 | BE `cloudsign/history/:docNumber`・`contracts/:id/cloudsign(+route+send)`・`send-bundle` | 送信履歴・契約単位ルーティング・課題バンドル送信 | 中 | 低 |
| 15-5 | Backlog ステータス書込 | BE `PATCH backlog/issues/:key/status` | システム→Backlog へ属性/ステータス同期（コメント書戻しとは別） | 小 | 低 |

---

## Phase 16（確定）：載せ替え必須の未追跡ギャップ（2026-08-10 トリアージ）

`cutover-readiness-audit.md` の P2（台帳外の移植漏れ 23 件）を業務トリアージした結果。
**U1 は載せ替え必須と決定**（2026-08-10・発注者確認済み）。

| # | 機能 | 由来 | 判断 | 粒度 |
|---|---|---|---|---|
| 16-1 | スニペットのサーバ共有化（text_snippets 表・カテゴリ・全社共有） | U17 | 移植する（localStorage 退化の解消） | 小 |
| 16-2 | 契約チェック API（用途マスタ×スコープ判定） | U2 | 移植する | 中 |
| 16-3 | **Slack スラッシュコマンド/インタラクティビティ受信口＋法務依頼インテーク** | U1+U20 | ✅ 16-3a 実装済（受信口＋/法務依頼・grant 044・`phase16-cutover-gaps.md`）。16-3b=明細行/紐付け/納期変更/法務検索 | 大 |
| 16-4 | 添付ファイルアップロード（multipart 基盤＋案件/依頼添付） | U6 | 移植する | 中 |

**載せ替え後でよい（B 群・台帳の既存 Phase に留置）**：U7 納期変更／U8 Backlog 課題オペ／U11 DQ トリアージ書込／
U12 支払ZIP・検収担当一括割当／U13 支払対象契約一覧／U16 条件 auto-link／U21 mark-primary ほか／9-7 自動起票
— V1 併走中は V1 側で運用可能。

**廃止候補（C 群・要確認のまま保留）**：U3/U4/U5 非アプリユーザー向けポータル一式（署名URL 運用の継続可否・未回答）／
U9 LegalOn 取込（実利用の有無・未回答）／U10 vendor オーファン（品質＋名寄せで代替）／U14/U15 作品モデル派生／
U19 納品イベント／U22 E2E（移植でなく新規整備で判断）。Phase 14 RPT も実利用確認待ちを継続。

## 推奨トリアージ順

1. **Phase 9（自動化基盤＋督促/Webhook）** — 業務の督促自動化と外部イベント連携の回復。V2の最大の機能的退化。土台（9-0）を先に。
2. **Phase 10（文書運用オペ）** — 発行後の void/再発行/アーカイブ/Excel一括は現場運用で必須度が高い。
3. **Phase 11（設定・マスタ書込）** — ✅ Tier 1 完了（11-1 設定／11-2 承認ルート／11-3 台帳マスタ／11-4 契約マスタ／11-5 マテリアル）。残 11-6〜11-9 は優先低・Ringi 保留。運用自立の主要導線が揃った。
4. **Phase 12（データ保守）** — 検出だけの現状から修復まで。移行安定後の優先。
5. **Phase 13/15（明細オペ・テンプレ編集・小物）** — 個別必要性でトリアージ。
6. **Phase 14（RPT）** — 独立・大。実利用の有無を確認してから着手判断。

> 各項目は自動監査ベース。廃止/不要の判断（例：Ringi・admin バックフィル）が混在するため、着手前に業務側と 1 パスのトリアージを推奨。
