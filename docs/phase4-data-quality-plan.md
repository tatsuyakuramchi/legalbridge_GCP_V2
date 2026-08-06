# Phase 4：データ品質・保全・取込 — 計画と棚卸し

不整合を検知・修復でき、一括取込が実運用に耐えることを目標に、既存データモデル上へ品質・保全・取込機能を移植する。Phase 1〜3と同じ原則：**読取先行 → capability-gated 書込み**、**共有本番DBのDDLなし**、**追加のみ・no-DELETE中心**、GRANTは書込み時のみ新規発行。

## 1. 現状棚卸し（要点）

- **CSV取込**：汎用 `CsvImport.tsx`（設定駆動）＋エンティティ別ハードコードの取込エンドポイント（vendors/staff/works、documents一括）。素材・権利ソースの取込は**なし**。「全テーブル・スキーマ駆動化」はレジストリ＋汎用取込ルーターが必要。
- **データ品質チェック**：**専用機能なし**。局所的な重複ガード（条件重複・契約取込の重複ブロック・Slack重複抑止）のみ。
- **未リンクCL**：`condition_lines.work_id/document_id/counterparty_vendor_id` の欠落を俯瞰する導線なし。
- **名寄せ (Entity merge)**：なし（`lb_norm_name` 関数はEXECUTE付与済＝正規化に利用可）。
- **下書き管理**：`document_drafts` は一覧＋個別削除UIあり（`DraftWorkspace`）。一括整理なし（DELETEはgrant 006付与済）。
- **読取スキャンの実行可否**：主要な整合スキャンは**すべて既存GRANTのみで読取可能**（006: works/condition_lines/vendors/documents、007: work_materials/material_rights_sources、015: condition_receipts）。

## 2. スライス分割

| # | 内容 | 種別 | GRANT | 状態 |
|---|---|---|---|---|
| **4-1** | データ品質センター（横断整合スキャン俯瞰・drill導線） | 読取 | 不要（006/007/015のSELECT・スキャン単位null縮退） | ✅ |
| **4-2** | CSV取込の拡張（素材・権利ソース取込・共通bulkヘルパ） | 書込 | 既存INSERT（007）流用 | ✅ |
| **4-3** | 名寄せ（取引先マージ・8表FK再指定＋旧is_active=false・プレビュー2段） | 書込 | **018**（列単位UPDATE×4表） | ✅ |
| **4-4** | 下書き一括整理（stale sweep・プレビュー→一括削除） | 書込 | 006 DELETE済・既存 `drafts` capability | ✅ |
| 4-5 | Excel/LegalOn一括取込 | 書込 | 依存判断 | 未 |

### 決定ポイント
- **名寄せ（4-3）＝確定・実装済**：取引先マージは8表のFKを旧→新へ再指定（`condition_lines.counterparty_vendor_id` / `payments.counterparty_vendor_id` / `works.rights_holder_vendor_id` / `work_materials.rights_holder_vendor_id` / `material_rights_sources.rights_holder_vendor_id` / `material_categories.rights_holder_vendor_id` / `contracts.primary_vendor_id` / `contract_works.rights_holder_vendor_id`）。旧取引先は**削除せず `is_active=false`**（no-DELETE・監査保持）。既にUPDATE済（payments/works/work_materials/material_rights_sources/vendors）以外の4表は **grant 018 で列単位UPDATE**のみ付与（全列UPDATEはしない）。プレビュー（再指定件数）→合言葉 `COMMIT_VENDOR_MERGE`→実行の2段。
- **Excel/LegalOn（4-5）**：解析ライブラリの依存判断（S4 Excel同様、まず依存なしのCSV正規化で代替可）。

## 3. Slice 4-1（実装済み）

- 純関数 `data-quality/scan.ts`：`summarizeQuality(categories)`（available のみ集計、重大度→件数降順に整列、未スキャンを末尾へ）＋型。
- 読取リポジトリ `data-quality/repository.ts`：`scan()` が5カテゴリを並行実行。**スキャン単位で 42501/42P01/42703/42883 を捕捉し available:false に縮退**（他カテゴリは通常表示）。Memory実装同梱。
  - **未リンク条件明細**（high）：`condition_lines` の work/document/counterparty 欠落
  - **素材未登録の作品**（medium）：`works` に `work_materials` が0件
  - **権利ソース未登録の素材**（medium）：ロイヤリティ対象 `work_materials` に `material_rights_sources` なし
  - **未受領（報告済）**（low）：`condition_receipts.received_amount IS NULL`
  - **取引先の重複候補**（medium）：`lower(btrim(vendor_name))` 一致（名寄せ候補・関数非依存）
- ルーター `data-quality/routes.ts`：`GET /data-quality`（admin/legル限定・読取のみ）。
- app.ts結線（読取・フラグ無し）。UI `DataQuality.tsx`（サマリバンド＋重大度色分けカード＋サンプル展開＋drill導線）をナビ「設定＞データ品質」に新設。CSSは `dq-*` 名前空間。
- テスト361件。新規GRANT・env・依存なし（既存デプロイで反映）。
