\set ON_ERROR_STOP on
\pset pager off

BEGIN READ ONLY;

SELECT
  current_database() AS database_name,
  current_user AS connected_user,
  current_setting('transaction_read_only') AS transaction_read_only;

SELECT
  rolname,
  rolcanlogin,
  rolsuper,
  rolcreaterole,
  rolcreatedb,
  rolreplication,
  rolbypassrls
FROM pg_roles
WHERE rolname = 'legalbridge_v2_runtime';

SELECT
  to_regclass('public.lb_v2_slack_notification_history') AS history_table,
  to_regclass('public.lb_v2_slack_notification_approvals') AS approvals_table;

SELECT
  grantee,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'legalbridge_v2_runtime'
ORDER BY table_name, privilege_type;

SELECT
  table_schema,
  table_name,
  privilege_type AS unexpected_privilege
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND (
    table_schema <> 'public'
    OR table_name NOT IN (
      'document_drafts',
      'document_sequences',
      'document_template_versions',
      'document_templates',
      'documents',
      'vendors',
      'staff',
      'works',
      'source_ips',
      'matters',
      'matter_issues',
      'matter_tasks',
      'matter_overview_v',
      'condition_lines',
      'work_materials',
      'material_categories',
      'material_rights_sources',
      'contracts',
      'contract_works',
      'work_relations',
      'condition_line_regions',
      'condition_line_languages',
      'lb_v2_slack_notification_history',
      'lb_v2_slack_notification_approvals'
    )
    OR privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')
    OR (
      table_name IN (
        'document_template_versions',
        'document_templates',
        'vendors',
        'staff',
        'source_ips',
        'matters',
        'matter_issues',
        'matter_tasks',
        'matter_overview_v'
      )
      AND privilege_type <> 'SELECT'
    )
    OR (
      table_name IN (
        'documents',
        'condition_lines',
        'works',
        'work_materials',
        'material_categories',
        'material_rights_sources',
        'contracts',
        'contract_works',
        'work_relations',
        'condition_line_regions',
        'condition_line_languages',
        'lb_v2_slack_notification_history',
        'lb_v2_slack_notification_approvals'
      )
      AND privilege_type NOT IN ('SELECT', 'INSERT')
    )
    OR (
      table_name = 'document_sequences'
      AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')
    )
    OR (
      table_name = 'document_drafts'
      AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    )
  )
ORDER BY table_schema, table_name, privilege_type;

SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime')
    THEN has_database_privilege('legalbridge_v2_runtime', 'legalbridge', 'CONNECT')
    ELSE false END AS can_connect,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime')
    THEN has_schema_privilege('legalbridge_v2_runtime', 'public', 'USAGE')
    ELSE false END AS can_use_public_schema,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime')
    THEN has_sequence_privilege('legalbridge_v2_runtime', 'public.documents_id_seq', 'USAGE')
    ELSE false END AS can_use_documents_sequence,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime')
    THEN has_sequence_privilege('legalbridge_v2_runtime', 'public.condition_lines_id_seq', 'USAGE')
    ELSE false END AS can_use_condition_lines_sequence;

SELECT
  c.relname AS table_name,
  i.relname AS index_name,
  ix.indisunique AS unique,
  ix.indisvalid AS valid
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'lb_v2_slack_notification_history',
    'lb_v2_slack_notification_approvals'
  )
ORDER BY c.relname, i.relname;

ROLLBACK;
