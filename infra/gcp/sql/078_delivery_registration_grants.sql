-- 078_delivery_registration_grants.sql
-- 案件画面からの納品実績登録（delivery_events INSERT/UPDATE）の実行ロール権限。
-- Cloud SQL Studio（postgres・DB legalbridge）で実行。冪等。
-- 支払（payments）は grant 016（016_production_payment_ledger_grants.sql）で付与済みの前提。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.delivery_events') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.delivery_events is missing';
  END IF;
END
$guard$;

GRANT SELECT, INSERT, UPDATE ON TABLE public.delivery_events TO legalbridge_v2_runtime;
GRANT SELECT ON TABLE public.matter_issues TO legalbridge_v2_runtime;

-- id の採番シーケンス（名前は環境で異なり得るため動的に解決）。
DO $seq$
DECLARE seq_name text;
BEGIN
  seq_name := pg_get_serial_sequence('public.delivery_events', 'id');
  IF seq_name IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO legalbridge_v2_runtime', seq_name);
  END IF;
END
$seq$;
COMMIT;

-- 確認（すべて true なら OK）。
SELECT
  has_table_privilege('legalbridge_v2_runtime', 'public.delivery_events', 'INSERT') AS delivery_insert,
  has_table_privilege('legalbridge_v2_runtime', 'public.delivery_events', 'UPDATE') AS delivery_update,
  has_table_privilege('legalbridge_v2_runtime', 'public.payments', 'INSERT') AS payments_insert,
  has_table_privilege('legalbridge_v2_runtime', 'public.payments', 'UPDATE') AS payments_update;
