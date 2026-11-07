-- =====================================================================
-- 201_lookup_indexes.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   よく使う絞り込みに索引を足す（軽量化。infra/v3/diag/table-weight.sql の結果から）。
--   本番の統計で、行数の少ない表がとても多く全件読みされていた（2026-11-07 時点）：
--     conditions 1,137 行に 4,765 万回、payment_allocations 3,680 行に 400 万回、
--     condition_events 4,141 行に 387 万回、documents 1,187 行に 110 万回、agreements 516 行に 34 万回。
--   行ごとの副問い合わせの中で「条件 → 契約」「改訂の系列」「割当 → 実績」などを毎回全件で探していた。
--
--   足す索引（どれも小さい。全部で 1MB 未満）
--     conditions           … agreement_id／改訂の系列 COALESCE(series_id, id)
--     payment_allocations  … condition_id／event_id
--     document_conditions  … condition_id（主キーは document_id が先なので、条件からは引けない）
--     condition_events     … document_id／schedule_id
--     documents            … agreement_id／supersedes_id
--     agreements           … counterparty_id／parent_id
--     matter_links         … (target_type, target_ref)（一意制約は matter_id が先）
--
--   表が小さいので、作るあいだの書き込みの待ちは一瞬。何度流しても同じ結果。
--   戻すときは 201_lookup_indexes_rollback.sql。効き目は Cloud SQL の Query Insights で前後を比べる。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

CREATE INDEX IF NOT EXISTS conditions_agreement_idx ON v3.conditions (agreement_id) WHERE agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conditions_series_root_idx ON v3.conditions ((COALESCE(series_id, id)));
CREATE INDEX IF NOT EXISTS payment_allocations_condition_idx ON v3.payment_allocations (condition_id);
CREATE INDEX IF NOT EXISTS payment_allocations_event_idx ON v3.payment_allocations (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_conditions_condition_idx ON v3.document_conditions (condition_id);
CREATE INDEX IF NOT EXISTS condition_events_document_idx ON v3.condition_events (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS condition_events_schedule_idx ON v3.condition_events (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_agreement_idx ON v3.documents (agreement_id) WHERE agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_supersedes_idx ON v3.documents (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agreements_party_idx ON v3.agreements (counterparty_id);
CREATE INDEX IF NOT EXISTS agreements_parent_idx ON v3.agreements (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS matter_links_target_idx ON v3.matter_links (target_type, target_ref);

COMMIT;

-- 新しい索引を使う見積りにするため、統計を取り直す（数秒）。
ANALYZE v3.conditions, v3.payment_allocations, v3.document_conditions, v3.condition_events,
        v3.documents, v3.agreements, v3.matter_links;
