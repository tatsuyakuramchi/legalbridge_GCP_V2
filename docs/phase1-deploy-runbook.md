# Phase 1（金銭・ロイヤリティ）デプロイ Runbook（統合）

Phase 1 で追加した金銭機能を本番`legalbridge` DBへ段階開放するための統合手順。各機能は**既定OFF**で、`WRITE_SCOPES` と GRANT が揃った時のみ有効になる。個別の詳細は各 deploy doc を参照。

> 前提：006 基盤 GRANT・ランタイムロール `legalbridge_v2_runtime` が適用済み。実行は本番DBに接続できるオペレーターが行う（本リポジトリのアプリからはDBを直接変更しない）。

## 0. Phase 1 で増えた capability と GRANT

| capability（scope） | GRANT | 対象テーブル | 種別 | 個別doc |
|---|---|---|---|---|
| （読取のみ） | 011 | condition_line_installments / condition_events | SELECT | condition-settlement.md |
| `royalty-events` | 014 | condition_events | +INSERT | royalty-events-deploy.md |
| `receipts` | 015 | condition_receipts | SELECT/INSERT/UPDATE | receipt-recording-deploy.md |
| `payments` | 016 | payments | SELECT/INSERT/UPDATE | payment-ledger-deploy.md |

読み取り専用UI（ロイヤリティ試算・請求ダッシュボード・債権マップ・支払報告書・請求印刷）は上記 SELECT があれば表示され、無くても空で安全に縮退する（新規GRANT不要のものを含む）。書込みUI（受領記録・消化イベント）は capability 有効時のみ表示。

## 1. GRANT 適用（preflight → 本付与）

各ファイルは非破壊・確認トークン付き・`current_database()='legalbridge'`／`relkind='r'`（VIEW誤GRANT防止）を検証する。

```bash
# 011：消化・検収の読取（決算バンド／ダッシュボードKPIが点灯）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/011_production_condition_settlement_preflight.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_condition_settlement_grants=GRANT_PRODUCTION_CONDITION_SETTLEMENT \
  -f infra/gcp/sql/011_production_condition_settlement_grants.sql

# 014：消化イベント書込（royalty-events）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/014_production_royalty_event_preflight.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_royalty_event_grants=GRANT_PRODUCTION_ROYALTY_EVENTS \
  -f infra/gcp/sql/014_production_royalty_event_grants.sql

# 015：受領記録（receipts）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/015_production_receipt_preflight.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_receipt_grants=GRANT_PRODUCTION_RECEIPTS \
  -f infra/gcp/sql/015_production_receipt_grants.sql

# 016：payments 台帳同期（payments）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/016_production_payment_ledger_preflight.sql
psql "$RUNTIME_ADMIN_DSN" -v confirm_payment_ledger_grants=GRANT_PRODUCTION_PAYMENT_LEDGER \
  -f infra/gcp/sql/016_production_payment_ledger_grants.sql
```

必要な範囲だけ適用してよい（例：まず 011 だけで読取KPIを点灯 → 後で 015/016 で書込みを開放）。

## 2. 有効化する capability の env（cloudbuild-write-test）

`_WRITE_SCOPES` はカンマを含むため `--substitutions` の区切りを `^|^` にする。**GRANT を適用した capability だけ**をスコープに含める（`WRITE_SCOPES` と実際の GRANT が食い違うと `verify-isolation` が停止する）。

金銭の書込みを全て開放する例（受領→分配→台帳→消化イベント）：

```
|_WRITE_SCOPES=drafts,documents,pdf,receipts,payments,royalty-events|_RECEIPT_WRITES_ENABLED=true|_PAYMENT_LEDGER_WRITES_ENABLED=true|_ROYALTY_EVENT_WRITES_ENABLED=true
```

読取KPIだけ先に確認する場合はスコープ追加不要（011 の SELECT のみで点灯）。

デプロイコマンドのひな型は `docs/contract-intake-deploy.md` §4 を流用（`_WRITE_SCOPES` 以降を上記に差し替え）。`verify-isolation` は DB=`legalbridge`・ユーザー=`legalbridge_v2_runtime`・`AUTH_MODE`≠`disabled`・`WRITE_SCOPES` 完全一致を検証する。

## 3. デプロイ後の検証

```bash
SERVICE_URL=$(gcloud run services describe legalbridge-v2-write-test \
  --region=asia-northeast1 --project=legalbridge-488506 --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)
curl -s -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/api/v2/runtime" | python3 -m json.tool
```

- `accessMode: "readwrite"`、`writeCapabilities` に開放した capability（`receipts`,`payments`,`royalty-events`）が並ぶ。
- 一気通貫スモーク：`POST /api/v2/condition-receipts`（確認トークン `COMMIT_PRODUCTION_RECEIPT`・受領額あり）→ レスポンスの `receipt.computedRoyaltyExTax`（サーバ再計算）・`paymentsSynced`（`payments` 開放時は最大2）を確認 → `GET /api/v2/receipts-dashboard`・`GET /api/v2/payment-report` で反映を確認。

## 4. 切戻し

- 特定 capability だけ止める：`WRITE_SCOPES` から該当スコープを除いて再デプロイ。
- 全書込み停止：`WRITE_FEATURES_ENABLED=false`。
- GRANT は自動巻戻ししない。誤記録は該当行を `voided_at`／金額ゼロUPDATE 等でDB側対応する（アプリからの DELETE は無い）。

## 5. 出力・レポート（GRANT不要）

- 支払報告書：`GET /api/v2/payment-report`。UIから **CSV / 軽量Excel(.xls)** を出力（クライアント生成・外部依存なし）。
- 請求印刷：`window.print()` で計算書をPDF化。

段階開放ゲートの全体像は [Production Readiness Runbook](production-readiness.md) を参照。
