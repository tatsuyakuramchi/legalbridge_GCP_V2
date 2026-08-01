BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION
      'Slack notification history migration is validation-only; current database is %',
      current_database();
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS lb_v2_slack_notification_history (
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
  ON lb_v2_slack_notification_history (issue_key, fingerprint)
  WHERE outcome IN ('sent', 'acknowledged');

CREATE INDEX IF NOT EXISTS
  lb_v2_slack_notification_history_issue_recorded_idx
  ON lb_v2_slack_notification_history (issue_key, recorded_at DESC);

COMMENT ON TABLE lb_v2_slack_notification_history IS
  'LegalBridge V2 append-only Slack notification delivery history; isolated from existing business tables.';

REVOKE UPDATE, DELETE, TRUNCATE
  ON lb_v2_slack_notification_history
  FROM legalbridge_v2_validation_writer;

GRANT SELECT, INSERT
  ON lb_v2_slack_notification_history
  TO legalbridge_v2_validation_writer;

GRANT USAGE, SELECT
  ON SEQUENCE lb_v2_slack_notification_history_id_seq
  TO legalbridge_v2_validation_writer;

COMMIT;
