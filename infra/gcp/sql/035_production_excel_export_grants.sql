\set ON_ERROR_STOP on
\pset pager off

-- 035_production_excel_export_grants.sql
-- Excel 一括出力の「発行済み」台帳（Phase 10-5）。V1 は documents.excel_issued_at 列で管理するが、
-- V2 は本番列を更新せず隔離台帳 lb_v2_excel_export_ledger（document_number 一意・append-only）で
-- 発行済みを記録する（保留一覧から除外するため）。SELECT/INSERT のみ・破壊操作なし。

\if :{?confirm_excel_export}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_excel_export=GRANT_PRODUCTION_EXCEL_EXPORT'
  \quit 2
\endif

SELECT :'confirm_excel_export' = 'GRANT_PRODUCTION_EXCEL_EXPORT' AS confirmed
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
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.lb_v2_excel_export_ledger (
  id               bigserial PRIMARY KEY,
  document_number  varchar(120) NOT NULL,
  batch_key        text,
  exported_by      varchar(200) NOT NULL,
  exported_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lb_v2_excel_export_ledger_uq
  ON public.lb_v2_excel_export_ledger (document_number);

COMMENT ON TABLE public.lb_v2_excel_export_ledger IS
  'Phase 10 Excel 一括出力の発行済み台帳（append-only・document_number 一意）。';

REVOKE ALL ON TABLE public.lb_v2_excel_export_ledger FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_excel_export_ledger_id_seq FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT ON TABLE
  public.lb_v2_excel_export_ledger
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_excel_export_ledger_id_seq
TO legalbridge_v2_runtime;

COMMIT;
