\set ON_ERROR_STOP on
\pset pager off

-- 020_inbound_contract_intake_validation.sql
-- Gmail 受信取込の登録台帳（閲覧/DLだけだった受信契約PDFを「取込済み」として恒久記録）。
--   隔離検証DB（legalbridge_v2_validation）に lb_v2_ 接頭辞のテーブルを作成し、
--   既存業務テーブル(documents 等)とは完全に分離する。
--   idempotency_key（message+attachment の指紋）を一意キーに、再取込を冪等化する。
--   付与は SELECT / INSERT / UPDATE（status 遷移）。DELETE / TRUNCATE は与えない。
-- 本番(legalbridge)への適用は Phase 7 カットオーバー時に別ファイルで実施する。

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION
      'Inbound-contract intake migration is validation-only; current database is %',
      current_database();
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS lb_v2_inbound_contracts (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key CHAR(64) NOT NULL
    CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  thread_id TEXT,
  filename TEXT NOT NULL,
  from_address TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ,
  drive_link TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'captured'
    CHECK (status IN ('captured', 'linked', 'dismissed')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_by TEXT NOT NULL DEFAULT current_user
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_inbound_contracts_idempotency_uq
  ON lb_v2_inbound_contracts (idempotency_key);

CREATE INDEX IF NOT EXISTS
  lb_v2_inbound_contracts_status_captured_idx
  ON lb_v2_inbound_contracts (status, captured_at DESC);

COMMENT ON TABLE lb_v2_inbound_contracts IS
  'LegalBridge V2 inbound contract intake ledger; isolated from existing business tables. Append + status transitions only.';

REVOKE DELETE, TRUNCATE
  ON lb_v2_inbound_contracts
  FROM legalbridge_v2_validation_writer;

GRANT SELECT, INSERT, UPDATE
  ON lb_v2_inbound_contracts
  TO legalbridge_v2_validation_writer;

GRANT USAGE, SELECT
  ON SEQUENCE lb_v2_inbound_contracts_id_seq
  TO legalbridge_v2_validation_writer;

COMMIT;
