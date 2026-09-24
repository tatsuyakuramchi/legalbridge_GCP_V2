# 取引先(vendors)マスタ 登録・編集 有効化手順

台帳の取引先を、本番`legalbridge` DBへ書込む形で新規登録・編集できるようにする手順。案件(matters)CRUDと同じ guarded-write モデルで、既定は無効（`VENDOR_WRITES_ENABLED=false`・`WRITE_SCOPES`に`vendors`なし）。`verify-isolation`ゲート通過時のみデプロイされる。

## 1. 有効になる範囲

`WRITE_SCOPES`に`vendors`を含み、`VENDOR_WRITES_ENABLED=true`のとき（管理者・法務ロール限定）：

- 取引先の新規登録：`POST /api/v2/vendors`（`vendors`へINSERT。`vendor_code`未指定時は`VEN-NNNNN`自動採番）
- 取引先の編集：`PATCH /api/v2/vendors/:id`
- 代表者・法人番号・連絡先等の一般情報は管理者・法務が編集可能
- 銀行口座は機微情報として管理者のみ参照・編集可能
- 国内銀行・海外銀行を切替可能。海外銀行では SWIFT/BIC、IBAN、Routing/ABA/Sort Code、英字口座名義、銀行所在国・所在地、送金通貨、中継銀行を登録できる

検証（`POST /api/v2/vendors/validate`）は書込み無効でも読取だけ実行できる。DELETE APIは提供しない。

## 2. DB構造：vendors と vendor_bank_accounts

取引先本体の `vendors` には、既存帳票との後方互換のため代表口座の国内互換列を残す。

```text
vendors.bank_name
vendors.branch_name
vendors.account_type
vendors.account_number
vendors.account_holder_kana
vendors.bank_info
```

口座情報の正規化された保存先は 1:N の `vendor_bank_accounts`。既存列に加え、海外送金用として次の列を使用する。

```text
account_scope             varchar(20)  domestic / overseas
swift_bic                 varchar(20)
iban                      varchar(64)
routing_number            varchar(40)
account_holder_name       text
bank_country              varchar(2)   ISO 3166-1 alpha-2
bank_address              text
currency                  varchar(3)   ISO 4217
intermediary_bank_swift   varchar(20)
intermediary_bank_name    text
```

この列構成は共有DBを利用する LegalBridge_AI_GCP の `migrations/0014_overseas_bank_fields.sql` と一致させている。V2独自の別名カラムは作らない。

V2画面は現時点では「メイン振込先」1口座を編集する。保存時には `vendor_bank_accounts` の primary 行を INSERT/UPDATE し、他の既存口座は削除しない。代表口座の `bank_name / branch_name / account_type / account_number / account_holder_kana` は `vendors` にミラーし、既存の国内帳票・検索との互換性を保つ。

## 3. 安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`
- `vendors`への`INSERT, UPDATE`に加え、`vendor_bank_accounts`へ`SELECT, INSERT, UPDATE`を付与する
- `vendor_bank_accounts`の`DELETE`権限は付与しない
- 銀行口座情報はアプリ上 admin のみ参照・更新できる。legal/requester へ海外口座の追加列も返さない
- 海外口座保存は取引先本体の更新と同一トランザクションで実行する
- 082未適用時は海外口座更新を 503 で停止し、国内レガシー列の読取は可能な限り維持する

## 4. 前提DB変更

### 4.1 vendors 書込み権限（009）

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/009_production_vendor_master_preflight.sql
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_vendor_master_grants=GRANT_PRODUCTION_VENDOR_MASTER \
  -f infra/gcp/sql/009_production_vendor_master_grants.sql
```

### 4.2 海外銀行口座カラム・権限（082）

082は実行前後に `information_schema.columns` を出力し、実DBの `vendor_bank_accounts` 列を確認する。変更はすべて additive / `IF NOT EXISTS` で、共有DB側ですでに0014相当が適用済みでも再実行可能。

```bash
psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
  -v confirm_overseas_bank=ENABLE_VENDOR_OVERSEAS_BANK \
  -f infra/gcp/sql/082_vendor_overseas_bank_accounts.sql
```

期待する主要カラムは `account_scope / swift_bic / iban / routing_number / account_holder_name / bank_country / bank_address / currency / intermediary_bank_swift / intermediary_bank_name`。

## 5. デプロイ

`--substitutions`（`^|^`区切り）へ次を追加し、`_WRITE_SCOPES`末尾に`,vendors`を加える。

```
|_VENDOR_WRITES_ENABLED=true|_CONFIRM_VENDOR_WRITES=VENDOR_MASTER_LEGALBRIDGE_VALIDATION_ONLY
```

コードのデプロイ前または同一メンテナンス枠で 082 を適用する。コードだけ先行すると海外口座の保存時に `VENDOR_BANK_SCHEMA_MISSING` / `VENDOR_BANK_PERMISSION_MISSING` で停止する。

## 6. デプロイ後の検証

`/api/v2/runtime`の`writeCapabilities`に`vendors`が含まれることを確認する。「台帳 > 取引先 > 編集」で「メイン振込先」の口座区分を海外銀行へ切替え、以下を確認する。

1. SWIFT/BIC・IBAN等を保存して再表示できる。
2. `vendor_bank_accounts` の primary 行に海外固有値が保存される。
3. `vendors.bank_*` に代表口座の互換値がミラーされる。
4. 「DBから引用」で海外発注書へ SWIFT/BIC・IBAN・英字口座名義等が差し込まれる。
5. legal ロールでは銀行口座項目が返らず、送信しても403になる。

## 7. 参照

- [案件（Matter）作成・編集 有効化](matter-management.md)
- [契約取込デプロイ手順](contract-intake-deploy.md)
- [IAP直接アクセス](iap-access.md)
