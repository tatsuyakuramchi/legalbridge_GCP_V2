\set ON_ERROR_STOP on
\pset pager off

-- 022_cloudsign_request_history_validation.sql
-- CloudSign 署名依頼の冪等履歴＋cloudSignDocumentId 永続化（Gmail 送信履歴 5-1 と同型）。
--   隔離検証DB（legalbridge_v2_validation）に lb_v2_ 接頭辞のテーブルを作成し、
--   既存業務テーブルとは完全に分離する。idempotency_key を一意キーに、二重依頼を防ぐ。
--   付与は SELECT / INSERT / UPDATE（status 反映）。DELETE / TRUNCATE は与えない。
-- 本番(legalbridge)への適用は 022_..._production_grants.sql（別ファイル）。

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION
      'CloudSign request-history migration is validation-only; current database is %',
      current_database();
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS lb_v2_cloudsign_requests (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key CHAR(64) NOT NULL
    CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  document_id BIGINT NOT NULL,
  cloud_sign_document_id TEXT NOT NULL,
  status TEXT NOT NULL,
  participant_count INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL DEFAULT current_user
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_cloudsign_requests_idempotency_uq
  ON lb_v2_cloudsign_requests (idempotency_key);

CREATE INDEX IF NOT EXISTS
  lb_v2_cloudsign_requests_document_recorded_idx
  ON lb_v2_cloudsign_requests (document_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS
  lb_v2_cloudsign_requests_csid_idx
  ON lb_v2_cloudsign_requests (cloud_sign_document_id);

COMMENT ON TABLE lb_v2_cloudsign_requests IS
  'LegalBridge V2 CloudSign signature-request ledger (idempotency + document-id persistence); isolated from existing business tables.';

REVOKE DELETE, TRUNCATE
  ON lb_v2_cloudsign_requests
  FROM legalbridge_v2_validation_writer;

GRANT SELECT, INSERT, UPDATE
  ON lb_v2_cloudsign_requests
  TO legalbridge_v2_validation_writer;

GRANT USAGE, SELECT
  ON SEQUENCE lb_v2_cloudsign_requests_id_seq
  TO legalbridge_v2_validation_writer;

COMMIT;
