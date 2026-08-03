# 担当者(staff)マスタ 登録・編集 有効化手順

担当者マスタを本番`legalbridge` DBへ書込む形で登録・編集できるようにする手順。取引先・案件CRUDと同じ guarded-write モデルで、既定は無効（`STAFF_WRITES_ENABLED=false`・`WRITE_SCOPES`に`staff`なし）。

## 1. 有効になる範囲（管理者・法務ロール限定）

- 一覧・詳細（編集用の生値）：`GET /api/v2/staff`, `GET /api/v2/staff/:id`（admin/legal）
- 新規登録：`POST /api/v2/staff`（`staff`へINSERT。`slack_user_id`はUNIQUE NOT NULLのため必須）
- 編集：`PATCH /api/v2/staff/:id`

DELETEは提供しない。`slack_user_id`重複は409。

## 2. 安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ
- 付与は`staff`の`INSERT, UPDATE`と`staff_id_seq`のみ（`DELETE`なし）
- 編集可能ロールは`admin`/`legal`のみ（UIナビは管理者に表示）
- `WRITE_SCOPES`と有効化能力が完全一致でなければデプロイ停止

## 3. 前提：本番DBへのGRANT拡張（010）

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/010_production_staff_master_preflight.sql
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_staff_master_grants=GRANT_PRODUCTION_STAFF_MASTER \
  -f infra/gcp/sql/010_production_staff_master_grants.sql
```

## 4. デプロイ（追加substitution）

`--substitutions`（`^|^`区切り）へ次を**追加**し、`_WRITE_SCOPES`末尾に`,staff`を加える（順序は`verify-isolation`と完全一致：`...,vendors,staff`）。

```
|_STAFF_WRITES_ENABLED=true|_CONFIRM_STAFF_WRITES=STAFF_MASTER_LEGALBRIDGE_VALIDATION_ONLY
```

## 5. デプロイ後の検証

`/api/v2/runtime`の`writeCapabilities`に`staff`が含まれること。左ナビ「管理 > 担当者」で一覧・新規登録・編集が可能。

## 6. 参照

- [取引先(vendors)マスタ 有効化](vendor-master.md)
- [案件（Matter）作成・編集 有効化](matter-management.md)
