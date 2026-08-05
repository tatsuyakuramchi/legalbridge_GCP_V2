# payments 台帳同期 書込みデプロイ手順（Phase 1）

再許諾料の受領→入金台帳、上流分配→出金台帳への同期（`payments` の作成・更新）を本番`legalbridge` DBへ書込む機能を有効化するための手順。既定OFFで、受領記録（S6）とは**独立した追加 capability**。

## 1. この構成で有効になる範囲

`WRITE_SCOPES=...,receipts,payments`、`RECEIPT_WRITES_ENABLED=true`、`PAYMENT_LEDGER_WRITES_ENABLED=true` のとき、受領記録（`POST/PUT /api/v2/condition-receipts`）が同一トランザクションで `payments` へ同期する。

- 受領（`received_amount`）→ 入金台帳：`payments`（`direction='inbound'`, `payment_kind='sublicense_income'`）
- 上流分配（`computed_distribution_ex_tax`）→ 出金台帳：`payments`（`direction='outbound'`, `payment_kind='royalty'`, 相手=親ライセンサー）
- 受領行へ `payment_id` / `distribution_payment_id` を書き戻す。

同期の意図は純関数 `planPaymentSync` が算出する。**no-DELETE**：クリア時は DELETE せず金額ゼロの UPDATE。`payments` の CHECK（`work_id IS NOT NULL OR department_code IS NOT NULL`）を満たせない（作品未リンク）場合はその同期をスキップする。

**capability分離**：`payments` スコープが無ければ受領記録は動作するが台帳同期は行わない（`paymentsSynced=0`）。台帳同期は `payments` スコープ＋grant 016 が揃った時のみ。

## 2. 常時維持する安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ。
- `payments` は SELECT/INSERT/UPDATE のみ。**DELETE は付与しない**。
- 金額はサーバ再計算値（受領再許諾料・分配）を用いる。フロント金額は使わない。
- 有効スコープは `WRITE_SCOPES` と完全一致でなければデプロイを停止する。

## 3. 前提条件（デプロイ前に完了）

1. **前段の付与**：015（`condition_receipts`）を適用済み（受領記録が前提）。
2. **権限付与（preflightで確認後に本付与）**：

   ```bash
   psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/016_production_payment_ledger_preflight.sql

   psql "$RUNTIME_ADMIN_DSN" \
     -v confirm_payment_ledger_grants=GRANT_PRODUCTION_PAYMENT_LEDGER \
     -f infra/gcp/sql/016_production_payment_ledger_grants.sql
   ```

   guard は `current_database()='legalbridge'`・ロール存在・`relkind='r'` を検証する。

## 4. デプロイ（Cloud Run IAM 検証構成）

`_WRITE_SCOPES` はカンマを含むため `--substitutions` の区切りを `^|^` にする。スコープに `receipts` と `payments` を含める。

```
|_WRITE_SCOPES=drafts,documents,pdf,receipts,payments|_RECEIPT_WRITES_ENABLED=true|_PAYMENT_LEDGER_WRITES_ENABLED=true
```

`verify-isolation` は DB=`legalbridge`・ユーザー=`legalbridge_v2_runtime`・`AUTH_MODE`≠`disabled`・`WRITE_SCOPES` 完全一致を検証する。

## 5. デプロイ後の検証

`/api/v2/runtime` の `writeCapabilities` に `receipts` と `payments` が含まれること。受領記録APIのレスポンス `receipt.paymentsSynced` が受領＋分配で最大2になること（作品未リンクや分配なしでは減る）。

## 6. 切戻し・無効化

- 台帳同期だけ止める：`WRITE_SCOPES` から `payments` を除く（受領記録は継続）。
- 全停止：`RECEIPT_WRITES_ENABLED=false` かつスコープから `receipts,payments` を除く、または `WRITE_FEATURES_ENABLED=false`。
- DBレコードは自動巻戻ししない。誤同期はpayments IDを控え、金額ゼロUPDATE等でDB側対応する（アプリからのDELETEは無い）。

詳細な段階開放ゲートは [Production Readiness Runbook](production-readiness.md) を参照。
