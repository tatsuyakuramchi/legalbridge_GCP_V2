\set ON_ERROR_STOP on
\pset pager off

\if :{?confirm_outbound_writer_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_outbound_writer_grants=GRANT_MINIMAL_OUTBOUND_WRITER'
  \quit 2
\endif

SELECT :'confirm_outbound_writer_grants' = 'GRANT_MINIMAL_OUTBOUND_WRITER' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no privileges were changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_outbound_writer'
  ) THEN
    RAISE EXCEPTION 'Role legalbridge_v2_outbound_writer does not exist';
  END IF;

  IF to_regclass('public.documents') IS NULL
     OR to_regclass('public.works') IS NULL
     OR to_regclass('public.vendors') IS NULL
     OR to_regclass('public.condition_lines') IS NULL
     OR to_regclass('public.condition_lines_id_seq') IS NULL THEN
    RAISE EXCEPTION 'Required outbound-condition tables or sequence are missing';
  END IF;
END
$guard$;

-- Cloud SQL's built-in postgres account is not a true PostgreSQL superuser.
-- It can remove CREATEDB and CREATEROLE from ordinary login roles, but it
-- cannot execute ALTER ROLE clauses that touch superuser-only attributes.
ALTER ROLE legalbridge_v2_outbound_writer
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_outbound_writer;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_outbound_writer;

GRANT SELECT ON TABLE
  public.documents,
  public.works,
  public.vendors
TO legalbridge_v2_outbound_writer;

GRANT SELECT, INSERT ON TABLE
  public.condition_lines
TO legalbridge_v2_outbound_writer;

GRANT USAGE, SELECT ON SEQUENCE
  public.condition_lines_id_seq
TO legalbridge_v2_outbound_writer;

COMMIT;
