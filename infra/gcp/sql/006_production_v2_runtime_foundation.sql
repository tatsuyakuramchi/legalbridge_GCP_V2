\set ON_ERROR_STOP on
\pset pager off

\if :{?confirm_production_v2_runtime}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_production_v2_runtime=CREATE_PRODUCTION_V2_RUNTIME_FOUNDATION'
  \quit 2
\endif

SELECT :'confirm_production_v2_runtime' = 'CREATE_PRODUCTION_V2_RUNTIME_FOUNDATION' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no schema or privileges were changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime'
  ) THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'document_drafts',
    'document_sequences',
    'document_template_versions',
    'document_templates',
    'documents',
    'vendors',
    'staff',
    'works',
    'source_ips',
    'matters',
    'matter_issues',
    'matter_tasks',
    'condition_lines',
    'matter_overview_v'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required production relation public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

CREATE TABLE IF NOT EXISTS public.lb_v2_slack_notification_history (
  id BIGSERIAL PRIMARY KEY,
  matter_id BIGINT NOT NULL,
  issue_key VARCHAR(100) NOT NULL,
  fingerprint CHAR(64) NOT NULL
    CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  requester_status VARCHAR(40) NOT NULL
    CHECK (requester_status IN (
      'intake',
      'information_required',
      'legal_review',
      'requester_review',
      'execution',
      'completed',
      'withdrawn'
    )),
  outcome VARCHAR(20) NOT NULL
    CHECK (outcome IN ('sent', 'acknowledged', 'failed', 'cancelled')),
  headline TEXT NOT NULL,
  trigger_detail TEXT,
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL DEFAULT current_user
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_slack_notification_history_delivered_uq
  ON public.lb_v2_slack_notification_history (issue_key, fingerprint)
  WHERE outcome IN ('sent', 'acknowledged');

CREATE INDEX IF NOT EXISTS
  lb_v2_slack_notification_history_issue_recorded_idx
  ON public.lb_v2_slack_notification_history (issue_key, recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.lb_v2_slack_notification_approvals (
  id BIGSERIAL PRIMARY KEY,
  matter_id BIGINT NOT NULL,
  issue_key VARCHAR(100) NOT NULL,
  fingerprint CHAR(64) NOT NULL
    CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  decision VARCHAR(20) NOT NULL
    CHECK (decision IN ('approved', 'revoked')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS
  lb_v2_slack_notification_approvals_issue_recorded_idx
  ON public.lb_v2_slack_notification_approvals
    (issue_key, recorded_at DESC, id DESC);

COMMENT ON TABLE public.lb_v2_slack_notification_history IS
  'LegalBridge V2 append-only Slack notification delivery history in the production business database.';

COMMENT ON TABLE public.lb_v2_slack_notification_approvals IS
  'LegalBridge V2 append-only Slack notification approval decisions in the production business database.';

REVOKE ALL ON TABLE
  public.lb_v2_slack_notification_history,
  public.lb_v2_slack_notification_approvals
FROM PUBLIC;

REVOKE ALL ON SEQUENCE
  public.lb_v2_slack_notification_history_id_seq,
  public.lb_v2_slack_notification_approvals_id_seq
FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT ON TABLE
  public.document_template_versions,
  public.document_templates,
  public.vendors,
  public.staff,
  public.works,
  public.source_ips,
  public.matters,
  public.matter_issues,
  public.matter_tasks,
  public.matter_overview_v
TO legalbridge_v2_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.document_drafts
TO legalbridge_v2_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.document_sequences
TO legalbridge_v2_runtime;

GRANT SELECT, INSERT ON TABLE
  public.documents,
  public.condition_lines,
  public.lb_v2_slack_notification_history,
  public.lb_v2_slack_notification_approvals
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.document_drafts_id_seq,
  public.documents_id_seq,
  public.condition_lines_id_seq,
  public.lb_v2_slack_notification_history_id_seq,
  public.lb_v2_slack_notification_approvals_id_seq
TO legalbridge_v2_runtime;

COMMIT;
