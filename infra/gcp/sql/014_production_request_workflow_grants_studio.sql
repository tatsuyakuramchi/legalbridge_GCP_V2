-- 014_production_request_workflow_grants_studio.sql
-- Cloud SQL Studio compatible.
-- Request inbox / Request->Matter linkage / Work Rights / License Settlement read access.
-- No DELETE. legal_requests remains read-only because Backlog sync is authoritative.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT ON TABLE
  public.legal_requests,
  public.matters,
  public.matter_issues,
  public.matter_overview_v,
  public.documents,
  public.document_drafts,
  public.works,
  public.work_materials,
  public.condition_lines,
  public.contracts,
  public.contract_works,
  public.work_relations,
  public.vendors
TO legalbridge_v2_runtime;

-- Request -> Matter relation is stored in the existing matter_issues table.
GRANT INSERT, UPDATE ON TABLE
  public.matter_issues
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.matter_issues_id_seq
TO legalbridge_v2_runtime;

COMMIT;
