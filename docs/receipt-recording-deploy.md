# 再許諾料 受領記録 書込みデプロイ手順（Phase 1 スライス6）

サブライセンサーとして受領した再許諾料の記録（`condition_receipts` の作成・更新）を本番`legalbridge` DBへ書込む機能を有効化するための手順。既定OFFで、`verify-isolation`ゲート通過時のみデプロイされる。

## 1. この構成で有効になる範囲

`WRITE_SCOPES=...,receipts`、`RECEIPT_WRITES_ENABLED=true` のとき、`legalbridge_v2_runtime`ロールで次が有効になる。

- 受領記録の作成：`POST /api/v2/condition-receipts`（`condition_receipts` へ INSERT）
- 受領記録の更新：`PUT /api/v2/condition-receipts/:id`（同 UPDATE）

管理者**または法務**ロール限定で、合言葉 `COMMIT_PRODUCTION_RECEIPT` を要求する。**受領再許諾料（`computed_royalty_ex_tax`）はサーバが再計算する**：料率・単価は `condition_lines`（DB由来）から読み、数量ベース判定（`calcType`）と報告値（`reportedSales`/`reportedQuantity`）から `computeReceiptRoyalty` で算出する。フロント送信の金額は使わない。

## 2. 常時維持する安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ。
- `condition_receipts` への SELECT/INSERT/UPDATE のみ。**DELETE は付与しない**（取消は status/ゼロ更新で運用）。
- 受領記録は `condition_line_id`（→`condition_lines`）に紐づく（0101 の付替え後の正準FK）。
- `payments` 台帳同期・上流分配（`distribution_*`）は本スライスの対象外（別 grant・別スライス）。
- 有効スコープは `WRITE_SCOPES` と完全一致でなければデプロイを停止する。

## 3. 前提条件（デプロイ前に完了）

1. **ランタイムロール**：`legalbridge_v2_runtime` を作成済み（006 基盤が存在前提）。
2. **権限付与（preflightで確認後に本付与）**：

   ```bash
   # 読取専用preflight（変更なし）
   psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/015_production_receipt_preflight.sql

   # 本付与（condition_receipts の SELECT/INSERT/UPDATE と id シーケンス）
   psql "$RUNTIME_ADMIN_DSN" \
     -v confirm_receipt_grants=GRANT_PRODUCTION_RECEIPTS \
     -f infra/gcp/sql/015_production_receipt_grants.sql
   ```

   guard は `current_database()='legalbridge'`・ロール存在・`relkind='r'`（VIEWでないこと）を検証する。

## 4. デプロイ（Cloud Run IAM 検証構成）

`_WRITE_SCOPES` はカンマを含むため `--substitutions` の区切りを `^|^` にする。スコープに `receipts` を追加する。

```
|_WRITE_SCOPES=drafts,documents,pdf,receipts|_RECEIPT_WRITES_ENABLED=true
```

`verify-isolation` は DB=`legalbridge`・ユーザー=`legalbridge_v2_runtime`・`AUTH_MODE`≠`disabled`・`WRITE_SCOPES` 完全一致を検証する。

## 5. デプロイ後の検証

`/health`・`/api/v2/runtime` の `writeCapabilities` に `receipts` が含まれること、`accessMode: "readwrite"`、`database.currentDatabase: "legalbridge"`・`readOnly: false` を確認する。作成APIが `receipt.computedRoyaltyExTax` をサーバ再計算値で返すこと。

## 6. 切戻し・無効化

- 書込みを止める：`RECEIPT_WRITES_ENABLED=false` かつ `WRITE_SCOPES` から `receipts` を除いて再デプロイ、または `WRITE_FEATURES_ENABLED=false`。
- DBレコードは自動巻戻ししない。誤記録は受領記録IDを控え、`received_amount`/`status` をゼロ・reported へ更新して無効化する（アプリからのDELETEは無い）。

詳細な段階開放ゲートは [Production Readiness Runbook](production-readiness.md) を参照。
