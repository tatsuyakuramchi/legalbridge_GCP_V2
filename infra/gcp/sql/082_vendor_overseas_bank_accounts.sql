\set ON_ERROR_STOP on
\pset pager off

-- 082_vendor_overseas_bank_accounts.sql
-- 取引先の振込先を vendor_bank_accounts で国内/海外共通管理するため、
-- 既存の 1:N 口座テーブルへ海外送金用カラムを追加し、V2 runtime に最小権限を付与する。
--
-- 共有 DB の既存設計（LegalBridge_AI_GCP migration 0014）と同じカラム名・型を使用:
--   account_scope / swift_bic / iban / routing_number / account_holder_name /
--   bank_country / bank_address / currency / intermediary_bank_swift /
--   intermediary_bank_name
--
-- vendors.bank_* は既存帳票互換の「代表口座ミラー」として残す。
-- 海外固有値は vendor_bank_accounts の is_primary=true 行を正とする。
--
-- 実行:
--   psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
--     -v confirm_overseas_bank=ENABLE_VENDOR_OVERSEAS_BANK \
--     -f infra/gcp/sql/082_vendor_overseas_bank_accounts.sql

\if :{?confirm_overseas_bank}
\else
  \echo 'Run with: -v confirm_overseas_bank=ENABLE_VENDOR_OVERSEAS_BANK'
  \quit 2
\endif
SELECT :'confirm_overseas_bank' = 'ENABLE_VENDOR_OVERSEAS_BANK' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.vendors') IS NULL THEN
    RAISE EXCEPTION 'Relation public.vendors is missing';
  END IF;
  IF to_regclass('public.vendor_bank_accounts') IS NULL THEN
    RAISE EXCEPTION 'Relation public.vendor_bank_accounts is missing';
  END IF;
  IF to_regclass('public.vendor_bank_accounts_id_seq') IS NULL THEN
    RAISE EXCEPTION 'Sequence public.vendor_bank_accounts_id_seq is missing';
  END IF;
END
$guard$;

-- 適用前: 現行カラムを確認。ユーザー要求の「DB column 確認」を実行ログに残す。
SELECT ordinal_position, column_name, data_type, character_maximum_length,
       is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'vendor_bank_accounts'
 ORDER BY ordinal_position;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.vendor_bank_accounts
  ADD COLUMN IF NOT EXISTS account_scope VARCHAR(20) DEFAULT 'domestic',
  ADD COLUMN IF NOT EXISTS swift_bic VARCHAR(20),
  ADD COLUMN IF NOT EXISTS iban VARCHAR(64),
  ADD COLUMN IF NOT EXISTS routing_number VARCHAR(40),
  ADD COLUMN IF NOT EXISTS account_holder_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_country VARCHAR(2),
  ADD COLUMN IF NOT EXISTS bank_address TEXT,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS intermediary_bank_swift VARCHAR(20),
  ADD COLUMN IF NOT EXISTS intermediary_bank_name TEXT;

UPDATE public.vendor_bank_accounts
   SET account_scope = 'domestic'
 WHERE account_scope IS NULL;

-- V2 は既存口座を削除せず、primary 行を UPDATE または INSERT する。
-- DELETE は付与しない。
GRANT SELECT, INSERT, UPDATE ON TABLE public.vendor_bank_accounts
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE public.vendor_bank_accounts_id_seq
TO legalbridge_v2_runtime;

COMMIT;

-- 適用後: 必要な海外カラムの型・長さ・defaultを明示確認。
SELECT ordinal_position, column_name, data_type, character_maximum_length,
       is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'vendor_bank_accounts'
   AND column_name IN (
     'id', 'vendor_id', 'bank_name', 'branch_name', 'account_type',
     'account_number', 'account_holder_kana', 'is_primary',
     'account_scope', 'swift_bic', 'iban', 'routing_number',
     'account_holder_name', 'bank_country', 'bank_address', 'currency',
     'intermediary_bank_swift', 'intermediary_bank_name'
   )
 ORDER BY ordinal_position;

SELECT table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS runtime_privileges
  FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_v2_runtime'
   AND table_schema = 'public'
   AND table_name = 'vendor_bank_accounts'
 GROUP BY table_name;
