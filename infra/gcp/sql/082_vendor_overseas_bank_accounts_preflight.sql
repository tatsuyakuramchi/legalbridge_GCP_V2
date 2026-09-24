\set ON_ERROR_STOP on
\pset pager off

-- 082_vendor_overseas_bank_accounts_preflight.sql
-- 海外銀行対応前の read-only DB確認。
-- 変更は一切行わず、共有DBに vendor_bank_accounts と必要列があるかを表示する。

SELECT current_database() AS current_database,
       current_user AS current_user,
       current_setting('transaction_read_only') AS transaction_read_only;

SELECT to_regclass('public.vendors') AS vendors_table,
       to_regclass('public.vendor_bank_accounts') AS vendor_bank_accounts_table,
       to_regclass('public.vendor_bank_accounts_id_seq') AS vendor_bank_accounts_sequence;

SELECT ordinal_position, column_name, data_type, character_maximum_length,
       is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'vendor_bank_accounts'
 ORDER BY ordinal_position;

WITH required(column_name, expected_type, expected_length) AS (
  VALUES
    ('account_scope', 'character varying', 20),
    ('swift_bic', 'character varying', 20),
    ('iban', 'character varying', 64),
    ('routing_number', 'character varying', 40),
    ('account_holder_name', 'text', NULL::integer),
    ('bank_country', 'character varying', 2),
    ('bank_address', 'text', NULL::integer),
    ('currency', 'character varying', 3),
    ('intermediary_bank_swift', 'character varying', 20),
    ('intermediary_bank_name', 'text', NULL::integer)
)
SELECT r.column_name,
       c.data_type AS actual_type,
       c.character_maximum_length AS actual_length,
       CASE
         WHEN c.column_name IS NULL THEN 'MISSING'
         WHEN c.data_type <> r.expected_type THEN 'TYPE_MISMATCH'
         WHEN r.expected_length IS NOT NULL
              AND c.character_maximum_length IS DISTINCT FROM r.expected_length THEN 'LENGTH_MISMATCH'
         ELSE 'OK'
       END AS status
  FROM required r
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = 'vendor_bank_accounts'
   AND c.column_name = r.column_name
 ORDER BY r.column_name;

SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name = 'vendor_bank_accounts'
   AND grantee = 'legalbridge_v2_runtime'
 ORDER BY privilege_type;
