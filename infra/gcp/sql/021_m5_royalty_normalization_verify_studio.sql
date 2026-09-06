-- 021_m5_royalty_normalization_verify_studio.sql
-- LegalBridge V2 / M5 verification
-- Cloud SQL Studio compatible. READ ONLY.

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
END
$guard$;

-- 1. Required extension columns.
SELECT table_name,column_name,data_type,is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND (
    (table_name='royalty_calculations' AND column_name IN (
      'document_id','source_out_condition_line_id','basis_amount','deductions',
      'event_type','occurred_at','source_form_data','updated_at'
    ))
    OR
    (table_name='royalty_statements' AND column_name IN (
      'document_id','source_condition_line_id','source_out_condition_line_id',
      'event_type','occurred_at','basis_amount','deductions','source_form_data','updated_at'
    ))
    OR
    (table_name='royalty_statement_lines' AND column_name IN (
      'royalty_statement_id','basis_note','source_condition_line_id',
      'source_out_condition_line_id','gross_event_amount','deductions','source_json'
    ))
    OR
    (table_name='manufacturing_events' AND column_name IN ('source_document_id','source_condition_line_id'))
    OR
    (table_name='sales_events' AND column_name IN ('source_document_id','source_condition_line_id'))
    OR
    (table_name='condition_receipts' AND column_name='source_document_id')
    OR
    (table_name='royalty_payments' AND column_name='payment_id')
    OR
    (table_name='payments' AND column_name='legacy_royalty_payment_id')
  )
ORDER BY table_name,column_name;

-- 2. Coverage.
WITH source AS (
  SELECT COUNT(*) AS docs
  FROM documents
  WHERE template_type='royalty_statement'
    AND jsonb_typeof(form_data)='object'
)
SELECT
  source.docs AS source_documents,
  (SELECT COUNT(*) FROM royalty_calculations WHERE document_id IS NOT NULL) AS calculations,
  (SELECT COUNT(*) FROM royalty_statements WHERE document_id IS NOT NULL) AS statements,
  (SELECT COUNT(*) FROM royalty_statement_lines WHERE royalty_statement_id IS NOT NULL) AS statement_lines,
  (SELECT COUNT(*) FROM condition_events WHERE event_type='royalty_calc' AND voided_at IS NULL) AS royalty_events,
  (SELECT COUNT(*) FROM manufacturing_events WHERE source_document_id IS NOT NULL) AS manufacturing_events,
  (SELECT COUNT(*) FROM sales_events WHERE source_document_id IS NOT NULL) AS sales_events,
  (SELECT COUNT(*) FROM condition_receipts WHERE source_document_id IS NOT NULL) AS receipt_events
FROM source;

-- 3. Every normalized statement must point back to a finalized document.
SELECT COUNT(*) AS broken_statement_document_links
FROM royalty_statements rs
LEFT JOIN documents d ON d.id=rs.document_id
WHERE rs.document_id IS NOT NULL
  AND d.id IS NULL;

SELECT COUNT(*) AS broken_calculation_document_links
FROM royalty_calculations rc
LEFT JOIN documents d ON d.id=rc.document_id
WHERE rc.document_id IS NOT NULL
  AND d.id IS NULL;

-- 4. Duplicate canonical links must be zero.
SELECT document_id,COUNT(*) AS rows
FROM royalty_statements
WHERE document_id IS NOT NULL
GROUP BY document_id
HAVING COUNT(*)>1
ORDER BY rows DESC,document_id;

SELECT document_id,COUNT(*) AS rows
FROM royalty_calculations
WHERE document_id IS NOT NULL
GROUP BY document_id
HAVING COUNT(*)>1
ORDER BY rows DESC,document_id;

SELECT royalty_statement_id,line_no,COUNT(*) AS rows
FROM royalty_statement_lines
WHERE royalty_statement_id IS NOT NULL
GROUP BY royalty_statement_id,line_no
HAVING COUNT(*)>1
ORDER BY rows DESC,royalty_statement_id,line_no;

-- 5. Amount / condition completeness.
SELECT
  COUNT(*) AS statements,
  COUNT(*) FILTER (WHERE actual_royalty_ex_tax IS NOT NULL) AS with_actual_royalty,
  COUNT(*) FILTER (WHERE source_condition_line_id IS NOT NULL) AS with_source_condition,
  COUNT(*) FILTER (WHERE basis_amount IS NOT NULL) AS with_basis,
  COUNT(*) FILTER (WHERE event_type IS NOT NULL) AS with_event_type,
  COUNT(*) FILTER (WHERE currency IS NOT NULL) AS with_currency
FROM royalty_statements
WHERE document_id IS NOT NULL;

-- 6. Open M5 data-quality issues. These are explicit manual follow-ups, not hidden skips.
SELECT rule_code,severity,COUNT(*) AS open_rows
FROM data_quality_issues
WHERE status='open'
  AND rule_code IN (
    'ROYALTY_STATEMENT_CONDITION_UNRESOLVED',
    'ROYALTY_STATEMENT_AMOUNT_UNRESOLVED',
    'ROYALTY_PAYMENT_LINK_UNRESOLVED',
    'ROYALTY_MANUFACTURING_EVENT_AMBIGUOUS'
  )
GROUP BY rule_code,severity
ORDER BY severity DESC,rule_code;

-- 7. Legacy royalty payment linkage. Unmatched records remain legacy by design.
SELECT
  COUNT(*) AS legacy_rows,
  COUNT(*) FILTER (WHERE payment_id IS NOT NULL) AS linked_to_existing_payment,
  COUNT(*) FILTER (WHERE payment_id IS NULL) AS manual_review_required
FROM royalty_payments;

-- 8. Runtime grants.
SELECT
  has_table_privilege('legalbridge_v2_runtime','public.royalty_calculations','SELECT,INSERT,UPDATE') AS calculations_rw,
  has_table_privilege('legalbridge_v2_runtime','public.royalty_statements','SELECT,INSERT,UPDATE') AS statements_rw,
  has_table_privilege('legalbridge_v2_runtime','public.royalty_statement_lines','SELECT,INSERT,UPDATE') AS lines_rw,
  has_table_privilege('legalbridge_v2_runtime','public.manufacturing_events','SELECT,INSERT,UPDATE') AS manufacturing_rw,
  has_table_privilege('legalbridge_v2_runtime','public.sales_events','SELECT,INSERT,UPDATE') AS sales_rw,
  has_table_privilege('legalbridge_v2_runtime','public.condition_receipts','SELECT,INSERT,UPDATE') AS receipts_rw,
  has_table_privilege('legalbridge_v2_runtime','public.condition_events','SELECT,INSERT,UPDATE') AS condition_events_rw;

-- 9. New finalizations should be dual-written.
SELECT
  d.id,d.document_number,d.issue_key,d.created_at,
  rs.id AS royalty_statement_id,
  rc.id AS royalty_calculation_id,
  ce.id AS condition_event_id
FROM documents d
LEFT JOIN royalty_statements rs ON rs.document_id=d.id
LEFT JOIN royalty_calculations rc ON rc.document_id=d.id
LEFT JOIN condition_events ce
  ON ce.source_royalty_calculation_id=rc.id
 AND ce.event_type='royalty_calc'
 AND ce.voided_at IS NULL
WHERE d.template_type='royalty_statement'
ORDER BY d.created_at DESC NULLS LAST,d.id DESC
LIMIT 50;
