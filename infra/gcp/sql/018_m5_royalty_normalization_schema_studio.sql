-- 018_m5_royalty_normalization_schema_studio.sql
-- LegalBridge V2 / M5 Royalty normalization schema extension
-- Cloud SQL Studio compatible.
--
-- Non-destructive:
--   - Reuses existing M5 tables.
--   - Adds only missing linkage / provenance columns and indexes.
--   - Does not delete or rewrite existing royalty/payment rows.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
END
$guard$;

ALTER TABLE royalty_calculations
  ADD COLUMN IF NOT EXISTS document_id integer,
  ADD COLUMN IF NOT EXISTS source_out_condition_line_id integer,
  ADD COLUMN IF NOT EXISTS basis_amount numeric,
  ADD COLUMN IF NOT EXISTS deductions numeric,
  ADD COLUMN IF NOT EXISTS event_type character varying,
  ADD COLUMN IF NOT EXISTS occurred_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS source_form_data jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

ALTER TABLE royalty_statements
  ADD COLUMN IF NOT EXISTS document_id integer,
  ADD COLUMN IF NOT EXISTS source_condition_line_id integer,
  ADD COLUMN IF NOT EXISTS source_out_condition_line_id integer,
  ADD COLUMN IF NOT EXISTS event_type character varying,
  ADD COLUMN IF NOT EXISTS occurred_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS basis_amount numeric,
  ADD COLUMN IF NOT EXISTS deductions numeric,
  ADD COLUMN IF NOT EXISTS source_form_data jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

ALTER TABLE royalty_statement_lines
  ADD COLUMN IF NOT EXISTS royalty_statement_id integer,
  ADD COLUMN IF NOT EXISTS basis_note text,
  ADD COLUMN IF NOT EXISTS source_condition_line_id integer,
  ADD COLUMN IF NOT EXISTS source_out_condition_line_id integer,
  ADD COLUMN IF NOT EXISTS gross_event_amount numeric,
  ADD COLUMN IF NOT EXISTS deductions numeric,
  ADD COLUMN IF NOT EXISTS source_json jsonb;

ALTER TABLE manufacturing_events
  ADD COLUMN IF NOT EXISTS source_document_id integer,
  ADD COLUMN IF NOT EXISTS source_condition_line_id integer;

ALTER TABLE sales_events
  ADD COLUMN IF NOT EXISTS source_document_id integer,
  ADD COLUMN IF NOT EXISTS source_condition_line_id integer;

ALTER TABLE condition_receipts
  ADD COLUMN IF NOT EXISTS source_document_id integer;

ALTER TABLE royalty_payments
  ADD COLUMN IF NOT EXISTS payment_id integer;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS legacy_royalty_payment_id integer;

-- Idempotent canonical links.
CREATE UNIQUE INDEX IF NOT EXISTS uq_royalty_calculations_document
  ON royalty_calculations(document_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_royalty_statements_document
  ON royalty_statements(document_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_royalty_statement_lines_statement_line
  ON royalty_statement_lines(royalty_statement_id, line_no);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manufacturing_events_source_document
  ON manufacturing_events(source_document_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_events_source_document
  ON sales_events(source_document_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_condition_receipts_source_document
  ON condition_receipts(source_document_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_legacy_royalty_payment
  ON payments(legacy_royalty_payment_id);

-- FK helpers; NOT VALID avoids blocking on unrelated legacy rows.
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_calculations_document_id_fkey') THEN
    ALTER TABLE royalty_calculations
      ADD CONSTRAINT royalty_calculations_document_id_fkey
      FOREIGN KEY (document_id) REFERENCES documents(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_calculations_source_out_condition_line_id_fkey') THEN
    ALTER TABLE royalty_calculations
      ADD CONSTRAINT royalty_calculations_source_out_condition_line_id_fkey
      FOREIGN KEY (source_out_condition_line_id) REFERENCES condition_lines(id) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_statements_document_id_fkey') THEN
    ALTER TABLE royalty_statements
      ADD CONSTRAINT royalty_statements_document_id_fkey
      FOREIGN KEY (document_id) REFERENCES documents(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_statements_source_condition_line_id_fkey') THEN
    ALTER TABLE royalty_statements
      ADD CONSTRAINT royalty_statements_source_condition_line_id_fkey
      FOREIGN KEY (source_condition_line_id) REFERENCES condition_lines(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_statements_source_out_condition_line_id_fkey') THEN
    ALTER TABLE royalty_statements
      ADD CONSTRAINT royalty_statements_source_out_condition_line_id_fkey
      FOREIGN KEY (source_out_condition_line_id) REFERENCES condition_lines(id) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_statement_lines_statement_id_fkey') THEN
    ALTER TABLE royalty_statement_lines
      ADD CONSTRAINT royalty_statement_lines_statement_id_fkey
      FOREIGN KEY (royalty_statement_id) REFERENCES royalty_statements(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_statement_lines_source_condition_line_id_fkey') THEN
    ALTER TABLE royalty_statement_lines
      ADD CONSTRAINT royalty_statement_lines_source_condition_line_id_fkey
      FOREIGN KEY (source_condition_line_id) REFERENCES condition_lines(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_statement_lines_source_out_condition_line_id_fkey') THEN
    ALTER TABLE royalty_statement_lines
      ADD CONSTRAINT royalty_statement_lines_source_out_condition_line_id_fkey
      FOREIGN KEY (source_out_condition_line_id) REFERENCES condition_lines(id) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='manufacturing_events_source_document_id_fkey') THEN
    ALTER TABLE manufacturing_events
      ADD CONSTRAINT manufacturing_events_source_document_id_fkey
      FOREIGN KEY (source_document_id) REFERENCES documents(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='manufacturing_events_source_condition_line_id_fkey') THEN
    ALTER TABLE manufacturing_events
      ADD CONSTRAINT manufacturing_events_source_condition_line_id_fkey
      FOREIGN KEY (source_condition_line_id) REFERENCES condition_lines(id) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sales_events_source_document_id_fkey') THEN
    ALTER TABLE sales_events
      ADD CONSTRAINT sales_events_source_document_id_fkey
      FOREIGN KEY (source_document_id) REFERENCES documents(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sales_events_source_condition_line_id_fkey') THEN
    ALTER TABLE sales_events
      ADD CONSTRAINT sales_events_source_condition_line_id_fkey
      FOREIGN KEY (source_condition_line_id) REFERENCES condition_lines(id) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='condition_receipts_source_document_id_fkey') THEN
    ALTER TABLE condition_receipts
      ADD CONSTRAINT condition_receipts_source_document_id_fkey
      FOREIGN KEY (source_document_id) REFERENCES documents(id) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='royalty_payments_payment_id_fkey') THEN
    ALTER TABLE royalty_payments
      ADD CONSTRAINT royalty_payments_payment_id_fkey
      FOREIGN KEY (payment_id) REFERENCES payments(id) NOT VALID;
  END IF;
END
$constraints$;

COMMENT ON COLUMN royalty_calculations.document_id IS
  'Finalized royalty_statement document that produced this canonical calculation.';
COMMENT ON COLUMN royalty_statements.document_id IS
  'Finalized LegalBridge royalty_statement document. Unique canonical statement link.';
COMMENT ON COLUMN royalty_statement_lines.royalty_statement_id IS
  'Parent royalty_statements row. Added by LegalBridge V2 M5.';
COMMENT ON COLUMN condition_receipts.source_document_id IS
  'Royalty statement document that evidenced this sublicense receipt.';
COMMENT ON COLUMN payments.legacy_royalty_payment_id IS
  'Legacy royalty_payments.id when a verified payment record is linked/migrated.';

-- Data-quality rules used by the backfill and future migration checks.
INSERT INTO data_quality_rules (
  rule_code, entity_type, stage, severity, predicate_key, predicate_version,
  remediation_type, title, description, is_active
)
VALUES
  (
    'ROYALTY_STATEMENT_CONDITION_UNRESOLVED','document','M5','warning',
    'royalty_statement_condition_unresolved',1,'manual_link',
    '利用許諾料計算書の根拠条件が未特定',
    'royalty_statement文書を正規化したがsource_condition_line_idを特定できない。契約・作品・IN条件を確認して紐付ける。',
    true
  ),
  (
    'ROYALTY_STATEMENT_AMOUNT_UNRESOLVED','document','M5','error',
    'royalty_statement_amount_unresolved',1,'manual_fix',
    '利用許諾料計算書の精算額が未特定',
    'royalty_statement文書からactual_royalty_ex_taxを安全に復元できない。',
    true
  ),
  (
    'ROYALTY_PAYMENT_LINK_UNRESOLVED','royalty_payment','M5','warning',
    'royalty_payment_link_unresolved',1,'manual_link',
    '旧ロイヤリティ支払とpaymentsの対応未確定',
    'royalty_paymentsは削除せず、支払事実を確認してpaymentsへリンクする。',
    true
  ),
  (
    'ROYALTY_MANUFACTURING_EVENT_AMBIGUOUS','document','M5','warning',
    'royalty_manufacturing_event_ambiguous',1,'manual_review',
    '同一Backlog課題に複数の製造計算書',
    'manufacturing_eventsの既存一意キーはbacklog_issue_keyのため、複数計算書を同一製造イベントへ安全に統合できるか確認が必要。',
    true
  )
ON CONFLICT (rule_code) DO UPDATE SET
  title=EXCLUDED.title,
  description=EXCLUDED.description,
  is_active=true,
  updated_at=now();

COMMIT;
