-- 014_production_request_workflow_preflight_studio.sql
-- Cloud SQL Studio compatible / READ ONLY.
DO $guard$
DECLARE relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[
    'legal_requests','matters','matter_issues','matter_overview_v','documents',
    'works','work_materials','condition_lines','contracts','contract_works',
    'work_relations','vendors','document_drafts'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required relation public.% is missing', relation_name;
    END IF;
  END LOOP;
  IF to_regclass('public.matter_issues_id_seq') IS NULL THEN
    RAISE EXCEPTION 'Required sequence public.matter_issues_id_seq is missing';
  END IF;
END
$guard$;

SELECT table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN (
    'legal_requests','matters','matter_issues','matter_overview_v','documents',
    'works','work_materials','condition_lines','contracts','contract_works',
    'work_relations','vendors','document_drafts'
  )
GROUP BY table_name
ORDER BY table_name;

SELECT
  (SELECT COUNT(*) FROM legal_requests) AS legal_requests,
  (SELECT COUNT(*) FROM matter_issues) AS matter_issues,
  (SELECT COUNT(*) FROM works) AS works,
  (SELECT COUNT(*) FROM condition_lines) AS condition_lines,
  (SELECT COUNT(*) FROM contracts) AS contracts,
  (SELECT COUNT(*) FROM document_drafts) AS document_drafts;
