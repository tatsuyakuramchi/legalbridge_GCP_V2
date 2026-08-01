BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION
      'Slack notification approval migration is validation-only; current database is %',
      current_database();
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS lb_v2_slack_notification_approvals (
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
  ON lb_v2_slack_notification_approvals
    (issue_key, recorded_at DESC, id DESC);

COMMENT ON TABLE lb_v2_slack_notification_approvals IS
  'LegalBridge V2 append-only Slack notification approval decisions; validation-only and isolated from existing business tables.';

REVOKE UPDATE, DELETE, TRUNCATE
  ON lb_v2_slack_notification_approvals
  FROM legalbridge_v2_validation_writer;

GRANT SELECT, INSERT
  ON lb_v2_slack_notification_approvals
  TO legalbridge_v2_validation_writer;

GRANT USAGE, SELECT
  ON SEQUENCE lb_v2_slack_notification_approvals_id_seq
  TO legalbridge_v2_validation_writer;

COMMIT;
