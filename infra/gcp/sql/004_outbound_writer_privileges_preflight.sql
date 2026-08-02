\set ON_ERROR_STOP on
\pset pager off

BEGIN READ ONLY;

SELECT
  current_database() AS database_name,
  current_user AS connected_user,
  current_setting('server_version') AS server_version;

SELECT
  rolname,
  rolcanlogin,
  rolsuper,
  rolcreaterole,
  rolcreatedb,
  rolreplication,
  rolbypassrls
FROM pg_roles
WHERE rolname = 'legalbridge_v2_outbound_writer';

SELECT
  table_schema,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_outbound_writer'
  AND table_schema = 'public'
  AND table_name IN ('documents', 'works', 'vendors', 'condition_lines')
ORDER BY table_name, privilege_type;

SELECT
  sequence_schema,
  sequence_name,
  privilege_type
FROM information_schema.role_usage_grants
WHERE grantee = 'legalbridge_v2_outbound_writer'
  AND sequence_schema = 'public'
  AND sequence_name = 'condition_lines_id_seq'
ORDER BY privilege_type;

SELECT
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_outbound_writer')
    THEN has_database_privilege(
      'legalbridge_v2_outbound_writer',
      'legalbridge',
      'CONNECT'
    )
    ELSE false
  END AS can_connect,
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_outbound_writer')
    THEN has_schema_privilege(
      'legalbridge_v2_outbound_writer',
      'public',
      'USAGE'
    )
    ELSE false
  END AS can_use_public_schema,
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_outbound_writer')
    THEN has_sequence_privilege(
      'legalbridge_v2_outbound_writer',
      'public.condition_lines_id_seq',
      'USAGE'
    )
    ELSE false
  END AS can_use_condition_line_sequence;

SELECT
  table_schema,
  table_name,
  privilege_type AS unexpected_privilege
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_outbound_writer'
  AND (
    table_schema <> 'public'
    OR table_name NOT IN ('documents', 'works', 'vendors', 'condition_lines')
    OR privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
    OR (
      table_name IN ('documents', 'works', 'vendors')
      AND privilege_type <> 'SELECT'
    )
    OR (
      table_name = 'condition_lines'
      AND privilege_type NOT IN ('SELECT', 'INSERT')
    )
  )
ORDER BY table_schema, table_name, privilege_type;

ROLLBACK;
