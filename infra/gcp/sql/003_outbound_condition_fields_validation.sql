-- 003_outbound_condition_fields_validation.sql
-- Validation DB only: additive fields for direction=receivable contract conditions.
-- Prerequisite: the validation DB contains the production-equivalent business schema.
-- This migration does not insert/update condition data and grants no new write privilege.

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION 'Refusing outbound condition migration outside legalbridge_v2_validation';
  END IF;
  IF to_regclass('public.condition_lines') IS NULL THEN
    RAISE EXCEPTION 'public.condition_lines does not exist; restore the production-equivalent business schema before running 003';
  END IF;
  IF to_regclass('public.vendors') IS NULL THEN
    RAISE EXCEPTION 'public.vendors does not exist; restore the production-equivalent business schema before running 003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'condition_lines'
       AND column_name = 'transaction_kind'
  ) THEN
    RAISE EXCEPTION 'condition_lines.transaction_kind is missing from the baseline schema';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'condition_lines'
       AND column_name = 'counterparty_vendor_id'
  ) THEN
    RAISE EXCEPTION 'condition_lines.counterparty_vendor_id is missing from the baseline schema';
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
      CHECK (exclusivity IS NULL OR exclusivity IN ('exclusive', 'non_exclusive', 'sole'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.condition_lines'::regclass
       AND conname = 'condition_lines_sell_off_months_ck'
  ) THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_sell_off_months_ck
      CHECK (sell_off_months IS NULL OR sell_off_months >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.condition_lines'::regclass
       AND conname = 'condition_lines_minimum_quantity_ck'
  ) THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_minimum_quantity_ck
      CHECK (minimum_quantity IS NULL OR minimum_quantity >= 0);
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
COMMENT ON COLUMN public.condition_lines.withholding_tax_treatment IS
  'Contractual treatment of foreign withholding tax';

COMMIT;
