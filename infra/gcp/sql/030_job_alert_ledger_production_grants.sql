\set ON_ERROR_STOP on
\pset pager off

-- 030_job_alert_ledger_production_grants.sql
-- 督促ジョブ（daily-checks・Phase 9-1b/9-2）の送信済み台帳。本番の業務テーブルを更新せず、
-- 「いつ・どの対象へ・どの種別のアラートを送ったか」を append-only で記録し同日重複を抑止する。
--   V1 の last_alert_at は互換ビューで NULL 固定＝現行スキーマに実在しないため、本台帳で代替する。
--   本ファイルは CREATE TABLE IF NOT EXISTS ＋ GRANT を自己完結で行う（冪等）。SELECT/INSERT のみ。
--   検証DB用は 030_job_alert_ledger_validation.sql（本番では使わない）。

\if :{?confirm_job_alert_ledger}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_job_alert_ledger=GRANT_PRODUCTION_JOB_ALERT_LEDGER'
  \quit 2
\endif

SELECT :'confirm_job_alert_ledger' = 'GRANT_PRODUCTION_JOB_ALERT_LEDGER' AS confirmed
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

CREATE TABLE IF NOT EXISTS public.lb_v2_job_alert_ledger (
  id          bigserial PRIMARY KEY,
  kind        varchar(40) NOT NULL,   -- delivery_7d / delivery_3d / delivery_1d / delivery_overdue / contract_renewal
  ref_type    varchar(20) NOT NULL,   -- condition_line / document
  ref_id      integer NOT NULL,
  alert_date  date NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 同日・同対象・同種別の二重記録を防ぐ（ON CONFLICT DO NOTHING で冪等）。
CREATE UNIQUE INDEX IF NOT EXISTS lb_v2_job_alert_ledger_uq
  ON public.lb_v2_job_alert_ledger (kind, ref_type, ref_id, alert_date);
CREATE INDEX IF NOT EXISTS lb_v2_job_alert_ledger_ref_idx
  ON public.lb_v2_job_alert_ledger (ref_type, ref_id, alert_date);

COMMENT ON TABLE public.lb_v2_job_alert_ledger IS
  'Phase 9 督促ジョブの送信済み台帳（append-only・同日重複抑止）。';

REVOKE ALL ON TABLE public.lb_v2_job_alert_ledger FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_job_alert_ledger_id_seq FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT ON TABLE
  public.lb_v2_job_alert_ledger
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_job_alert_ledger_id_seq
TO legalbridge_v2_runtime;

COMMIT;
