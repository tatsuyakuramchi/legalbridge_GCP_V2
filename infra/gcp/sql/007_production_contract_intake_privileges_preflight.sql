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

WITH expected(table_name, privilege_type) AS (
  VALUES
    ('vendors', 'SELECT'),
    ('works', 'SELECT'),
    ('works', 'INSERT'),
    ('work_materials', 'SELECT'),
    ('work_materials', 'INSERT'),
    ('material_categories', 'SELECT'),
    ('material_categories', 'INSERT'),
    ('material_rights_sources', 'SELECT'),
    ('material_rights_sources', 'INSERT'),
    ('contracts', 'SELECT'),
    ('contracts', 'INSERT'),
    ('contract_works', 'SELECT'),
    ('contract_works', 'INSERT'),
    ('work_relations', 'SELECT'),
    ('work_relations', 'INSERT'),
    ('condition_line_regions', 'SELECT'),
    ('condition_line_regions', 'INSERT'),
    ('condition_line_languages', 'SELECT'),
    ('condition_line_languages', 'INSERT'),
    ('documents', 'SELECT'),
    ('documents', 'INSERT'),
    ('condition_lines', 'SELECT'),
    ('condition_lines', 'INSERT'),
    ('document_sequences', 'SELECT'),
    ('document_sequences', 'INSERT'),
    ('document_sequences', 'UPDATE')
)
SELECT
  table_name,
  privilege_type,
  has_table_privilege(
    'legalbridge_v2_runtime',
    format('public.%I', table_name),
    privilege_type
  ) AS granted
FROM expected
ORDER BY table_name, privilege_type;

SELECT
  table_name,
  privilege_type AS forbidden_privilege
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN (
    'works',
    'work_materials',
    'material_categories',
    'material_rights_sources',
    'contracts',
    'contract_works',
    'work_relations',
    'condition_line_regions',
    'condition_line_languages'
  )
  AND privilege_type NOT IN ('SELECT', 'INSERT')
ORDER BY table_name, privilege_type;

WITH expected(sequence_name) AS (
  VALUES
    ('works_id_seq'),
    ('work_materials_id_seq'),
    ('material_categories_id_seq'),
    ('material_rights_sources_id_seq'),
    ('contracts_id_seq'),
    ('contract_works_id_seq'),
    ('work_relations_id_seq'),
    ('condition_line_regions_id_seq'),
    ('condition_line_languages_id_seq')
)
SELECT
  sequence_name,
  has_sequence_privilege(
    'legalbridge_v2_runtime',
    format('public.%I', sequence_name),
    'USAGE'
  ) AS usage_granted,
  has_sequence_privilege(
    'legalbridge_v2_runtime',
    format('public.%I', sequence_name),
    'SELECT'
  ) AS select_granted
FROM expected
ORDER BY sequence_name;

SELECT
  has_function_privilege(
    'legalbridge_v2_runtime',
    'public.lb_norm_name(text)',
    'EXECUTE'
  ) AS can_normalize_duplicate_names;

SELECT
  has_database_privilege(
    'legalbridge_v2_runtime', 'legalbridge', 'CONNECT'
  ) AS can_connect,
  has_schema_privilege(
    'legalbridge_v2_runtime', 'public', 'USAGE'
  ) AS can_use_public_schema;

ROLLBACK;
