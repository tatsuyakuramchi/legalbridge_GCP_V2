-- 027_deadline_runtime_grants_studio.sql
-- LegalBridge V2: read-only runtime privileges for the unified deadline feed.
-- Idempotent / Cloud SQL Studio compatible.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'legal_requests',
    'matters',
    'matter_tasks',
    'staff',
    'contracts',
    'documents',
    'vendors',
    'contract_works',
    'works',
    'condition_line_installments',
    'condition_events',
    'condition_lines',
    'delivery_events',
    'matter_issues',
    'payments'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required deadline relation public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT ON TABLE
  public.legal_requests,
  public.matters,
  public.matter_tasks,
  public.staff,
  public.contracts,
  public.documents,
  public.vendors,
  public.contract_works,
  public.works,
  public.condition_line_installments,
  public.condition_events,
  public.condition_lines,
  public.delivery_events,
  public.matter_issues,
  public.payments
TO legalbridge_v2_runtime;

COMMIT;

-- Verification: all must be true.
SELECT
  has_table_privilege('legalbridge_v2_runtime','public.legal_requests','SELECT') AS legal_requests_ok,
  has_table_privilege('legalbridge_v2_runtime','public.matters','SELECT') AS matters_ok,
  has_table_privilege('legalbridge_v2_runtime','public.matter_tasks','SELECT') AS matter_tasks_ok,
  has_table_privilege('legalbridge_v2_runtime','public.staff','SELECT') AS staff_ok,
  has_table_privilege('legalbridge_v2_runtime','public.contracts','SELECT') AS contracts_ok,
  has_table_privilege('legalbridge_v2_runtime','public.documents','SELECT') AS documents_ok,
  has_table_privilege('legalbridge_v2_runtime','public.vendors','SELECT') AS vendors_ok,
  has_table_privilege('legalbridge_v2_runtime','public.contract_works','SELECT') AS contract_works_ok,
  has_table_privilege('legalbridge_v2_runtime','public.works','SELECT') AS works_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_line_installments','SELECT') AS installments_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_events','SELECT') AS condition_events_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_lines','SELECT') AS condition_lines_ok,
  has_table_privilege('legalbridge_v2_runtime','public.delivery_events','SELECT') AS delivery_events_ok,
  has_table_privilege('legalbridge_v2_runtime','public.matter_issues','SELECT') AS matter_issues_ok,
  has_table_privilege('legalbridge_v2_runtime','public.payments','SELECT') AS payments_ok;
