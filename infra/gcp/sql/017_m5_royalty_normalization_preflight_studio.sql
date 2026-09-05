-- 017_m5_royalty_normalization_preflight_studio.sql
-- LegalBridge V2 / M5 Royalty normalization
-- Cloud SQL Studio compatible. READ ONLY.
--
-- Purpose:
--   Confirm production shape before moving royalty_statement form_data into
--   canonical royalty / event tables.

DO $guard$
DECLARE
  relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'documents','contracts','condition_lines','condition_events',
    'condition_receipts','manufacturing_events','sales_events',
    'royalty_calculations','royalty_statements','royalty_statement_lines',
    'royalty_payments','payments','data_quality_issues','data_quality_rules'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required relation public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

-- 1. Target row counts.
SELECT 'royalty_statement documents' AS entity, COUNT(*)::bigint AS rows
FROM documents WHERE template_type = 'royalty_statement'
UNION ALL SELECT 'royalty_calculations', COUNT(*) FROM royalty_calculations
UNION ALL SELECT 'royalty_statements', COUNT(*) FROM royalty_statements
UNION ALL SELECT 'royalty_statement_lines', COUNT(*) FROM royalty_statement_lines
UNION ALL SELECT 'manufacturing_events', COUNT(*) FROM manufacturing_events
UNION ALL SELECT 'sales_events', COUNT(*) FROM sales_events
UNION ALL SELECT 'condition_receipts', COUNT(*) FROM condition_receipts
UNION ALL SELECT 'condition_events', COUNT(*) FROM condition_events
UNION ALL SELECT 'royalty_payments', COUNT(*) FROM royalty_payments
UNION ALL SELECT 'payments', COUNT(*) FROM payments
ORDER BY entity;

-- 2. Finalized royalty documents by root JSON type.
SELECT
  COALESCE(jsonb_typeof(form_data), 'SQL_NULL') AS form_data_root_type,
  COUNT(*) AS rows
FROM documents
WHERE template_type = 'royalty_statement'
GROUP BY jsonb_typeof(form_data)
ORDER BY form_data_root_type;

-- 3. Legacy/new trigger coverage.
SELECT
  COALESCE(
    NULLIF(form_data->>'settlement_trigger',''),
    NULLIF(form_data->>'calcType',''),
    NULLIF(form_data->>'rsCalcType',''),
    CASE
      WHEN jsonb_typeof(form_data->'rs_receipts') = 'array'
       AND jsonb_array_length(form_data->'rs_receipts') > 0
      THEN 'sublicense_receipt'
      ELSE '(unknown)'
    END
  ) AS trigger_hint,
  COUNT(*) AS rows
FROM documents
WHERE template_type = 'royalty_statement'
  AND jsonb_typeof(form_data) = 'object'
GROUP BY 1
ORDER BY rows DESC, trigger_hint;

-- 4. Canonical IDs present in form_data.
SELECT
  COUNT(*) AS documents_total,
  COUNT(*) FILTER (
    WHERE NULLIF(form_data->>'source_condition_line_id','') IS NOT NULL
       OR NULLIF(form_data->>'rsConditionLineId','') IS NOT NULL
  ) AS with_condition_id,
  COUNT(*) FILTER (
    WHERE NULLIF(form_data->>'source_out_condition_line_id','') IS NOT NULL
  ) AS with_out_condition_id,
  COUNT(*) FILTER (
    WHERE NULLIF(form_data->>'source_contract_id','') IS NOT NULL
       OR NULLIF(form_data->>'license_contract_id','') IS NOT NULL
       OR contract_id IS NOT NULL
  ) AS with_contract_id,
  COUNT(*) FILTER (
    WHERE NULLIF(form_data->>'actualRoyalty','') IS NOT NULL
       OR NULLIF(form_data->>'actualRoyaltyStr','') IS NOT NULL
       OR NULLIF(form_data->>'grossRoyaltyStr','') IS NOT NULL
  ) AS with_royalty_amount
FROM documents
WHERE template_type = 'royalty_statement'
  AND jsonb_typeof(form_data) = 'object';

-- 5. Invalid referenced condition IDs (new and rsConditionLineId only).
WITH refs AS (
  SELECT
    d.id AS document_id,
    d.document_number,
    CASE
      WHEN (d.form_data->>'source_condition_line_id') ~ '^\d+$'
        THEN (d.form_data->>'source_condition_line_id')::int
      WHEN (d.form_data->>'rsConditionLineId') ~ '^\d+$'
        THEN (d.form_data->>'rsConditionLineId')::int
      ELSE NULL
    END AS condition_line_id
  FROM documents d
  WHERE d.template_type = 'royalty_statement'
    AND jsonb_typeof(d.form_data) = 'object'
)
SELECT
  COUNT(*) FILTER (WHERE r.condition_line_id IS NOT NULL) AS referenced,
  COUNT(*) FILTER (WHERE r.condition_line_id IS NOT NULL AND cl.id IS NULL) AS broken
FROM refs r
LEFT JOIN condition_lines cl ON cl.id = r.condition_line_id;

-- 6. Exact target columns used by M5.
SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'royalty_calculations','royalty_statements','royalty_statement_lines',
    'manufacturing_events','sales_events','condition_receipts',
    'condition_events','royalty_payments','payments'
  )
ORDER BY table_name, ordinal_position;

-- 7. Legacy royalty_payments distribution. Do not auto-convert yet.
SELECT
  COALESCE(status,'(NULL)') AS status,
  COUNT(*) AS rows,
  MIN(payment_due_date) AS first_due,
  MAX(payment_due_date) AS last_due,
  SUM(COALESCE(total_amount,0)) AS total_amount
FROM royalty_payments
GROUP BY status
ORDER BY status;

-- 8. Existing payment candidates that could correspond to royalty_payments.
SELECT
  COUNT(*) AS candidate_matches
FROM royalty_payments rp
JOIN payments p
  ON (
       NULLIF(p.backlog_issue_key,'') = NULLIF(rp.backlog_issue_key,'')
       OR (
         p.contract_id IS NOT NULL
         AND p.contract_id = rp.license_contract_id
         AND p.due_date IS NOT DISTINCT FROM rp.payment_due_date
       )
     )
WHERE COALESCE(p.payment_kind,'') ILIKE '%royalty%'
   OR COALESCE(p.payment_kind,'') ILIKE '%license%';
