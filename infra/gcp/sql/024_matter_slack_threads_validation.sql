\set ON_ERROR_STOP on
\pset pager off

-- 024_matter_slack_threads_validation.sql
-- 案件ごとの Slack「法務相談」スレッド（1案件=1スレッド）。V1 の matter_slack_threads 相当。
--   隔離検証DB（legalbridge_v2_validation）に lb_v2_ 接頭辞で作成し、既存業務テーブルとは分離。
--   matter_id 一意（1案件1スレッド）。付与は SELECT / INSERT のみ（UPDATE/DELETE/TRUNCATE 無し）。
-- 本番(legalbridge)への適用は 024_..._production_grants.sql（別ファイル）。

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION
      'Matter Slack thread migration is validation-only; current database is %',
      current_database();
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS lb_v2_matter_slack_threads (
  id BIGSERIAL PRIMARY KEY,
  matter_id BIGINT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  root_text TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT current_user,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_matter_slack_threads_matter_uq
  ON lb_v2_matter_slack_threads (matter_id);

COMMENT ON TABLE lb_v2_matter_slack_threads IS
  'LegalBridge V2 per-matter Slack (legal-consult) thread pointer; one thread per matter. Isolated from existing business tables.';

REVOKE UPDATE, DELETE, TRUNCATE
  ON lb_v2_matter_slack_threads
  FROM legalbridge_v2_validation_writer;

GRANT SELECT, INSERT
  ON lb_v2_matter_slack_threads
  TO legalbridge_v2_validation_writer;

GRANT USAGE, SELECT
  ON SEQUENCE lb_v2_matter_slack_threads_id_seq
  TO legalbridge_v2_validation_writer;

COMMIT;
