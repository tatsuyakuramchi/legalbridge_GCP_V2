# 取引先(vendors)マスタ 登録・編集 有効化手順

台帳の取引先を、本番`legalbridge` DBへ書込む形で新規登録・編集できるようにする手順。案件(matters)CRUDと同じ guarded-write モデルで、既定は無効（`VENDOR_WRITES_ENABLED=false`・`WRITE_SCOPES`に`vendors`なし）。`verify-isolation`ゲート通過時のみデプロイされる。

## 1. 有効になる範囲

`WRITE_SCOPES`に`vendors`を含み、`VENDOR_WRITES_ENABLED=true`のとき（管理者・法務ロール限定）：

- 取引先の新規登録：`POST /api/v2/vendors`（`vendors`へINSERT。`vendor_code`未指定時は`VEN-NNNNN`自動採番）
- 取引先の編集：`PATCH /api/v2/vendors/:id`（`vendor_name/vendor_code/trade_name/pen_name/entity_type/email/phone/contact_*/address/invoice_registration_number/is_invoice_issuer/withholding_enabled`をUPDATE）

検証（`POST /api/v2/vendors/validate`）は書込み無効でも読取だけ実行できる。DELETEは提供しない。銀行口座情報はこのスライスの対象外（書込まない）。

## 2. 安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ
- 付与は`vendors`の`INSERT, UPDATE`と`vendors_id_seq`のみ（`DELETE`なし）
- 編集可能ロールは`admin`/`legal`のみ（`requester`は403）
- `WRITE_SCOPES`と有効化能力が完全一致でなければデプロイ停止

## 3. 前提：本番DBへのGRANT拡張（009）

006で`vendors`は`SELECT`のみ付与済み。編集には`INSERT, UPDATE`を追加する。

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/009_production_vendor_master_preflight.sql
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_vendor_master_grants=GRANT_PRODUCTION_VENDOR_MASTER \
  -f infra/gcp/sql/009_production_vendor_master_grants.sql
```

## 4. デプロイ（既存構成に取引先編集を追加）

`--substitutions`（`^|^`区切り）へ次を**追加**し、`_WRITE_SCOPES`末尾に`,vendors`を加える（順序は`verify-isolation`と完全一致：`...,matters,vendors`。matters未使用なら`contract-intake,vendors`）。

```
|_VENDOR_WRITES_ENABLED=true|_CONFIRM_VENDOR_WRITES=VENDOR_MASTER_LEGALBRIDGE_VALIDATION_ONLY
```

## 5. デプロイ後の検証

`/api/v2/runtime`の`writeCapabilities`に`vendors`が含まれること。「台帳」画面の取引先タブに「＋ 新規取引先」ボタンが表示される。

## 6. 参照

- [案件（Matter）作成・編集 有効化](matter-management.md)
- [契約取込デプロイ手順](contract-intake-deploy.md)
- [IAP直接アクセス](iap-access.md)
