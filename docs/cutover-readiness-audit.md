# 載せ替え前 総点検（2026-08-10）

Phase 11 Tier 1 完了時点で、**①V1移植漏れ／②UI・UX合理性／③DBスキーマ矛盾** の3観点を並列監査した結果。
本開発の肝（V1以上の機能・UI/UXの合理性と視認性・DBスキーマ矛盾の解消）に照らしてトリアージした。
V1 = `/workspace/legalbridge_ai_gcp`（migrations 0001〜0164 を正とする）。

> 監査で ✅ 済み項目のスポットチェックも実施：10-1〜10-5・11-1〜11-5・9-0〜9-6 は実在確認 CONFIRM。
> 例外は本文（P0-8 台帳作品編集バグ、9-7 の記載乖離、10-6 の UI 未配線）。

---

## 🚨 即時緩和（コード修正より先に・デプロイ設定で）

**`DOCUMENT_REISSUE_ENABLED=false` に戻し、`_WRITE_SCOPES` から `document-reissue` を外すこと。**
理由：P0-1（再発行が消化実績を消滅させる）。現行デプロイでは再発行が有効化済みのため、
本番文書を1件でも再発行すると支払済み発注が「全額未消化」に戻る（二重払いリスク）。修正が入るまで停止。

---

## P0：載せ替え前必修（実データ破壊・機能不全）

### P0-1. 再発行のセマンティクスが V1 と正反対（残高消滅）〔最重大〕
- V1: `services/worker/server.ts:16969`「void ではなく付け替えなので残高は不変」— 有効イベントを新版へ **repoint**
  （`reissueCarryover.ts` は condition_line_id も付替え）。
- V2: `document-reissue-repository.ts:102` — 旧版イベントを **一括 void**、新実績は作らない。
- 帰結: 消化済み発注の再発行で `condition_line_status_v` の consumed が 0 に戻る（二重払い露出）。さらに
  V1 横断検索（`server.ts:15088`）は「非void イベントが存在する行のみ表示」のため、**条件明細が V1 から消える**。
- 対処: V1 方式（イベント repoint）へ改修。可視性フィルタとの整合まで含めて再設計（新版の行・イベント帰属）。

### P0-2. `vendors.is_active` が V1 スキーマに存在しない
- V1 の全 164 migration に `vendors` への `is_active` 追加が無い（`is_active` は source_ips/works/documents 等のみ）。
  V1 サーバコードにも vendors.is_active 参照なし。
- V2 は `vendors/write-repository.ts:54,132` と `merge-repository.ts:104` が参照 → 本番初回実行で **42703**（未翻訳→500）。
  幸い `vendors`/`vendor-merge` スコープは未点火のため事故は未発生。
- 対処: **grant 039 系で `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`**
  ＋preflight は `information_schema.columns` で列存在を確認（038 が唯一やっている方式を標準化）。

### P0-3. V2 作成文書の `contract_status` が NULL → 状態機械が永遠に発火しない
- V1 は保存時に必ず既定 `'executed'` を刻む（`documentSave.ts:298`）。列に DB default は無い。
- V2 の `finalization-repository.ts:42` / `document-reissue-repository.ts:79` は `contract_status` を書かない。
- 帰結: CloudSign「executed 遷移」（`contract-status-writer.ts:20` の IN ('draft','awaiting_signature')）も
  満了ジョブ（`daily-checks-repository.ts:28`）も V2 作成文書に一切マッチしない。V1 UI では 確認中/終了 の誤表示。
- 対処: finalize/reissue の INSERT に `contract_status` を設定（V1 既定に合わせ 'executed'。CloudSign 送信フローを
  作る際に 'awaiting_signature' を導入）。既存 V2 作成分のバックフィル SQL も用意。

### P0-4. 再発行の新版が業務列空 → V1 トリガが不完全 contracts 行を捏造
- V2 reissue/finalize の INSERT は 8〜10 列のみ。`vendor_id/record_type/contract_category/contract_title/
  effective_date/expiration_date` 等（0101 で documents に統合された capability 列）を書かない。
- `tg_doc_autolink_contract`（0129:83）が BEFORE INSERT で発火し、`contract_level='standalone'`・状態 NULL の
  contracts 行を生成。しかも V2 契約マスタは `COALESCE(executed_at, requested_at, now()) DESC` 順のため
  **その捏造行が一覧の先頭に並ぶ**。
- 対処: reissue は旧版から業務列を丸ごとコピー。finalize は form_data から主要列をマップ（最低限 vendor_id・
  contract_title・template 由来の record_type）。

### P0-5. void が legacy 行（lifecycle_status NULL）で「半分だけ」成功する
- V2 `document-void-repository.ts:102` の `WHERE ... lifecycle_status <> 'voided'` は NULL 行で 0 件更新。
  だが直前チェックは通過するため、**イベント void と監査台帳だけ書いて COMMIT** する（文書は生きたまま実績消滅）。
- V1 の void は無述語（`server.ts:14830`）。本番に lifecycle_status NULL は実在（preflight 033 で 1 件確認済み）。
- 対処: `lifecycle_status IS DISTINCT FROM 'voided'` に変更＋rowCount=0 なら ROLLBACK。

### P0-6. GRANT 列漏れ 2 件（サイレント恒久故障／未翻訳500）
- `documents.updated_at`: `contract-status-writer.ts:18` と `daily-checks-repository.ts:153` が SET するが
  どの grant にも無い → 42501 が「grant 未適用」と同じ見え方で **恒久 forbidden 誤報**（CloudSign executed 遷移・
  満了ジョブが grant 適用後も動かない）。
- `documents.drive_link`: `registry-repository.ts:94` の UPDATE に grant 無し → Drive 添付が未翻訳 42501 → 500。
- 対処: grant 039 に `GRANT UPDATE (updated_at, drive_link) ON documents` を追加。

### P0-7. 契約マスタ setStatus が legacy 列を V2 語彙で汚染（11-4 実装の自己バグ）
- V1 の正準: `lifecycle_stage` が正・`contract_status` は文書レベル語彙（draft/awaiting_signature/executed/
  expired/terminated）の legacy 互換（0005:56、0129:59 のマッピング参照）。
- V2 `contract-master-repository.ts:113` は両列に同値を書くため、`requested/drafting/reviewing/on_hold/cancelled`
  という V1 に無い値が contract_status に入る。逆に V1 トリガは lifecycle_stage に draft 等を素通しし、
  V2 enum 外の値が来る。
- 対処: setStatus は **lifecycle_stage のみ更新**（contract_status は触らない。V1 も contracts.contract_status を
  読まないことを確認済み）。UI は enum 外の stage 値を素通し表示（現状フォールバックあり・維持）。

### P0-8. 台帳画面の作品「編集」が常に失敗（11-3 の半分が不動作）
- `ledgers/repository.ts:89` が works 行の id を `work:12`/`source_ip:34` 形式で返し、
  `LedgerWorkspace.tsx:94` が `Number("work:12")`=NaN → `/api/v2/works/NaN` で常に取得失敗。
- 対処: `work:` プレフィックスを剥がして数値化・`source_ip:` 行は編集ボタン非表示（source_ips は書込経路自体が
  未実装＝U14）。

### P0-9. 契約マスタの状態セレクトが無ガードで即時 PATCH（UX 自己違反）
- `ContractMasterWorkspace.tsx:155` — select 変更で即本番更新。満了/解約/中止は UX レビュー R4 の T3
  （プレビュー＋確認必須）該当。フィルタに見える誤アフォーダンスも併発。
- 対処: 選択→「変更内容（現→新）」確認バナー→確定ボタンの2段階に。expired/terminated/cancelled は確認必須。

### P0-10. matter-delete の影響列挙漏れ＋孤児行
- V1 の子テーブルのうち `matter_slack_threads`（CASCADE）と `document_files`（SET NULL）が
  `matter-delete-repository.ts:28` の IMPACTS に無い → 破壊確認画面が過少申告。
  さらに `lb_v2_matter_slack_threads`（FK 無し）が削除後に孤児化し、matter_id 再利用時にスレッド作成を恒久ブロック。
- 対処: IMPACTS に 2 表を追加＋削除トランザクションで lb_v2 行も削除。

### P0-11. 会社プロファイルのキー不一致（11-1 が V1 に届いていない）
- V1 が読むのは `COMPANY_INVOICE_NO`（`sharedReads.ts:230,239`）。V2 allowlist は `COMPANY_REGISTRATION_NUMBER`。
- 対処: allowlist のキーを `COMPANY_INVOICE_NO` に改名（UI ラベルは適格請求書番号のまま）。
  ※V2 自身の帳票が app_settings を未参照（`master-data/repository.ts:141` はハードコード）なのは既知の将来配線。

## P1：載せ替え前に強く推奨（誤動作・視認性・整合）

| # | 内容 | 根拠 |
|---|---|---|
| P1-1 | registry の「有効」フィルタが voided 除外のみ（V1 は reissued/superseded も除外） | `registry-repository.ts:50` vs V1 `server.ts:15076` |
| P1-2 | 検収ワークリストが lifecycle/is_primary を見ない（void 済み発注が検収待ちに出る） | `inspections/repository.ts:29` |
| P1-3 | vendor-merge が `documents.vendor_id` を付替えない（8表中に無い） | `merge-repository.ts:11` vs 0101:36 |
| P1-4 | V2 のベンダーピッカー/台帳/検索が is_active を無視（自分で無効化した取引先が選べる） | `master-data/repository.ts:31` ほか |
| P1-5 | reissue の is_primary 降格が系列全体（V1 は template_type 別に正本選定） | `document-reissue-repository.ts:91` vs `server.ts:3379` |
| P1-6 | ExcelBatch だけ FeatureLockedNote 不採用（無効時ボタンが黙って消える） | `ExcelBatchWorkspace.tsx:91` |
| P1-7 | WorkDetail の private な Degraded() 重複（FeatureLockedNote へ統一） | `WorkDetail.tsx:35` |
| P1-8 | 内部識別子の end-user 露出（DataQuality「GRANT」、WorkDetail parent_work_id/work_relations、Requests「3-2b」） | `DataQuality.tsx:68` ほか |
| P1-9 | 新テーブル2画面の偽クリック行（registry-table の cursor:pointer 継承） | WorkflowRules/ContractMaster |
| P1-10 | WorkDetail の「読み取り専用」表記が虚偽（編集導線多数） | `WorkDetail.tsx:263` |
| P1-11 | bulk void に影響説明が無い（単票にはある） | `DocumentRegistry.tsx:351` |
| P1-12 | 空状態の第3流派（hub-note 流用）／バッジ語彙の逸脱（有効無効に voided 色・カテゴリに complete 色・契約マスタは無バッジ）／取消ボタン語彙3種 | 新4画面 |
| P1-13 | マスタ・設定グループが admin 12 項目（F1 過積載の移住）。「マスタ」「設定・運用」分割か契約マスタ↔契約取込 surface-xref | `App.tsx:97` |
| P1-14 | WorkDetail 派生元IDが生入力（同画面に作品ピッカー既存） | `WorkDetail.tsx:375` |
| P1-15 | lb_v2_* の append-only 検証 SQL 不足（033/034/035/030/032 に UPDATE revoke 検証が無い）・actor 列規約の揺れ | infra/gcp/sql |
| P1-16 | `TZ` を Cloud Run に設定すると日付が全て1日ずれる脆さ（DATE→toISOString UTC 前提）。**TZ 未設定を運用ルール化** | `contract-master-repository.ts:40` ほか |
| P1-17 | document-lookup の by-number / numbering-next に UI 消費者が無い（10-6 の配線残） | `document-lookup-routes.ts` |
| P1-18 | condition_events.event_no 採番が競合時 23505 頼み（許容範囲だが把握） | `event-repository.ts:70` |

## P2：台帳追記＝未追跡の移植漏れ（23件・業務判断つき）

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

1. **S-A 緊急止血**：即時緩和（reissue OFF）＋ P0-5 void 述語 ＋ P0-8 台帳編集バグ ＋ P0-7 setStatus ＋ P0-9 状態確認 UI ＋ P0-11 設定キー（小粒・即日）
2. **S-B grant 039**：P0-2 vendors.is_active 列追加 ＋ P0-6 updated_at/drive_link GRANT ＋ P1-15 検証 SQL（SQL のみ）
3. **S-C 文書ライフサイクル整合**：P0-3 contract_status 刻印＋バックフィル ＋ P0-4 業務列コピー ＋ P1-1/P1-2/P1-5
4. **S-D 再発行再設計**：P0-1 イベント repoint 方式へ（V1 reissueCarryover 準拠）— 完了までスコープ点火禁止
5. **S-E 案件削除整合**：P0-10
6. **S-F UX 一括**：P1-6〜P1-14
7. **P2 は業務トリアージ後に台帳へ正式行を起こして通常スライス化**
