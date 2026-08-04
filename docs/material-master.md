# 原作マテリアル(work_materials)マスタ 登録・編集 有効化手順

原作マテリアル（素材）マスタを本番`legalbridge` DBへ書込む形で登録・編集できるようにする手順。作品(works)・取引先(vendors)マスタと同じ guarded-write モデルで、既定は無効（`MATERIAL_WRITES_ENABLED=false`・`WRITE_SCOPES`に`materials`なし）。DBテーブル構成・templateは変更しない。

## 0. テーブルロジック（前提）

- **作品(works) 1 : N マテリアル(work_materials)**：マテリアルは必ず作品に属する（`work_materials.work_id` FK）。
- **条件(condition_lines)** は `work_id` で**作品に直接**紐づき、加えて `source_material_id` で「どのマテリアル由来か」を任意に指定する。つまり条件は作品にぶら下がり、素材は由来を示す補助リンク。
- マテリアル登録時は作品内の素材区分ごとに `material_categories`（`work_id`＋`genre`）を確保し、`material_no`（作品内連番）・`material_code`（`作品コード-NNN`）を自動採番する。

## 1. 有効になる範囲（管理者・法務ロール限定）

- 作品ピッカー：`GET /api/v2/materials/works?q=`（作品を検索して選択）
- 詳細（編集用の生値）：`GET /api/v2/materials/:id`
- 新規登録：`POST /api/v2/materials`（作品を指定して`work_materials`へINSERT。素材コードは自動採番）
- 編集：`PATCH /api/v2/materials/:id`（素材区分・所属作品は変更不可。付け替えは新規作成で行う）

DELETEは提供しない。素材コード重複は409、存在しない作品指定は422。

## 2. 安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ
- 付与は`work_materials`/`material_categories`の`INSERT`（007で付与済）+`work_materials`の`UPDATE`（013で追加）と各`_id_seq`（007で付与済）のみ（`DELETE`なし）
- 編集可能ロールは`admin`/`legal`のみ
- `WRITE_SCOPES`と有効化能力が完全一致でなければデプロイ停止

## 3. 前提：本番DBへのGRANT拡張（013）

`INSERT`と各`_id_seq`は007で付与済み。編集用に`work_materials`の`UPDATE`のみ追加する。

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/013_production_material_master_preflight.sql
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_material_master_grants=GRANT_PRODUCTION_MATERIAL_MASTER \
  -f infra/gcp/sql/013_production_material_master_grants.sql
```

## 4. デプロイ（追加substitution）

`--substitutions`（`^|^`区切り）へ次を**追加**し、`_WRITE_SCOPES`末尾に`,materials`を加える（順序は`verify-write-test`と完全一致：`...,works,materials`）。

```
|_MATERIAL_WRITES_ENABLED=true|_CONFIRM_MATERIAL_WRITES=MATERIAL_MASTER_LEGALBRIDGE_VALIDATION_ONLY
```

## 5. デプロイ後の検証

`/api/v2/runtime`の`writeCapabilities`に`materials`が含まれること。台帳「原作マテリアル」タブで作品を選んで新規登録・編集が可能。

## 6. 参照

- [作品(works)マスタ 有効化](work-master.md)
- [取引先(vendors)マスタ 有効化](vendor-master.md)
