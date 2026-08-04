# ロイヤリティ消化イベント 書込みデプロイ手順（Phase 1 スライス2）

利用許諾料計算の結果を消化実績イベント（`condition_events`, `event_type='royalty_calc'`）として本番`legalbridge` DBへ追記する機能を有効化するための手順。既定OFFで、`verify-isolation`ゲート通過時のみデプロイされる。

## 1. この構成で有効になる範囲

`WRITE_SCOPES=...,royalty-events`、`ROYALTY_EVENT_WRITES_ENABLED=true` のとき、`legalbridge_v2_runtime`ロールで次が有効になる。

- ロイヤリティ消化イベント記録：`POST /api/v2/royalty/events`（`condition_events` へ **INSERT のみ**、`event_type='royalty_calc'`）

管理者**または法務**ロール限定で、合言葉 `COMMIT_PRODUCTION_ROYALTY_EVENT` を要求する。**金額はサーバが再計算する**（`terms`/`adjustments` から `calculateFee` で `actual_ex_tax` を算出し、フロント送信値は使わない）。計算専用の試算 `POST /api/v2/royalty/preview` は書込みゲートが無効でも読取だけ実行できる（DB非依存）。

## 2. 常時維持する安全境界

- 対象DBは本番`legalbridge`、接続ユーザーは`legalbridge_v2_runtime`のみ。
- `condition_events` への **追記(INSERT)のみ**。UPDATE/DELETE は付与しない（論理取消 `voided_at` 運用は別スライス）。
- `royalty_calc` イベントは `document_id` NOT NULL（CHECK制約 `ce_document_pairing`）。確定済み計算書 document を要求する。
- 有効スコープは `WRITE_SCOPES` と完全一致でなければデプロイを停止する。
- Cloud Run は `--no-allow-unauthenticated`、認証は `cloudrun-iam` または `iap`。

## 3. 前提条件（デプロイ前に完了）

1. **ランタイムロール**：`legalbridge_v2_runtime` を作成済み（006 基盤・011 消化設定が存在前提）。011 が `condition_events` の SELECT を付与済み。
2. **権限付与（preflightで確認後に本付与）**：

   ```bash
   # 読取専用preflight（変更なし・現在の権限を表示）
   psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/014_production_royalty_event_preflight.sql

   # 本付与（condition_events の INSERT と id シーケンス）
   psql "$RUNTIME_ADMIN_DSN" \
     -v confirm_royalty_event_grants=GRANT_PRODUCTION_ROYALTY_EVENTS \
     -f infra/gcp/sql/014_production_royalty_event_grants.sql
   ```

   014 は 011 の SELECT に **INSERT を上乗せ**する（`condition_events` + `condition_events_id_seq`）。guard は `current_database()='legalbridge'`・ロール存在・`relkind='r'`（VIEWでないこと）を検証する。

## 4. デプロイ（Cloud Run IAM 検証構成）

`_WRITE_SCOPES` はカンマを含むため `--substitutions` の区切りを `^|^` にする。契約取込などと同じサービスで併用する場合はスコープに `royalty-events` を追加する。

```
|_WRITE_SCOPES=drafts,documents,pdf,royalty-events|_ROYALTY_EVENT_WRITES_ENABLED=true
```

`verify-isolation` は DB=`legalbridge`・ユーザー=`legalbridge_v2_runtime`・`AUTH_MODE`≠`disabled`・`WRITE_SCOPES` 完全一致を検証する。

## 5. デプロイ後の検証

`/health`・`/api/v2/runtime` の `writeCapabilities` に `royalty-events` が含まれること、`accessMode: "readwrite"`、`database.currentDatabase: "legalbridge"`・`readOnly: false` を確認する。

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -X POST "$SERVICE_URL/api/v2/royalty/events" \
  -H 'Content-Type: application/json' \
  -d '{"confirmation":"COMMIT_PRODUCTION_ROYALTY_EVENT","conditionLineId":<CL_ID>,"documentId":<DOC_ID>,"period":"2026-08","terms":{"type":"performance","base_price":1000,"rate_pct":10,"quantity":100},"adjustments":{"mg_amount":9000,"ag_amount":4000}}'
```

`event.amountExTax` がサーバ再計算値（フロント非依存）で返り、`event.eventNo` が条件行ごとに連番であること。

## 6. 切戻し・無効化

- 書込みを止める：`ROYALTY_EVENT_WRITES_ENABLED=false` かつ `WRITE_SCOPES` から `royalty-events` を除いて再デプロイ、または `WRITE_FEATURES_ENABLED=false`。
- DBレコードは自動巻戻ししない。誤記録時はイベントID・条件行IDを記録し、DB側で `voided_at` 等により個別対応する（アプリからのDELETEは無い）。

詳細な段階開放ゲートは [Production Readiness Runbook](production-readiness.md) を参照。
