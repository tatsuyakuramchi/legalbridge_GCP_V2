# 作品(works)マスタ 登録・編集 有効化手順

原作作品マスタを本番`legalbridge` DBへ書込む形で登録・編集できるようにする手順。取引先・担当者CRUDと同じ guarded-write モデルで、既定は無効（`WORK_WRITES_ENABLED=false`・`WRITE_SCOPES`に`works`なし）。DBテーブル構成・templateは変更しない。

## 1. 有効になる範囲（管理者・法務ロール限定）

- 詳細（編集用の生値）：`GET /api/v2/works/:id`（admin/legal）
- 新規登録：`POST /api/v2/works`（`works`へINSERT。`work_code`は未入力で`WRK-NNNNN`自動採番）
- 編集：`PATCH /api/v2/works/:id`

DELETEは提供しない。`work_code`重複は409。台帳画面「作品」タブの「＋新規作品」および詳細「編集」から操作する。

## 2. 安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ
- 付与は`works`の`INSERT`（007で付与済）+`UPDATE`（012で追加）と`works_id_seq`（007で付与済）のみ（`DELETE`なし）
- 編集可能ロールは`admin`/`legal`のみ
- `WRITE_SCOPES`と有効化能力が完全一致でなければデプロイ停止

## 3. 前提：本番DBへのGRANT拡張（012）

`INSERT`と`works_id_seq`は007で付与済み。編集用に`UPDATE`のみ追加する。

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/012_production_work_master_preflight.sql
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_work_master_grants=GRANT_PRODUCTION_WORK_MASTER \
  -f infra/gcp/sql/012_production_work_master_grants.sql
```

## 4. デプロイ（追加substitution）

`--substitutions`（`^|^`区切り）へ次を**追加**し、`_WRITE_SCOPES`末尾に`,works`を加える（順序は`verify-write-test`と完全一致：`...,staff,works`）。

```
|_WORK_WRITES_ENABLED=true|_CONFIRM_WORK_WRITES=WORK_MASTER_LEGALBRIDGE_VALIDATION_ONLY
```

## 5. デプロイ後の検証

`/api/v2/runtime`の`writeCapabilities`に`works`が含まれること。台帳「作品」タブで新規登録・編集が可能。

## 6. 参照

- [取引先(vendors)マスタ 有効化](vendor-master.md)
- [担当者(staff)マスタ 有効化](staff-master.md)
- [案件（Matter）作成・編集 有効化](matter-management.md)
