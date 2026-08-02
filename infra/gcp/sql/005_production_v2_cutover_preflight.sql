\set ON_ERROR_STOP on
\pset pager off

BEGIN;

SELECT
  current_database() AS database_name,
  current_user AS connected_user,
  current_setting('server_version') AS server_version,
  current_setting('transaction_read_only') AS transaction_read_only;

CREATE TEMP TABLE expected_relations (
  relation_name text PRIMARY KEY,
  expected_kind text NOT NULL,
  usage_kind text NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO expected_relations (relation_name, expected_kind, usage_kind) VALUES
  ('document_drafts', 'table', 'V2 read/write'),
  ('document_sequences', 'table', 'V2 read/write'),
  ('document_template_versions', 'table', 'V2 read'),
  ('document_templates', 'table', 'V2 read'),
  ('documents', 'table', 'V2 read/write'),
  ('vendors', 'table', 'business read'),
  ('staff', 'table', 'business read'),
  ('works', 'table', 'business read'),
  ('source_ips', 'table', 'business read'),
  ('matters', 'table', 'business read'),
  ('matter_issues', 'table', 'business read'),
  ('matter_tasks', 'table', 'business read'),
  ('condition_lines', 'table', 'outbound read/write'),
  ('matter_overview_v', 'view', 'business read'),
  ('lb_v2_slack_notification_history', 'table', 'V2 Slack read/write'),
  ('lb_v2_slack_notification_approvals', 'table', 'V2 Slack read/write');

SELECT
  e.relation_name,
  e.expected_kind,
  e.usage_kind,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view'
    WHEN 'f' THEN 'foreign table'
    ELSE NULL
  END AS actual_kind,
  r.rolname AS owner,
  c.reltuples::bigint AS estimated_rows,
  c.oid IS NOT NULL AS exists
FROM expected_relations e
LEFT JOIN pg_namespace n
  ON n.nspname = 'public'
LEFT JOIN pg_class c
  ON c.relnamespace = n.oid
 AND c.relname = e.relation_name
LEFT JOIN pg_roles r
  ON r.oid = c.relowner
ORDER BY e.usage_kind, e.relation_name;

CREATE TEMP TABLE expected_columns (
  table_name text NOT NULL,
  column_name text NOT NULL,
  usage_kind text NOT NULL,
  PRIMARY KEY (table_name, column_name)
) ON COMMIT PRESERVE ROWS;

INSERT INTO expected_columns (table_name, column_name, usage_kind) VALUES
  ('document_drafts', 'id', 'draft write'),
  ('document_drafts', 'issue_key', 'draft write'),
  ('document_drafts', 'template_type', 'draft write'),
  ('document_drafts', 'form_data', 'draft write'),
  ('document_drafts', 'document_number', 'draft write'),
  ('document_drafts', 'updated_at', 'draft concurrency'),
  ('document_drafts', 'updated_by', 'draft audit'),
  ('document_sequences', 'kind', 'document numbering'),
  ('document_sequences', 'year', 'document numbering'),
  ('document_sequences', 'current_value', 'document numbering'),
  ('document_templates', 'template_key', 'template read'),
  ('document_templates', 'current_version_id', 'template read'),
  ('document_templates', 'label', 'template read'),
  ('document_templates', 'category', 'template read'),
  ('document_templates', 'kind', 'template read'),
  ('document_templates', 'is_active', 'template read'),
  ('document_templates', 'document_prefix', 'document numbering'),
  ('document_template_versions', 'id', 'template read'),
  ('document_template_versions', 'field_schema', 'template read'),
  ('document_template_versions', 'html_source', 'template render'),
  ('documents', 'id', 'document read/write'),
  ('documents', 'document_number', 'document read/write'),
  ('documents', 'issue_key', 'document write'),
  ('documents', 'template_type', 'document write'),
  ('documents', 'template_version_id', 'document write'),
  ('documents', 'form_data', 'document write'),
  ('documents', 'drive_link', 'document write'),
  ('documents', 'created_at', 'document write'),
  ('documents', 'created_by', 'document audit'),
  ('condition_lines', 'id', 'outbound write'),
  ('condition_lines', 'document_id', 'outbound write'),
  ('condition_lines', 'line_no', 'outbound write'),
  ('condition_lines', 'work_id', 'outbound write'),
  ('condition_lines', 'counterparty_vendor_id', 'outbound write'),
  ('condition_lines', 'transaction_kind', 'outbound write'),
  ('condition_lines', 'direction', 'outbound write'),
  ('condition_lines', 'condition_name', 'outbound write'),
  ('condition_lines', 'region_territory', 'outbound write'),
  ('condition_lines', 'region_language', 'outbound write'),
  ('condition_lines', 'exclusivity', 'outbound write'),
  ('condition_lines', 'sublicense_allowed', 'outbound write'),
  ('condition_lines', 'term_start', 'outbound write'),
  ('condition_lines', 'term_end', 'outbound write'),
  ('condition_lines', 'currency', 'outbound write'),
  ('condition_lines', 'payment_scheme', 'outbound write'),
  ('condition_lines', 'rate_pct', 'outbound write'),
  ('condition_lines', 'amount_ex_tax', 'outbound write'),
  ('condition_lines', 'mg_amount', 'outbound write'),
  ('condition_lines', 'ag_amount', 'outbound write'),
  ('condition_lines', 'cycle', 'outbound write'),
  ('condition_lines', 'payment_terms', 'outbound write'),
  ('condition_lines', 'royalty_base', 'outbound write'),
  ('condition_lines', 'incoterms', 'outbound write'),
  ('condition_lines', 'minimum_quantity', 'outbound write'),
  ('condition_lines', 'sell_off_months', 'outbound write'),
  ('condition_lines', 'withholding_tax_treatment', 'outbound write'),
  ('condition_lines', 'notes', 'outbound write');

COMMIT;
BEGIN READ ONLY;

SELECT
  e.table_name,
  e.column_name,
  e.usage_kind,
  c.data_type,
  c.is_nullable,
  c.column_default,
  c.column_name IS NOT NULL AS exists
FROM expected_columns e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
ORDER BY e.table_name, e.column_name;

SELECT
  e.table_name,
  e.column_name AS missing_column,
  e.usage_kind
FROM expected_columns e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
WHERE c.column_name IS NULL
ORDER BY e.table_name, e.column_name;

SELECT format(
  'SELECT %L AS relation_name, count(*) AS exact_rows FROM public.%I;',
  e.relation_name,
  e.relation_name
)
FROM expected_relations e
WHERE e.expected_kind = 'table'
  AND to_regclass(format('public.%I', e.relation_name)) IS NOT NULL
ORDER BY e.relation_name
\gexec

SELECT format(
  'SELECT %L AS duplicate_check, count(*) AS duplicate_groups FROM (' ||
  'SELECT %s FROM public.%I GROUP BY %s HAVING count(*) > 1' ||
  ') duplicates;',
  check_name,
  columns,
  table_name,
  columns
)
FROM (VALUES
  ('document_drafts(issue_key,template_type)', 'document_drafts', 'issue_key, template_type'),
  ('document_sequences(kind,year)', 'document_sequences', 'kind, year'),
  ('document_templates(template_key)', 'document_templates', 'template_key'),
  ('documents(document_number)', 'documents', 'document_number'),
  ('condition_lines(document_id,line_no)', 'condition_lines', 'document_id, line_no')
) checks(check_name, table_name, columns)
WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL
ORDER BY check_name
\gexec

SELECT
  t.relname AS table_name,
  c.conname AS constraint_name,
  c.contype AS constraint_type,
  c.convalidated AS validated,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname IN (
    'document_drafts',
    'document_sequences',
    'document_templates',
    'document_template_versions',
    'documents',
    'condition_lines'
  )
ORDER BY t.relname, c.contype, c.conname;

SELECT
  seq_ns.nspname AS sequence_schema,
  seq.relname AS sequence_name,
  table_ns.nspname AS owned_table_schema,
  table_rel.relname AS owned_table,
  attr.attname AS owned_column
FROM pg_class seq
JOIN pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
LEFT JOIN pg_depend dep
  ON dep.objid = seq.oid
 AND dep.deptype IN ('a', 'i')
LEFT JOIN pg_class table_rel ON table_rel.oid = dep.refobjid
LEFT JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
LEFT JOIN pg_attribute attr
  ON attr.attrelid = table_rel.oid
 AND attr.attnum = dep.refobjsubid
WHERE seq.relkind = 'S'
  AND seq_ns.nspname = 'public'
  AND (
    table_rel.relname IN (
      'document_drafts',
      'document_sequences',
      'document_template_versions',
      'document_templates',
      'documents',
      'condition_lines'
    )
    OR seq.relname LIKE 'document%'
    OR seq.relname LIKE 'condition_lines%'
  )
ORDER BY seq.relname;

SELECT
  rolname,
  rolcanlogin,
  rolsuper,
  rolcreaterole,
  rolcreatedb,
  rolreplication,
  rolbypassrls
FROM pg_roles
WHERE rolname IN (
  'legalbridge',
  'legalbridge_v2_validation_writer',
  'legalbridge_v2_outbound_writer',
  'legalbridge_v2_runtime'
)
ORDER BY rolname;

SELECT
  grantee,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN (
    'legalbridge',
    'legalbridge_v2_validation_writer',
    'legalbridge_v2_outbound_writer',
    'legalbridge_v2_runtime'
  )
  AND table_name IN (SELECT relation_name FROM expected_relations)
ORDER BY grantee, table_name, privilege_type;

SELECT
  pid,
  usename,
  application_name,
  client_addr,
  state,
  wait_event_type,
  wait_event,
  xact_start,
  LEFT(query, 160) AS query_sample
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
ORDER BY xact_start NULLS LAST, backend_start;

ROLLBACK;
