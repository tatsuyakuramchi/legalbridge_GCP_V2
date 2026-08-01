\set ON_ERROR_STOP on
\pset pager off

-- Read-only preflight for the outbound condition schema migration.
-- Run against the legalbridge database before applying 003.
BEGIN READ ONLY;

SELECT
  current_database() AS database_name,
  current_user AS connected_user,
  current_setting('server_version') AS server_version;

SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  owner_role.rolname AS owner,
  c.reltuples::bigint AS estimated_rows,
  current_user = owner_role.rolname
    OR pg_has_role(current_user, owner_role.oid, 'MEMBER') AS may_assume_owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles owner_role ON owner_role.oid = c.relowner
WHERE n.nspname = 'public'
  AND c.relname IN ('condition_lines', 'vendors')
ORDER BY c.relname;

SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'condition_lines'
  AND column_name IN (
    'direction',
    'transaction_kind',
    'counterparty_vendor_id',
    'exclusivity',
    'sublicense_allowed',
    'sell_off_months',
    'minimum_quantity',
    'incoterms',
    'withholding_tax_treatment',
    'royalty_base',
    'deductible_costs'
  )
ORDER BY column_name;

SELECT
  c.conname AS constraint_name,
  c.contype AS constraint_type,
  c.convalidated AS validated,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid = to_regclass('public.condition_lines')
  AND (
    c.conname = 'condition_lines_direction_check'
    OR c.conname = 'cl_transaction_kind_chk'
    OR c.conname LIKE 'condition_lines_%_ck'
  )
ORDER BY c.conname;

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'condition_lines'
  AND indexname IN (
    'condition_lines_outbound_kind_idx',
    'condition_lines_outbound_vendor_idx'
  )
ORDER BY indexname;

SELECT
  current_database() = 'legalbridge'
    AND to_regclass('public.condition_lines') IS NOT NULL
    AND to_regclass('public.vendors') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'condition_lines'
        AND column_name = 'transaction_kind'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'condition_lines'
        AND column_name = 'counterparty_vendor_id'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.condition_lines')
        AND conname = 'condition_lines_direction_check'
        AND pg_get_constraintdef(oid) LIKE '%receivable%'
    ) AS structurally_ready;

ROLLBACK;
