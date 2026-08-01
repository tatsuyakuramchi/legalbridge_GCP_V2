\set ON_ERROR_STOP on
\pset pager off

-- Production additive migration for outbound condition fields.
-- This script changes schema only. It does not insert, update or delete rows.
-- Required invocation:
--   psql ... -d legalbridge \
--     -v confirm_production_outbound_schema=ADD_OUTBOUND_FIELDS_TO_LEGALBRIDGE \
--     -f infra/gcp/sql/003_outbound_condition_fields.sql

\if :{?confirm_production_outbound_schema}
SELECT
  :'confirm_production_outbound_schema' = 'ADD_OUTBOUND_FIELDS_TO_LEGALBRIDGE'
    AS outbound_schema_confirmed
\gset
\if :outbound_schema_confirmed
\else
  \echo 'Invalid confirmation value; refusing production outbound migration.'
  \quit 3
\endif
\else
  \echo 'Missing confirm_production_outbound_schema; refusing production outbound migration.'
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  condition_lines_owner oid;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Refusing outbound condition migration outside legalbridge';
  END IF;

  IF to_regclass('public.condition_lines') IS NULL THEN
    RAISE EXCEPTION 'public.condition_lines does not exist';
  END IF;

  IF to_regclass('public.vendors') IS NULL THEN
    RAISE EXCEPTION 'public.vendors does not exist';
  END IF;

  SELECT relowner
    INTO condition_lines_owner
    FROM pg_class
   WHERE oid = 'public.condition_lines'::regclass;

  IF condition_lines_owner IS NULL
     OR NOT (
       current_user = pg_get_userbyid(condition_lines_owner)
       OR pg_has_role(current_user, condition_lines_owner, 'MEMBER')
     ) THEN
    RAISE EXCEPTION
      'Current role % cannot assume condition_lines owner %',
      current_user,
      pg_get_userbyid(condition_lines_owner);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'condition_lines'
       AND column_name = 'transaction_kind'
  ) THEN
    RAISE EXCEPTION 'condition_lines.transaction_kind is missing from baseline schema';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'condition_lines'
       AND column_name = 'counterparty_vendor_id'
  ) THEN
    RAISE EXCEPTION 'condition_lines.counterparty_vendor_id is missing from baseline schema';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.condition_lines'::regclass
       AND conname = 'condition_lines_direction_check'
       AND pg_get_constraintdef(oid) LIKE '%receivable%'
  ) THEN
    RAISE EXCEPTION 'condition_lines direction constraint does not allow receivable';
  END IF;
END
$guard$;

ALTER TABLE public.condition_lines
  ADD COLUMN IF NOT EXISTS exclusivity VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sublicense_allowed BOOLEAN,
  ADD COLUMN IF NOT EXISTS sell_off_months INTEGER,
  ADD COLUMN IF NOT EXISTS minimum_quantity NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS incoterms VARCHAR(20),
  ADD COLUMN IF NOT EXISTS withholding_tax_treatment TEXT,
  ADD COLUMN IF NOT EXISTS royalty_base TEXT,
  ADD COLUMN IF NOT EXISTS deductible_costs TEXT;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.condition_lines'::regclass
       AND conname = 'condition_lines_exclusivity_ck'
  ) THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_exclusivity_ck
      CHECK (
        exclusivity IS NULL
        OR exclusivity IN ('exclusive', 'non_exclusive', 'sole')
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.condition_lines'::regclass
       AND conname = 'condition_lines_sell_off_months_ck'
  ) THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_sell_off_months_ck
      CHECK (sell_off_months IS NULL OR sell_off_months >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.condition_lines'::regclass
       AND conname = 'condition_lines_minimum_quantity_ck'
  ) THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_minimum_quantity_ck
      CHECK (minimum_quantity IS NULL OR minimum_quantity >= 0) NOT VALID;
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS condition_lines_outbound_kind_idx
  ON public.condition_lines(direction, transaction_kind)
  WHERE direction = 'receivable';

CREATE INDEX IF NOT EXISTS condition_lines_outbound_vendor_idx
  ON public.condition_lines(counterparty_vendor_id)
  WHERE direction = 'receivable' AND counterparty_vendor_id IS NOT NULL;

COMMENT ON COLUMN public.condition_lines.exclusivity IS
  'exclusive, non_exclusive, or sole';
COMMENT ON COLUMN public.condition_lines.sublicense_allowed IS
  'Whether the outbound recipient/licensee may grant sublicenses';
COMMENT ON COLUMN public.condition_lines.sell_off_months IS
  'Structured post-termination sell-off period in months';
COMMENT ON COLUMN public.condition_lines.minimum_quantity IS
  'Minimum committed product quantity for outbound product terms';
COMMENT ON COLUMN public.condition_lines.incoterms IS
  'Agreed Incoterms rule for outbound product delivery';
COMMENT ON COLUMN public.condition_lines.withholding_tax_treatment IS
  'Contractual treatment of foreign withholding tax';
COMMENT ON COLUMN public.condition_lines.royalty_base IS
  'Contractual base used to calculate outbound royalty';
COMMENT ON COLUMN public.condition_lines.deductible_costs IS
  'Costs contractually deductible from the royalty base';

COMMIT;
