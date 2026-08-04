# 条件明細の消化実績・検収率 有効化手順

条件明細の詳細に「消化・残高」（予定回×実績イベント）と検収状況を表示する。読取専用で、`condition_line_installments`（予定回）と `condition_events`（実績イベント）を参照する。

## 1. 挙動と安全性

- 対象は本番`legalbridge`の既存テーブル（**スキーマ/template変更なし**）。読取のみ、書込みなし。
- ランタイム `legalbridge_v2_runtime` に両テーブルの `SELECT` 権限が無い場合、**消化パネルは非表示になるだけ**（詳細の他項目は従来どおり表示。`42501` を握りつぶして graceful degrade）。GRANT適用後に表示される。
- デプロイのゲート・スコープ追加は不要（読取のため）。

## 2. 算出

- 予定総額 = Σ `condition_line_installments.planned_amount_ex_tax`
- 消化実績 = Σ `condition_events.amount_ex_tax`（`voided_at IS NULL`）
- 残高 = 予定総額 − 消化実績
- 検収 = 予定回に `trigger_kind='on_inspection'` があり（必要）、`condition_events.event_type='inspection'` があれば「検収済み」、無ければ「検収待ち」、`on_inspection` が無ければ「不要」
- 各回の「精算済/未精算」= その回を参照する非voidイベントの有無

## 3. 有効化：GRANT（011）

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/011_production_condition_settlement_preflight.sql
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_condition_settlement_grants=GRANT_PRODUCTION_CONDITION_SETTLEMENT \
  -f infra/gcp/sql/011_production_condition_settlement_grants.sql
```

再デプロイは不要（既に稼働中のリビジョンが、GRANT適用後は自動でSELECT可能になり消化パネルが表示される）。

## 4. 参照

- [条件明細（横断検索・検収待ち・詳細）](../apps/legalbridge/src/client/ConditionLinesWorkspace.tsx)
- [契約取込デプロイ手順](contract-intake-deploy.md)
