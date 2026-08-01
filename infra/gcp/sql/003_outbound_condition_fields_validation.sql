-- 003_outbound_condition_fields_validation.sql
-- Validation DB only: additive fields for direction=receive contract conditions.
-- This migration does not insert/update condition data and grants no new write privilege.

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION 'Refusing outbound condition migration outside legalbridge_v2_validation';
  END IF;
  IF to_regclass('public.condition_lines') IS NULL THEN
    RAISE EXCEPTION 'public.condition_lines does not exist';
  END IF;
  IF to_regclass('public.vendors') IS NULL THEN
    RAISE EXCEPTION 'public.vendors does not exist';
  END IF;
END
$guard$;

ALTER TABLE public.condition_lines
  ADD COLUMN IF NOT EXISTS transaction_kind VARCHAR(20),
  ADD COLUMN IF NOT EXISTS counterparty_vendor_id INTEGER REFERENCES public.vendors(id),
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
       AND conname = 'condition_lines_transaction_kind_ck'
  ) THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_transaction_kind_ck
      CHECK (transaction_kind IS NULL OR transaction_kind IN ('license', 'product', 'service'));
  END IF;

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
  WHERE direction = 'receive';

CREATE INDEX IF NOT EXISTS condition_lines_outbound_vendor_idx
  ON public.condition_lines(counterparty_vendor_id)
  WHERE direction = 'receive' AND counterparty_vendor_id IS NOT NULL;

COMMENT ON COLUMN public.condition_lines.transaction_kind IS
  'license, product, or service; independent of payment_scheme';
COMMENT ON COLUMN public.condition_lines.counterparty_vendor_id IS
  'Counterparty for this condition line; outbound recipient/licensee when direction=receive';
COMMENT ON COLUMN public.condition_lines.exclusivity IS
  'exclusive, non_exclusive, or sole';
COMMENT ON COLUMN public.condition_lines.withholding_tax_treatment IS
  'Contractual treatment of foreign withholding tax';

COMMIT;
