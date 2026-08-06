# Phase 6：残機能・運用 — 計画と棚卸し

パリティ表（`docs/v1-v2-parity-checklist.md` Gブロック等）の残❌を「移植 or 廃止確定」にする。Phase 1〜5と同じ原則：**読取/クライアント先行**、**共有本番DBのDDLなし**（新規テーブルは判断ポイント）、**追加のみ・no-DELETE中心**。

## 1. スライス分類（依存の軽い順・棚卸し済）

| # | 機能 | 依存ゼロ実装 | 新規テーブル/GRANT | 状態 |
|---|---|---|---|---|
| **6-1** | Excel/CSV一覧出力（未発行/検収/許諾/請求/支払） | 共通 `export-util.ts` を各一覧に配線 | 不要（既存GETの読取） | ✅ |
| **6-2** | 運用ガイド/管理ポータル | 静的クライアントビュー | 不要 | ✅ |
| **6-3** | テキストスニペット | クライアント `localStorage` | 不要（共有化する場合のみ要判断） | ✅ |
| 6-4 | アーカイブ | 既存 `matters.status='archived'`／`is_active=false` 流用 | 不要（`archived_at` 監査列が要る場合はDDL判断） | 未 |
| 6-5 | 契約チェック | 計算専用ルート（`/royalty/preview`型・保存なし） | 不要（結果保存する場合は要判断） | 未 |
| 6-6 | 稟議(Ringi) | — | **要新規テーブル＋GRANT＋write-gate**（判断） | 保留 |
| — | 取引先 銀行口座(SWIFT/IBAN) | — | 別テーブル `vendor_bank_accounts`（未GRANT）・**非表示方針**で対象外 | 廃止/対象外 |

### 決定ポイント
- **稟議(6-6)**：忠実な稟議＝ワークフロー記録（対象参照・申請者・承認者・状態・decided_at）が必要で、既存テーブルに適合するものが無い。→ 新規テーブル＋GRANT＋app.tsのwrite-gate。最小案（既存オブジェクトにフラグ）で足りるかを要相談。
- **アーカイブ(6-4)/契約チェック(6-5)/設定(6-7) の「保存」版**：監査タイムスタンプや結果永続化を求める場合はDDL判断。まずは status/is_active 流用・計算専用・localStorage の**依存ゼロ版**で提供。
- **銀行口座**：`vendor_bank_accounts` は別テーブルかつ未GRANT・現状**非表示方針**。載せ替えでは「廃止/対象外」判定（surfaceするなら新規SELECT GRANTの判断）。

## 2. Slice 6-1（実装済み）

- 共通 `client/export-util.ts`：純関数 `toCsv(columns, rows)`（RFC-4180エスケープ・BOM）／`toExcelHtml(sheetName, columns, rows)`（HTMLテーブル＝`.xls`・**SheetJS非依存**）／`download`／`exportCsv`／`exportExcel`。`ExportColumn<T>={header, value}` で型安全。`PaymentReport` のローカル実装を汎用化。
- `client/ExportButtons.tsx`：CSV/Excel出力ボタン（rows空時は無効）。
- 配線：
  - **文書一覧**（未発行含む・`DocumentRegistry`）
  - **検収待ち**（`PendingInspections`）
  - **条件明細/許諾**（`ConditionSearch`・表示中の絞り込み結果）
  - **請求ダッシュボード**（`BillingDashboard`）
  - **支払報告書**（`PaymentReport` を共通化へリファクタ・合計行を出力に付与）
- クライアント純関数テスト（`export-util.test.ts`）。**新規GRANT・env・依存なし**（既存デプロイで反映）。テスト390件。
