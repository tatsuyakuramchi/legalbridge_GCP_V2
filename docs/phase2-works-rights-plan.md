# Phase 2：作品・権利モデル — 計画と棚卸し

作品(work)を起点に、系譜（原作/派生）・素材・権利ソース・条件・料率対象を一望し編集できるようにする。Phase 1と同じ原則で進める：**読取先行 → capability-gated 書込み**、**共有本番DBのDDLは行わない**、**追加のみ・ゼロ破壊・no-DELETE**、GRANTは書込み時のみ新規発行。

## 1. 現状棚卸し（V2データモデル）

V2アプリはDDLを定義しない（設計不変条件）。テーブル/列は本番共有スキーマに存在し、GRANTファイルとリポジトリのSELECT/INSERT列から確定済み。作品まわりの主要テーブル：

- **works**：`work_code`(UNIQUE)/`title`/`title_kana`/`work_type`/`status`/`is_original`/`kind`(`licensed_in`|`own`)/`derivation_type`/**`parent_work_id`**(自己FK)/`rights_holder_vendor_id`/`creator_name`/`publisher_name`/`ledger_code`/`is_active`/`remarks`
- **work_relations**：明示的な派生グラフ `child_work_id`/`parent_work_id`/`relation_type`(`derived_from`)
- **work_materials**：`material_name`/`material_type`/`material_role`/`acquisition_type`/`rights_type`/`rights_holder_vendor_id`/`is_royalty_bearing`/`material_code`/`category_id`/`territory`/`language`
- **material_categories**：`work_id`/`genre`/`name`/`rights_holder_*`
- **material_rights_sources**（権利ソース）：`material_id`/`source_type`/`source_work_id`/`source_document_id`/`source_contract_id`/`source_role`/`is_primary`/`valid_from`/`valid_to`
- **contracts** / **contract_works**（`role`=`licensed_source`/`licensed_work`）
- **condition_lines**：`work_id`/`direction`/`source_work_id`/`source_material_id`/`material_rights_source_id`/**`parent_license_condition_id`**/`sublicense_allowed`/`rate_pct`/`royalty_base`/`exclusivity`/… ほか金銭列
- **condition_events**(014) / **condition_receipts**(015) / **payments**(016)

**GRANT状況**：runtime は 006 で works/condition_lines/vendors/documents 等の SELECT を保有。007（契約取込）が work_materials/material_categories/material_rights_sources/contracts/contract_works/work_relations に **SELECT+INSERT** を付与済み。→ **作品集約リードは新規GRANT不要**（007未適用時はセクション単位でnull縮退）。

### 既存の関連実装（Phase 2は拡張であり発明ではない）
- **系譜**：`parent_work_id`＋`work_relations`。`receivable-map` が `parent_work_id` を再帰で辿り原作→派生Nのカスケードを構築済み。
- **権利ソース**：`material_rights_sources` は取込で書込み済みだが読取API/UIは未整備。
- **サブライセンス**：`condition_lines.sublicense_allowed`＋`parent_license_condition_id`。
- **料率対象**：`condition_lines.rate_pct`/`royalty_base`、`material.is_royalty_bearing`。

## 2. スライス分割

| # | 内容 | 種別 | GRANT | 状態 |
|---|---|---|---|---|
| **2-1** | 作品集約リードAPI（一覧/検索＋詳細集約：概要/系譜/素材/権利ソース/条件） | 読取 | 不要（006+007のSELECT利用・セクションnull縮退） | ✅ |
| **2-2** | 作品詳細ページUI（タブ：概要/素材/条件/系譜/権利ソース/料率対象）＋作品ピッカー＋ナビ | 読取UI | 不要 | 着手予定 |
| **2-3** | 作品編集の拡張（現行5列→kind/derivation/parent/rights_holder等）＋系譜（parent_work_id） | 書込 | 012（works全表UPDATE）流用・新規不要 | ✅ |
| **2-4** | 権利ソース(material_rights_sources) capability-gated書込（作成/更新） | 書込 | **017**（UPDATE。INSERTは007済） | ✅ |
| 2-4b | work_relationsグラフ編集（系譜の第2真実源） | 書込 | 新規 | 未 |

### 決定ポイント（着手時に確認）
- **製品(製品/products)**：DBにテーブルが存在しない（テンプレの自由入力のみ）。移植は**新規テーブル＝DDL**を要し、「共有DB無改変」原則に抵触。→ 別途DDLマイグレーションの承認が必要。当面は素材/条件で代替表示し、製品タブは保留。
- **系譜の真実源の二重化**：`works.parent_work_id`（receivable-map採用）と`work_relations`が併存。2-1は**parent_work_idを正**とし、work_relations上のみに存在する親を「未反映」として詳細に提示（突き合わせ導線）。統合方針は2-3で確定。

## 3. Slice 2-1（実装済み）

- 純関数 `works/work-detail.ts`：`groupWorkConditions`（受領/支払・サブライセンス・素材紐付有無で分類）、`buildLineageView`（原作→selectedを原作/派生Nでラベル付け、work_relationsとの差分検出）。
- 読取リポジトリ `works/read-repository.ts`：`list({keyword,limit})`＋`detail(workId)`。詳細は コア(works)＋系譜/素材/権利ソース/条件 を並行取得し、権限不足・未整備（42501/42P01/42703）はセクション単位で`null`縮退。コア概要は常に返す。Memory実装同梱。
- ルーター `works/read-routes.ts`：`GET /works`（一覧/検索）・`GET /works/:id/detail`（集約）。admin/legal限定・読取のみ。既存書込ルーター（`GET /works/:id`）とパス非衝突。
- app.ts結線（読取・フラグ無し・safe-methods許可はGETで自動）。テスト＋12件。

**受け入れへの寄与**：「作品を起点に権利・条件・製品を一望」の**一望（読取）**部分をサーバ側で提供。UI（2-2）で完結。デプロイは既存 `cloudbuild-write-test.yaml` のままで反映（新env/GRANT不要）。
