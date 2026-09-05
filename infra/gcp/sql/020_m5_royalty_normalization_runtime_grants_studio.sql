-- 020_m5_royalty_normalization_runtime_grants_studio.sql
-- LegalBridge V2 / M5 runtime grants
-- Cloud SQL Studio compatible.
--
-- Required for atomic dual-write when a royalty_statement document is finalized.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT ON TABLE
  public.documents,
  public.contracts,
  public.condition_lines,
  public.royalty_calculations,
  public.royalty_statements,
  public.royalty_statement_lines,
  public.manufacturing_events,
  public.sales_events,
  public.condition_receipts,
  public.condition_events
TO legalbridge_v2_runtime;

GRANT INSERT, UPDATE ON TABLE
  public.royalty_calculations,
  public.royalty_statements,
  public.royalty_statement_lines,
  public.manufacturing_events,
  public.sales_events,
  public.condition_receipts,
  public.condition_events
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.royalty_calculations_id_seq,
  public.royalty_statements_id_seq,
  public.royalty_statement_lines_id_seq,
  public.manufacturing_events_id_seq,
  public.sales_events_id_seq,
  public.condition_receipts_id_seq,
  public.condition_events_id_seq
TO legalbridge_v2_runtime;

COMMIT;
