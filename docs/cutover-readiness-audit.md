# 載せ替え前 総点検（2026-08-10）

Phase 11 Tier 1 完了時点で、**①V1移植漏れ／②UI・UX合理性／③DBスキーマ矛盾** の3観点を並列監査した結果。
本開発の肝（V1以上の機能・UI/UXの合理性と視認性・DBスキーマ矛盾の解消）に照らしてトリアージした。
V1 = `/workspace/legalbridge_ai_gcp`（migrations 0001〜0164 を正とする）。

> 監査で ✅ 済み項目のスポットチェックも実施：10-1〜10-5・11-1〜11-5・9-0〜9-6 は実在確認 CONFIRM。
> 例外は本文（P0-8 台帳作品編集バグ、9-7 の記載乖離、10-6 の UI 未配線）。

---

## ✅ 本番反映 完了（2026-08-10）

S-A〜S-F のコード（build 82aa5b31…）と grant 032/034/035/036/037/038/039/040/041/042 を本番適用済み。
- 適用時の発見：**032/034/035（webhook 受信・再発行・Excel出力の lb_v2 台帳）が Phase 9/10 デプロイ時に未適用のまま**
  スコープだけ点火されていた（テーブル不存在）。今回作成し、039 の追記専用 REVOKE も再適用で宣言済み。
- preflight 041：旧方式（void）で再発行された実績は 0 件＝リカバリ不要。040 バックフィル対象も 0 件
  （V2 finalize は本番未使用・以後は新コードが最初から刻む）。
- 現在の有効スコープ：drafts,documents,pdf,slack-approvals,matters,matter-merge,matter-delete,document-void,
  document-reissue,excel-batch,settings,workflow-rules,contract-master,slack,slack-dispatch,matter-slack

---

## P0：載せ替え前必修（実データ破壊・機能不全）

### P0-1. 再発行のセマンティクスが V1 と正反対（残高消滅）〔最重大〕✅ S-D 修正済み・デプロイ＋041 適用済み（旧方式の void 実績 0 件＝リカバリ不要）
- V1: `services/worker/server.ts:16969`「void ではなく付け替えなので残高は不変」— 有効イベントを新版へ **repoint**
  （`reissueCarryover.ts` は condition_line_id も付替え）。
- V2: `document-reissue-repository.ts:102` — 旧版イベントを **一括 void**、新実績は作らない。
- 帰結: 消化済み発注の再発行で `condition_line_status_v` の consumed が 0 に戻る（二重払い露出）。さらに
  V1 横断検索（`server.ts:15088`）は「非void イベントが存在する行のみ表示」のため、**条件明細が V1 から消える**。
- 対処: V1 方式（イベント repoint）へ改修。可視性フィルタとの整合まで含めて再設計（新版の行・イベント帰属）。

### P0-2. `vendors.is_active` が V1 スキーマに存在しない ✅ S-B（grant 039）本番適用済み（2026-08-10）
- V1 の全 164 migration に `vendors` への `is_active` 追加が無い（`is_active` は source_ips/works/documents 等のみ）。
  V1 サーバコードにも vendors.is_active 参照なし。
- V2 は `vendors/write-repository.ts:54,132` と `merge-repository.ts:104` が参照 → 本番初回実行で **42703**（未翻訳→500）。
  幸い `vendors`/`vendor-merge` スコープは未点火のため事故は未発生。
- 対処: **grant 039 系で `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`**
  ＋preflight は `information_schema.columns` で列存在を確認（038 が唯一やっている方式を標準化）。

### P0-3. V2 作成文書の `contract_status` が NULL → 状態機械が永遠に発火しない ✅ S-C 修正済み・040 適用済み（対象0件＝V2 finalize 本番未使用のため）
- V1 は保存時に必ず既定 `'executed'` を刻む（`documentSave.ts:298`）。列に DB default は無い。
- V2 の `finalization-repository.ts:42` / `document-reissue-repository.ts:79` は `contract_status` を書かない。
- 帰結: CloudSign「executed 遷移」（`contract-status-writer.ts:20` の IN ('draft','awaiting_signature')）も
  満了ジョブ（`daily-checks-repository.ts:28`）も V2 作成文書に一切マッチしない。V1 UI では 確認中/終了 の誤表示。
- 対処: finalize/reissue の INSERT に `contract_status` を設定（V1 既定に合わせ 'executed'。CloudSign 送信フローを
  作る際に 'awaiting_signature' を導入）。既存 V2 作成分のバックフィル SQL も用意。

### P0-4. 再発行の新版が業務列空 → V1 トリガが不完全 contracts 行を捏造 ✅ S-C で修正済み
- V2 reissue/finalize の INSERT は 8〜10 列のみ。`vendor_id/record_type/contract_category/contract_title/
  effective_date/expiration_date` 等（0101 で documents に統合された capability 列）を書かない。
- `tg_doc_autolink_contract`（0129:83）が BEFORE INSERT で発火し、`contract_level='standalone'`・状態 NULL の
  contracts 行を生成。しかも V2 契約マスタは `COALESCE(executed_at, requested_at, now()) DESC` 順のため
  **その捏造行が一覧の先頭に並ぶ**。
- 対処: reissue は旧版から業務列を丸ごとコピー。finalize は form_data から主要列をマップ（最低限 vendor_id・
  contract_title・template 由来の record_type）。

### P0-5. void が legacy 行（lifecycle_status NULL）で「半分だけ」成功する ✅ S-A で修正済み
- V2 `document-void-repository.ts:102` の `WHERE ... lifecycle_status <> 'voided'` は NULL 行で 0 件更新。
  だが直前チェックは通過するため、**イベント void と監査台帳だけ書いて COMMIT** する（文書は生きたまま実績消滅）。
- V1 の void は無述語（`server.ts:14830`）。本番に lifecycle_status NULL は実在（preflight 033 で 1 件確認済み）。
- 対処: `lifecycle_status IS DISTINCT FROM 'voided'` に変更＋rowCount=0 なら ROLLBACK。

### P0-6. GRANT 列漏れ 2 件（サイレント恒久故障／未翻訳500）✅ S-B（grant 039）本番適用済み（2026-08-10）
- `documents.updated_at`: `contract-status-writer.ts:18` と `daily-checks-repository.ts:153` が SET するが
  どの grant にも無い → 42501 が「grant 未適用」と同じ見え方で **恒久 forbidden 誤報**（CloudSign executed 遷移・
  満了ジョブが grant 適用後も動かない）。
- `documents.drive_link`: `registry-repository.ts:94` の UPDATE に grant 無し → Drive 添付が未翻訳 42501 → 500。
- 対処: grant 039 に `GRANT UPDATE (updated_at, drive_link) ON documents` を追加。

### P0-7. 契約マスタ setStatus が legacy 列を V2 語彙で汚染（11-4 実装の自己バグ）✅ S-A で修正済み
- V1 の正準: `lifecycle_stage` が正・`contract_status` は文書レベル語彙（draft/awaiting_signature/executed/
  expired/terminated）の legacy 互換（0005:56、0129:59 のマッピング参照）。
- V2 `contract-master-repository.ts:113` は両列に同値を書くため、`requested/drafting/reviewing/on_hold/cancelled`
  という V1 に無い値が contract_status に入る。逆に V1 トリガは lifecycle_stage に draft 等を素通しし、
  V2 enum 外の値が来る。
- 対処: setStatus は **lifecycle_stage のみ更新**（contract_status は触らない。V1 も contracts.contract_status を
  読まないことを確認済み）。UI は enum 外の stage 値を素通し表示（現状フォールバックあり・維持）。

### P0-8. 台帳画面の作品「編集」が常に失敗（11-3 の半分が不動作）✅ S-A で修正済み
- `ledgers/repository.ts:89` が works 行の id を `work:12`/`source_ip:34` 形式で返し、
  `LedgerWorkspace.tsx:94` が `Number("work:12")`=NaN → `/api/v2/works/NaN` で常に取得失敗。
- 対処: `work:` プレフィックスを剥がして数値化・`source_ip:` 行は編集ボタン非表示（source_ips は書込経路自体が
  未実装＝U14）。

### P0-9. 契約マスタの状態セレクトが無ガードで即時 PATCH（UX 自己違反）✅ S-A で修正済み
- `ContractMasterWorkspace.tsx:155` — select 変更で即本番更新。満了/解約/中止は UX レビュー R4 の T3
  （プレビュー＋確認必須）該当。フィルタに見える誤アフォーダンスも併発。
- 対処: 選択→「変更内容（現→新）」確認バナー→確定ボタンの2段階に。expired/terminated/cancelled は確認必須。

### P0-10. matter-delete の影響列挙漏れ＋孤児行 ✅ S-E 修正済み・grant 042 適用済み（孤児 0 件）
- V1 の子テーブルのうち `matter_slack_threads`（CASCADE）と `document_files`（SET NULL）が
  `matter-delete-repository.ts:28` の IMPACTS に無い → 破壊確認画面が過少申告。
  さらに `lb_v2_matter_slack_threads`（FK 無し）が削除後に孤児化し、matter_id 再利用時にスレッド作成を恒久ブロック。
- 対処: IMPACTS に 2 表を追加＋削除トランザクションで lb_v2 行も削除。

### P0-11. 会社プロファイルのキー不一致（11-1 が V1 に届いていない）✅ S-A で修正済み
- V1 が読むのは `COMPANY_INVOICE_NO`（`sharedReads.ts:230,239`）。V2 allowlist は `COMPANY_REGISTRATION_NUMBER`。
- 対処: allowlist のキーを `COMPANY_INVOICE_NO` に改名（UI ラベルは適格請求書番号のまま）。
  ※V2 自身の帳票が app_settings を未参照（`master-data/repository.ts:141` はハードコード）なのは既知の将来配線。

## P1：載せ替え前に強く推奨（誤動作・視認性・整合）

| # | 内容 | 根拠 |
|---|---|---|
| P1-1 | ✅ S-C: 「有効」は voided/reissued/superseded を除外（V1 横断検索と同義に） | registry-repository.ts |
| P1-2 | ✅ S-C: 発注は現行版＋正本のみ・検収書 EXISTS は voided 除外 | inspections/repository.ts |
| P1-3 | ✅ vendor スライス: VENDOR_REFERENCES に documents.vendor_id を追加（grant 043 は vendor-merge 点火時に適用） | merge-repository.ts／043_…grants.sql |
| P1-4 | ✅ vendor スライス: ピッカー/横断検索は is_active のみ・台帳は全件＋【無効】表示＋状態欄（再有効化の導線維持） | master-data/search/ledgers repository |
| P1-5 | ✅ S-C: 降格を template_type 単位に限定（V1 の正本選定と同義） | document-reissue-repository.ts |
| P1-6 | ✅ S-F: FeatureLockedNote 追加（出力は可・記録のみ未有効の旨） | ExcelBatchWorkspace.tsx |
| P1-7 | ✅ S-F: Degraded() の中身を FeatureLockedNote に統一 | WorkDetail.tsx |
| P1-8 | ✅ S-F: GRANT/parent_work_id/work_relations/3-2b/ナビ説明の GRANT を平易な文言へ | DataQuality/WorkDetail/Requests/App |
| P1-9 | ✅ S-F: `.registry-table.static-rows` で cursor/hover を打ち消し | styles.css＋両画面 |
| P1-10 | ✅ S-F: サブタイトルを「一望・編集します」に修正 | WorkDetail.tsx |
| P1-11 | ✅ S-F: 確認段に影響説明（実績取消・残高復元・不可逆）を追加 | DocumentRegistry.tsx |
| P1-12 | ✅ S-F: 空状態を EmptyState に統一・`registry-state.neutral` 新設（無効/カテゴリ）・契約マスタに状態バッジ・キャンセル語彙統一（やめる/取消→キャンセル） | 新4画面＋styles.css |
| P1-13 | ✅ S-F: マスタ(5)／データ整備(3)／設定・運用(4) に3分割＋契約マスタ→契約取込 surface-xref | App.tsx／ContractMasterWorkspace |
| P1-14 | ✅ S-F: 派生元は検索ピッカーで選択（生ID入力・ハードコード色の inline style も除去） | WorkDetail.tsx |
| P1-15 | ✅ S-B: 039 が実在する台帳へ UPDATE/DELETE/TRUNCATE を明示 REVOKE＋事後検証（actor 列規約の揺れは据え置き） | 039_production_cutover_fixes_grants.sql |
| P1-16 | `TZ` を Cloud Run に設定すると日付が全て1日ずれる脆さ（DATE→toISOString UTC 前提）。**TZ 未設定を運用ルール化** | `contract-master-repository.ts:40` ほか |
| P1-17 | document-lookup の by-number / numbering-next に UI 消費者が無い（10-6 の配線残） | `document-lookup-routes.ts` |
| P1-18 | condition_events.event_no 採番が競合時 23505 頼み（許容範囲だが把握） | `event-repository.ts:70` |

## P2：台帳追記＝未追跡の移植漏れ（23件）✅ トリアージ済み（2026-08-10）

**結果は `v1-v2-gap-remaining.md` の Phase 16 に正式収載**：A 群（移植する）= U17/U2/**U1+U20（必須・確定）**/U6 →
16-1〜16-4。B 群（載せ替え後）= 既存 Phase に留置。C 群（廃止候補）= U3/4/5・U9・U10・U14/15・U19・U22（要確認のまま保留）。
以下は監査時の原文。

## P2 原文：台帳追記＝未追跡の移植漏れ（23件・業務判断つき）

自動監査の台帳（Phase 9〜15）に**行が無かった** V1 機能。詳細な V1 所在は監査ログ参照。cutover 範囲の判断が要る。

**判断必須（V1 の主要導線）**
- **U1 Slack スラッシュコマンド/インタラクティビティ受信口**（法務依頼インテーク・法務検索。V1 の依頼起点そのもの）
- **U20 依頼インテーク API**（intake/create 系。V2 の contract-intake は別物）
- U2 契約チェック（用途マスタ×スコープ判定 API。V2 の contract-check は条件整合チェックで別物）
- U6 添付アップロード（V2 に multipart 処理が皆無）
- U3/U4/U5 非アプリユーザー向けポータル（ガイドCMS・許可リスト・署名URL基盤）— **廃止可否の判断が先**

**中優先（運用で効く）**
- U7 納期変更申請ワークフロー／U8 Backlog 課題オペ（quick-create/名寄せ/終了/自動連鎖）／U11 DQ Issue トリアージ書込
  ／U12 支払 Excel/ZIP＋検収担当一括割当／U13 支払対象契約一覧／U16 条件 auto-link・auto-status・CSV
  ／U21 mark-primary・regenerate-and-complete・検収プレビュー／9-7 Backlog Webhook 自動起票（現状は受信記録＋Slack通知のみ）

**低優先・要判断**
- U9 LegalOn CSV／U10 vendor オーファン棚卸し・一括削除／U14 原作IP(source_ips) 書込一式／U15 作品モデル派生
  （rights-tree/graph/products CRUD/license-matrix 等）／U17 スニペットのサーバ共有（V2 は localStorage 退化）
  ／U18 マスタ付随書込／U19 納品イベント／U22 E2E テスト基盤（V2 に Playwright 無し）

## 問題なし（監査で確認済みのクリーン領域）

- `condition_events.voided_at` フィルタ：V2 の全 read 箇所（3箇所）で適用済み。V1 の残高ビューと同一思想。
- void 本体フロー（P0-5 の NULL 述語以外）は V1 と完全一致。
- `department_workflow_rules` / `app_settings` 書式 / `staff` / `document_sends` / matters 状態語彙：V1 と整合。
- 033/034/026/028/018/038 の列 GRANT は実 UPDATE 文と一致（038 preflight の列存在確認は良型・他へ展開推奨）。
- works/source_ips の is_active read フィルタは全経路一貫。
- V1 の `lb_sync_contracts` ミラートリガは 0130 で廃止済み＝V2 の contracts 書込が巻き戻される事故は無い。
- intake の `lifecycle_stage='executed'`＋`contract_status='executed'` は V1 マッピングの恒等点で正しい。

## 修正スライス案（推奨順）

1. **S-A 緊急止血** ✅ 完了（2026-08-10）：P0-5 void 述語（IS DISTINCT FROM＋rowCount 検査）／P0-7 setStatus は lifecycle_stage のみ／P0-8 work: プレフィックス解析＋source_ip 行は編集非表示／P0-9 状態変更を2段階確認（破壊的遷移は警告付き）／P0-11 キーを COMPANY_INVOICE_NO に統一。即時緩和（reissue OFF）はデプロイ側の操作（下記）
2. **S-B grant 039** ✅ SQL 整備済（2026-08-10・本番適用待ち）：P0-2 列追加＋P0-6 列 GRANT＋P1-15 追記専用 REVOKE＋事後検証。点火：
   ```bash
   psql "" -f infra/gcp/sql/039_production_cutover_fixes_preflight.sql || true
   psql "" -v confirm_cutover_fixes=GRANT_PRODUCTION_CUTOVER_FIXES \
     -f infra/gcp/sql/039_production_cutover_fixes_grants.sql
   ```
3. **S-C 文書ライフサイクル整合** ✅ 完了（2026-08-10）：finalize が record_type（V1 分岐準拠の純関数）・contract_status='executed'・contract_title・vendor_id（相手先名から解決）を刻む／reissue は旧版の業務列23列を INSERT..SELECT で丸ごと継承＋COALESCE(contract_status,'executed')／is_primary 降格は template_type 単位／registry「有効」= voided/reissued/superseded 除外／検収ワークリスト lifecycle+is_primary 整合。既存 V2 作成分の是正は 040 バックフィル（V2 判定 = template_version_id IS NOT NULL・V1 は書かない列）：
   ```bash
   psql "" -f infra/gcp/sql/040_production_document_status_backfill_preflight.sql || true
   psql "" -v confirm_document_backfill=BACKFILL_PRODUCTION_DOCUMENT_STATUS \
     -f infra/gcp/sql/040_production_document_status_backfill.sql
   ```
4. **S-D 再発行再設計** ✅ 完了（2026-08-10）：condition_events.document_id を系列旧版→新版へ付け替え（voided_at には触れない＝残高不変）。condition_line_id は旧版明細のまま（V1 の明細付替えは新版に明細を再作成する場合のみの処理で V2 は対象が生じない）。台帳列 canceled_events→carried_events。点火は上記手順
5. **S-E 案件削除整合** ✅ 完了（2026-08-10）：影響列挙に matter_slack_threads（連鎖）・document_files（解除）・lb_v2_matter_slack_threads（明示削除）を追加。件数は SAVEPOINT で権限未付与でも degrade（削除は止めない）。lb_v2 行は削除トランザクション内で明示 DELETE（grant 042 未適用なら skip・孤児は 042 適用時に一掃）。点火：
   ```bash
   psql "" -f infra/gcp/sql/042_production_matter_delete_integrity_preflight.sql || true
   psql "" -v confirm_matter_delete_integrity=GRANT_PRODUCTION_MATTER_DELETE_INTEGRITY \
     -f infra/gcp/sql/042_production_matter_delete_integrity_grants.sql
   ```
6. **S-F UX 一括** ✅ 完了（2026-08-10）：P1-6〜P1-14 全件（上表）。残る P1 は P1-3/P1-4（vendor 整合・別スライス）と P1-16/P1-17/P1-18（運用ルール・配線残・許容）
7. **P2 は業務トリアージ後に台帳へ正式行を起こして通常スライス化**
