-- 201_lookup_indexes.sql を戻す（足した索引を外す。データは触らない）。
\set ON_ERROR_STOP on
BEGIN;
DROP INDEX IF EXISTS v3.conditions_agreement_idx;
DROP INDEX IF EXISTS v3.conditions_series_root_idx;
DROP INDEX IF EXISTS v3.payment_allocations_condition_idx;
DROP INDEX IF EXISTS v3.payment_allocations_event_idx;
DROP INDEX IF EXISTS v3.document_conditions_condition_idx;
DROP INDEX IF EXISTS v3.condition_events_document_idx;
DROP INDEX IF EXISTS v3.condition_events_schedule_idx;
DROP INDEX IF EXISTS v3.documents_agreement_idx;
DROP INDEX IF EXISTS v3.documents_supersedes_idx;
DROP INDEX IF EXISTS v3.agreements_party_idx;
DROP INDEX IF EXISTS v3.agreements_parent_idx;
DROP INDEX IF EXISTS v3.matter_links_target_idx;
COMMIT;
