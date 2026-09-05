-- 014_production_request_workflow_verify_studio.sql
-- Cloud SQL Studio compatible / READ ONLY.
SELECT table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN (
    'legal_requests','matter_issues','matters','matter_overview_v','documents',
    'document_drafts','works','work_materials','condition_lines','contracts',
    'contract_works','work_relations','vendors'
  )
GROUP BY table_name
ORDER BY table_name;

SELECT
  has_table_privilege('legalbridge_v2_runtime','public.legal_requests','SELECT') AS request_read,
  has_table_privilege('legalbridge_v2_runtime','public.matter_issues','SELECT') AS matter_issue_read,
  has_table_privilege('legalbridge_v2_runtime','public.matter_issues','INSERT') AS matter_issue_insert,
  has_table_privilege('legalbridge_v2_runtime','public.matter_issues','UPDATE') AS matter_issue_update,
  has_table_privilege('legalbridge_v2_runtime','public.works','SELECT') AS works_read,
  has_table_privilege('legalbridge_v2_runtime','public.condition_lines','SELECT') AS conditions_read,
  has_table_privilege('legalbridge_v2_runtime','public.contracts','SELECT') AS contracts_read,
  has_table_privilege('legalbridge_v2_runtime','public.document_drafts','INSERT') AS draft_insert;
