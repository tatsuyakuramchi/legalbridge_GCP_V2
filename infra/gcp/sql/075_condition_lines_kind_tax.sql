\set ON_ERROR_STOP on
\pset pager off

-- 075_condition_lines_kind_tax.sql
-- 条件台帳（condition_ledger・2026-09-04）で業務委託の「経費」「その他手数料」を条件明細として
-- 持つための列追加。
--   line_kind    : payment（既定・支払／料率）/ expense（経費）/ fee（その他手数料）
--   tax_category : taxable（課税10%）/ reduced（課税8%）/ exempt（非課税・不課税）/ NULL
-- 発注書の税計算と経理提出用エクセル（課税／非課税列）はこの2列から直接出る。
-- 既存行は既定値（payment / NULL）のまま＝挙動不変。冪等（IF NOT EXISTS）。
-- 実行者: postgres（Cloud SQL Studio でそのまま貼り付け可）。runtime ロールは
-- condition_lines にテーブルレベルの INSERT/UPDATE を持つ（066）ため追加 GRANT は不要。

BEGIN;

ALTER TABLE public.condition_lines
  ADD COLUMN IF NOT EXISTS line_kind text NOT NULL DEFAULT 'payment',
  ADD COLUMN IF NOT EXISTS tax_category text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'condition_lines_line_kind_check') THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_line_kind_check
      CHECK (line_kind IN ('payment', 'expense', 'fee'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'condition_lines_tax_category_check') THEN
    ALTER TABLE public.condition_lines
      ADD CONSTRAINT condition_lines_tax_category_check
      CHECK (tax_category IS NULL OR tax_category IN ('taxable', 'reduced', 'exempt'));
  END IF;
END $$;

COMMENT ON COLUMN public.condition_lines.line_kind IS
  '条件明細の種類: payment=支払・料率 / expense=経費 / fee=その他手数料（条件台帳 2026-09-04）';
COMMENT ON COLUMN public.condition_lines.tax_category IS
  '税区分: taxable=課税10% / reduced=課税8% / exempt=非課税・不課税（経理提出用エクセルの列）';

-- 確認
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'condition_lines' AND column_name IN ('line_kind', 'tax_category')
 ORDER BY column_name;

COMMIT;
