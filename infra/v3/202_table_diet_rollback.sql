-- 202_table_diet.sql を戻す（捨てた PDF は戻らない。開けばその場で描き直す）。
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['condition_holder_190_backup', 'condition_holder_190_created', 'condition_holder_190_review'] LOOP
    IF to_regclass('archive.' || t) IS NOT NULL AND to_regclass('v3.' || t) IS NULL THEN
      EXECUTE format('ALTER TABLE archive.%I SET SCHEMA v3', t);
    END IF;
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS v3.snippets (
  id         bigserial PRIMARY KEY,
  category   text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE VIEW v3.v_rights_sources AS
SELECT c.work_id, c.work_part_id, c.id AS condition_id, c.condition_no,
       c.counterparty_id AS rights_holder_id, p.name AS rights_holder,
       c.term_start, c.term_end, c.agreement_id
  FROM v3.conditions c
  JOIN v3.parties p ON p.id = c.counterparty_id
 WHERE c.direction = 'in' AND c.status = 'active';
CREATE INDEX IF NOT EXISTS parties_aliases_idx ON v3.parties USING gin (aliases);
CREATE INDEX IF NOT EXISTS works_title_idx ON v3.works (title);
CREATE INDEX IF NOT EXISTS condition_shares_condition_idx ON v3.condition_shares (condition_id);
CREATE INDEX IF NOT EXISTS work_credits_work_idx ON v3.work_credits (work_id, effective_from DESC);
COMMIT;
