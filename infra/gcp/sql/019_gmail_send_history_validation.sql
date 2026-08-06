\set ON_ERROR_STOP on
\pset pager off

-- 019_gmail_send_history_validation.sql
-- Gmail 送信の冪等強制のための append 専用履歴（Slack 001 相当）。
--   隔離検証DB（legalbridge_v2_validation）に lb_v2_ 接頭辞のテーブルを作成し、
--   既存業務テーブルとは完全に分離する。idempotency_key を一意キーに、
--   送信成功を1件だけ記録する（再POSTは実送信をスキップ）。
--   付与は SELECT / INSERT のみ。UPDATE / DELETE / TRUNCATE は与えない。
-- 本番(legalbridge)への適用は Phase 7 カットオーバー時に別ファイルで実施する。

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION
      'Gmail send-history migration is validation-only; current database is %',
      current_database();
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS lb_v2_gmail_send_history (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key CHAR(64) NOT NULL
    CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  document_id BIGINT NOT NULL,
  recipient TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL DEFAULT current_user
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_gmail_send_history_idempotency_uq
  ON lb_v2_gmail_send_history (idempotency_key);

CREATE INDEX IF NOT EXISTS
  lb_v2_gmail_send_history_document_recorded_idx
  ON lb_v2_gmail_send_history (document_id, recorded_at DESC);

COMMENT ON TABLE lb_v2_gmail_send_history IS
  'LegalBridge V2 append-only Gmail send history for idempotency; isolated from existing business tables.';

REVOKE UPDATE, DELETE, TRUNCATE
  ON lb_v2_gmail_send_history
  FROM legalbridge_v2_validation_writer;

GRANT SELECT, INSERT
  ON lb_v2_gmail_send_history
  TO legalbridge_v2_validation_writer;

GRANT USAGE, SELECT
  ON SEQUENCE lb_v2_gmail_send_history_id_seq
  TO legalbridge_v2_validation_writer;

COMMIT;
