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

## 4. 重複計上の考え方と導線ガード

作品(works)には、業務委託などで作った**マテリアル由来の個別条件**（`condition_lines.source_material_id` 有り）と、作品レベルの**包括条件**（`source_material_id IS NULL`）が併存し得る。

- **方向が違えば二重計上ではない**：マテリアル由来（業務委託）は `payable`（コスト脚）、作品のライセンスアウト包括条件は `receivable`（収入脚）。集計は `direction` ごとに分かれるため、両方あってもコスト×収入の両建て。
- **同一方向を別建てで作ると合算される**：消化実績（本ページの集計）は `source_material_id` を区別せず同一方向の全行を合算する。`condition_lines` に親子（ロールアップ）FKが無いため、包括と個別の重複は自動排除されない。運用としては**別建てで加算**する前提。

そこで**作成導線で重複を可視化**する：

- `GET /api/v2/condition-lines/overlap?workId=<id>`（読取・grant不要）が、その作品に既に紐づく条件を向き別件数（受取/支払）と、作品レベル/マテリアル由来の区別付き一覧で返す。
- アウト条件フォーム（`OutboundConditionWorkspace`）で作品を選ぶと既存条件を提示し、同一方向（受取）が既にある場合は警告を表示する。ブロックはせず、担当者が二重登録を意識できるようにする。

## 5. 参照

- [条件明細（横断検索・検収待ち・詳細）](../apps/legalbridge/src/client/ConditionLinesWorkspace.tsx)
- [契約取込デプロイ手順](contract-intake-deploy.md)
