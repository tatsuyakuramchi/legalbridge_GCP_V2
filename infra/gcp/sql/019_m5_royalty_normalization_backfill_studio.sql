-- 019_m5_royalty_normalization_backfill_studio.sql
-- LegalBridge V2 / M5 Royalty normalization backfill
-- Cloud SQL Studio compatible.
--
-- Source of truth for historical conversion:
--   finalized documents(template_type='royalty_statement').form_data
--
-- Destination:
--   royalty_calculations
--   royalty_statements
--   royalty_statement_lines
--   manufacturing_events / sales_events / condition_receipts
--   condition_events(event_type='royalty_calc')
--
-- Important:
--   payments is NOT synthesized from a calculation statement.
--   royalty_payments is only linked to an already-existing matching payment;
--   unmatched rows remain for manual verification and are flagged in
--   data_quality_issues.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='royalty_statements' AND column_name='document_id'
  ) THEN
    RAISE EXCEPTION 'Run 018_m5_royalty_normalization_schema_studio.sql first';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION pg_temp.lb_num(value text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE cleaned text;
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN RETURN NULL; END IF;
  cleaned := regexp_replace(value, '[^0-9.\-]', '', 'g');
  IF cleaned IS NULL OR cleaned IN ('', '-', '.', '-.') THEN RETURN NULL; END IF;
  RETURN cleaned::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.lb_int(value text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE n numeric;
BEGIN
  n := pg_temp.lb_num(value);
  IF n IS NULL OR n <= 0 OR trunc(n) <> n OR n > 2147483647 THEN RETURN NULL; END IF;
  RETURN n::integer;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.lb_date(value text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE normalized text;
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN RETURN NULL; END IF;
  normalized := substring(value from '^\d{4}-\d{2}-\d{2}');
  IF normalized IS NULL THEN RETURN NULL; END IF;
  RETURN normalized::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

CREATE TEMP TABLE lb_m5_royalty_source ON COMMIT DROP AS
WITH base AS (
  SELECT
    d.id AS document_id,
    d.document_number,
    d.issue_key,
    COALESCE(NULLIF(d.backlog_issue_key,''), NULLIF(d.issue_key,'')) AS backlog_issue_key,
    d.contract_id AS document_contract_id,
    d.material_ref_id,
    d.created_at,
    d.form_data AS f,
    COALESCE(
      NULLIF(d.form_data->>'settlement_trigger',''),
      NULLIF(d.form_data->>'calcType',''),
      NULLIF(d.form_data->>'rsCalcType',''),
      CASE
        WHEN jsonb_typeof(d.form_data->'rs_receipts')='array'
         AND jsonb_array_length(d.form_data->'rs_receipts') > 0
        THEN 'sublicense_receipt'
        ELSE 'royalty'
      END
    ) AS raw_trigger
  FROM documents d
  WHERE d.template_type='royalty_statement'
    AND jsonb_typeof(d.form_data)='object'
),
normalized AS (
  SELECT
    b.*,
    CASE
      WHEN lower(raw_trigger) LIKE '%manufact%' OR raw_trigger LIKE '%製造%' THEN 'manufacturing'
      WHEN lower(raw_trigger) LIKE '%sale%' OR raw_trigger LIKE '%売上%' OR raw_trigger LIKE '%販売%' THEN 'sale'
      WHEN lower(raw_trigger) LIKE '%sublicense%' OR lower(raw_trigger) LIKE '%receipt%'
        OR raw_trigger LIKE '%入金%' THEN 'sublicense_receipt'
      ELSE 'royalty'
    END AS event_type,
    COALESCE(
      pg_temp.lb_date(f->>'settlement_occurred_at'),
      pg_temp.lb_date(f->>'completionDate'),
      pg_temp.lb_date(f->>'documentDate'),
      created_at::date
    ) AS occurred_date,
    COALESCE(
      pg_temp.lb_int(f->>'source_condition_line_id'),
      pg_temp.lb_int(f->>'rsConditionLineId'),
      pg_temp.lb_int(f->>'condition_line_id')
    ) AS candidate_condition_line_id,
    pg_temp.lb_int(f->>'source_out_condition_line_id') AS candidate_out_condition_line_id,
    COALESCE(
      pg_temp.lb_int(f->>'source_contract_id'),
      pg_temp.lb_int(f->>'license_contract_id'),
      pg_temp.lb_int(f->>'selected_master_contract_id'),
      document_contract_id
    ) AS candidate_contract_id,
    COALESCE(NULLIF(f->>'currency',''), NULLIF(f->>'intakeCurrency',''), 'JPY') AS currency,
    COALESCE(NULLIF(f->>'productName',''), NULLIF(f->>'PROJECT_TITLE',''),
             NULLIF(f->>'originalWork',''), '利用許諾対象') AS product_name,
    NULLIF(f->>'edition','') AS edition,
    COALESCE(pg_temp.lb_num(f->>'quantity'), pg_temp.lb_num(f->>'rsQuantity')) AS quantity,
    COALESCE(pg_temp.lb_num(f->>'sampleQuantity'), pg_temp.lb_num(f->>'rsSampleQuantity'),0) AS sample_quantity,
    pg_temp.lb_num(f->>'billableQuantity') AS billable_quantity_raw,
    COALESCE(
      pg_temp.lb_num(f->>'unit_price'),
      pg_temp.lb_num(f->>'MSRP'),
      pg_temp.lb_num(f->>'rsMsrp'),
      pg_temp.lb_num(f->>'基準価格')
    ) AS unit_price_raw,
    pg_temp.lb_num(f->>'settlement_basis_amount') AS basis_amount_raw,
    pg_temp.lb_num(f->>'settlement_gross_event_amount') AS gross_event_amount,
    COALESCE(pg_temp.lb_num(f->>'settlement_deductions'),0) AS deductions,
    COALESCE(
      pg_temp.lb_num(f->>'royaltyRatePct'),
      pg_temp.lb_num(f->>'rsRatePct'),
      pg_temp.lb_num(f->>'rsInRatePct'),
      pg_temp.lb_num(f->>'料率')
    ) AS rate_pct,
    COALESCE(
      pg_temp.lb_num(f->>'grossRoyaltyStr'),
      pg_temp.lb_num(f->>'gross_royalty_ex_tax')
    ) AS gross_royalty_raw,
    COALESCE(
      pg_temp.lb_num(f->>'actualRoyalty'),
      pg_temp.lb_num(f->>'actualRoyaltyStr'),
      pg_temp.lb_num(f->>'royalty_amount'),
      pg_temp.lb_num(f->>'grossRoyaltyStr')
    ) AS actual_royalty,
    pg_temp.lb_num(f->>'taxRate') AS tax_rate_num,
    pg_temp.lb_num(f->>'taxAmount') AS tax_amount,
    pg_temp.lb_num(f->>'totalPaymentStr') AS total_payment,
    COALESCE(pg_temp.lb_num(f->>'mgAmount'),pg_temp.lb_num(f->>'rsMgAmount')) AS mg_amount,
    pg_temp.lb_num(f->>'mgConsumedBefore') AS mg_consumed_before,
    pg_temp.lb_num(f->>'mgConsumedThisTime') AS mg_consumed_this_time,
    pg_temp.lb_num(f->>'mgConsumedAfter') AS mg_consumed_after,
    pg_temp.lb_num(f->>'mgRemaining') AS mg_remaining,
    COALESCE(pg_temp.lb_num(f->>'agAmount'),pg_temp.lb_num(f->>'rsAgAmount')) AS ag_amount,
    COALESCE(pg_temp.lb_num(f->>'agConsumedBefore'),pg_temp.lb_num(f->>'rsAgConsumedBefore')) AS ag_consumed_before,
    pg_temp.lb_num(f->>'agConsumedThisTime') AS ag_consumed_this_time,
    pg_temp.lb_num(f->>'agConsumedAfter') AS ag_consumed_after,
    pg_temp.lb_num(f->>'agRemaining') AS ag_remaining,
    pg_temp.lb_date(f->>'reportingDeadline') AS reporting_deadline,
    pg_temp.lb_date(f->>'paymentDueDate') AS payment_due_date,
    COALESCE(NULLIF(f->>'notes',''),NULLIF(f->>'remarks',''),NULLIF(f->>'bridgeNotice','')) AS notes
  FROM base b
),
validated AS (
  SELECT
    n.*,
    CASE WHEN cl.id IS NOT NULL THEN n.candidate_condition_line_id END AS condition_line_id,
    CASE WHEN out_cl.id IS NOT NULL THEN n.candidate_out_condition_line_id END AS source_out_condition_line_id,
    CASE WHEN c.id IS NOT NULL THEN n.candidate_contract_id END AS contract_id,
    cl.product_id,
    COALESCE(cl.source_material_id,n.material_ref_id) AS work_material_id,
    COALESCE(
      n.billable_quantity_raw,
      CASE WHEN n.quantity IS NOT NULL THEN GREATEST(n.quantity - n.sample_quantity,0) END
    ) AS billable_quantity
  FROM normalized n
  LEFT JOIN condition_lines cl ON cl.id=n.candidate_condition_line_id
  LEFT JOIN condition_lines out_cl ON out_cl.id=n.candidate_out_condition_line_id
  LEFT JOIN contracts c ON c.id=n.candidate_contract_id
)
SELECT
  v.*,
  CASE
    WHEN v.event_type='manufacturing' THEN v.unit_price_raw
    ELSE NULL
  END AS unit_price,
  COALESCE(
    v.basis_amount_raw,
    CASE
      WHEN v.event_type='manufacturing'
       AND v.unit_price_raw IS NOT NULL
       AND v.billable_quantity IS NOT NULL
      THEN v.unit_price_raw * v.billable_quantity
      WHEN v.actual_royalty IS NOT NULL
       AND v.rate_pct IS NOT NULL
       AND v.rate_pct <> 0
      THEN v.actual_royalty / (v.rate_pct / 100.0)
      ELSE NULL
    END
  ) AS basis_amount,
  COALESCE(
    v.gross_royalty_raw,
    CASE
      WHEN v.rate_pct IS NOT NULL
       AND COALESCE(v.basis_amount_raw,
         CASE WHEN v.event_type='manufacturing'
           THEN v.unit_price_raw * v.billable_quantity END
       ) IS NOT NULL
      THEN COALESCE(v.basis_amount_raw, v.unit_price_raw * v.billable_quantity)
           * (v.rate_pct / 100.0)
      ELSE v.actual_royalty
    END
  ) AS gross_royalty,
  COALESCE(NULLIF(v.f->>'period',''),to_char(v.occurred_date,'YYYY-MM')) AS period,
  CASE WHEN v.tax_rate_num IS NULL THEN NULL ELSE round(v.tax_rate_num)::int END AS tax_rate
FROM validated v;

-- A. Manufacturing event evidence.
INSERT INTO manufacturing_events (
  backlog_issue_key,license_contract_id,product_name,completion_date,quantity,
  msrp,total_payment,unit_price,sample_quantity,billable_quantity,edition,product_id,
  source_document_id,source_condition_line_id
)
SELECT
  s.backlog_issue_key,s.contract_id,s.product_name,s.occurred_date,
  CASE WHEN s.quantity IS NULL THEN NULL ELSE round(s.quantity)::int END,
  s.unit_price,s.total_payment,s.unit_price,s.sample_quantity,s.billable_quantity,
  s.edition,s.product_id,s.document_id,s.condition_line_id
FROM lb_m5_royalty_source s
WHERE s.event_type='manufacturing'
  AND NULLIF(s.backlog_issue_key,'') IS NOT NULL
ON CONFLICT (backlog_issue_key) DO UPDATE SET
  license_contract_id=COALESCE(EXCLUDED.license_contract_id,manufacturing_events.license_contract_id),
  product_name=EXCLUDED.product_name,
  completion_date=COALESCE(EXCLUDED.completion_date,manufacturing_events.completion_date),
  quantity=COALESCE(EXCLUDED.quantity,manufacturing_events.quantity),
  msrp=COALESCE(EXCLUDED.msrp,manufacturing_events.msrp),
  total_payment=COALESCE(EXCLUDED.total_payment,manufacturing_events.total_payment),
  unit_price=COALESCE(EXCLUDED.unit_price,manufacturing_events.unit_price),
  sample_quantity=COALESCE(EXCLUDED.sample_quantity,manufacturing_events.sample_quantity),
  billable_quantity=COALESCE(EXCLUDED.billable_quantity,manufacturing_events.billable_quantity),
  edition=COALESCE(EXCLUDED.edition,manufacturing_events.edition),
  product_id=COALESCE(EXCLUDED.product_id,manufacturing_events.product_id),
  source_document_id=COALESCE(manufacturing_events.source_document_id,EXCLUDED.source_document_id),
  source_condition_line_id=COALESCE(EXCLUDED.source_condition_line_id,manufacturing_events.source_condition_line_id);

-- B. Sales event evidence.
INSERT INTO sales_events (
  product_id,backlog_issue_key,period,sold_quantity,sales_amount,report_date,
  source_document_id,source_condition_line_id
)
SELECT
  s.product_id,s.backlog_issue_key,s.period,
  COALESCE(s.billable_quantity,s.quantity),
  COALESCE(s.gross_event_amount,s.basis_amount),
  s.occurred_date,s.document_id,s.condition_line_id
FROM lb_m5_royalty_source s
WHERE s.event_type='sale'
ON CONFLICT (source_document_id) WHERE source_document_id IS NOT NULL
DO UPDATE SET
  product_id=EXCLUDED.product_id,
  backlog_issue_key=EXCLUDED.backlog_issue_key,
  period=EXCLUDED.period,
  sold_quantity=EXCLUDED.sold_quantity,
  sales_amount=EXCLUDED.sales_amount,
  report_date=EXCLUDED.report_date,
  source_condition_line_id=EXCLUDED.source_condition_line_id;

-- C. Sublicense receipt evidence.
INSERT INTO condition_receipts (
  condition_line_id,period,period_date,computed_royalty_ex_tax,received_amount,
  received_date,status,note,distribution_parent_condition_id,distribution_base,
  distribution_qty,distribution_rate_pct,computed_distribution_ex_tax,source_document_id
)
SELECT
  COALESCE(s.source_out_condition_line_id,s.condition_line_id),
  s.period,s.occurred_date,s.actual_royalty,
  COALESCE(s.gross_event_amount,s.basis_amount),
  s.occurred_date,'received',s.notes,s.condition_line_id,s.basis_amount,
  1,s.rate_pct,s.actual_royalty,s.document_id
FROM lb_m5_royalty_source s
WHERE s.event_type='sublicense_receipt'
ON CONFLICT (source_document_id) WHERE source_document_id IS NOT NULL
DO UPDATE SET
  condition_line_id=EXCLUDED.condition_line_id,
  period=EXCLUDED.period,
  period_date=EXCLUDED.period_date,
  computed_royalty_ex_tax=EXCLUDED.computed_royalty_ex_tax,
  received_amount=EXCLUDED.received_amount,
  received_date=EXCLUDED.received_date,
  status=EXCLUDED.status,
  note=EXCLUDED.note,
  distribution_parent_condition_id=EXCLUDED.distribution_parent_condition_id,
  distribution_base=EXCLUDED.distribution_base,
  distribution_qty=EXCLUDED.distribution_qty,
  distribution_rate_pct=EXCLUDED.distribution_rate_pct,
  computed_distribution_ex_tax=EXCLUDED.computed_distribution_ex_tax,
  updated_at=now();

-- D. Canonical calculation row.
INSERT INTO royalty_calculations (
  document_id,backlog_issue_key,license_contract_id,manufacturing_event_id,
  calc_type,unit_price,quantity,sample_quantity,billable_quantity,rate_pct,
  gross_royalty_ex_tax,mg_amount,mg_consumed_before,mg_consumed_this_time,
  mg_consumed_after,mg_remaining,mg_fully_consumed,actual_royalty_ex_tax,
  tax_rate,tax_amount,total_payment_inc_tax,currency,period,reporting_deadline,
  payment_due_date,notes,mg_topup_this_time,ag_amount,ag_consumed_before,
  ag_consumed_this_time,ag_consumed_after,ag_remaining,ag_fully_consumed,
  condition_line_id,source_out_condition_line_id,basis_amount,deductions,
  event_type,occurred_at,source_form_data,updated_at
)
SELECT
  s.document_id,s.backlog_issue_key,s.contract_id,me.id,
  s.event_type,s.unit_price,s.quantity,s.sample_quantity,s.billable_quantity,
  s.rate_pct,s.gross_royalty,s.mg_amount,s.mg_consumed_before,
  s.mg_consumed_this_time,s.mg_consumed_after,s.mg_remaining,
  CASE WHEN s.mg_remaining IS NULL OR s.mg_amount IS NULL THEN NULL ELSE s.mg_remaining<=0 END,
  s.actual_royalty,s.tax_rate,s.tax_amount,s.total_payment,s.currency,s.period,
  s.reporting_deadline,s.payment_due_date,s.notes,0,s.ag_amount,
  s.ag_consumed_before,s.ag_consumed_this_time,s.ag_consumed_after,s.ag_remaining,
  CASE WHEN s.ag_remaining IS NULL OR s.ag_amount IS NULL THEN NULL ELSE s.ag_remaining<=0 END,
  s.condition_line_id,s.source_out_condition_line_id,s.basis_amount,s.deductions,
  s.event_type,s.occurred_date::timestamptz,s.f,now()
FROM lb_m5_royalty_source s
LEFT JOIN manufacturing_events me ON me.source_document_id=s.document_id
ON CONFLICT (document_id) WHERE document_id IS NOT NULL
DO UPDATE SET
  backlog_issue_key=EXCLUDED.backlog_issue_key,
  license_contract_id=EXCLUDED.license_contract_id,
  manufacturing_event_id=EXCLUDED.manufacturing_event_id,
  calc_type=EXCLUDED.calc_type,unit_price=EXCLUDED.unit_price,
  quantity=EXCLUDED.quantity,sample_quantity=EXCLUDED.sample_quantity,
  billable_quantity=EXCLUDED.billable_quantity,rate_pct=EXCLUDED.rate_pct,
  gross_royalty_ex_tax=EXCLUDED.gross_royalty_ex_tax,mg_amount=EXCLUDED.mg_amount,
  mg_consumed_before=EXCLUDED.mg_consumed_before,
  mg_consumed_this_time=EXCLUDED.mg_consumed_this_time,
  mg_consumed_after=EXCLUDED.mg_consumed_after,mg_remaining=EXCLUDED.mg_remaining,
  mg_fully_consumed=EXCLUDED.mg_fully_consumed,
  actual_royalty_ex_tax=EXCLUDED.actual_royalty_ex_tax,
  tax_rate=EXCLUDED.tax_rate,tax_amount=EXCLUDED.tax_amount,
  total_payment_inc_tax=EXCLUDED.total_payment_inc_tax,currency=EXCLUDED.currency,
  period=EXCLUDED.period,reporting_deadline=EXCLUDED.reporting_deadline,
  payment_due_date=EXCLUDED.payment_due_date,notes=EXCLUDED.notes,
  ag_amount=EXCLUDED.ag_amount,ag_consumed_before=EXCLUDED.ag_consumed_before,
  ag_consumed_this_time=EXCLUDED.ag_consumed_this_time,
  ag_consumed_after=EXCLUDED.ag_consumed_after,ag_remaining=EXCLUDED.ag_remaining,
  ag_fully_consumed=EXCLUDED.ag_fully_consumed,
  condition_line_id=EXCLUDED.condition_line_id,
  source_out_condition_line_id=EXCLUDED.source_out_condition_line_id,
  basis_amount=EXCLUDED.basis_amount,deductions=EXCLUDED.deductions,
  event_type=EXCLUDED.event_type,occurred_at=EXCLUDED.occurred_at,
  source_form_data=EXCLUDED.source_form_data,updated_at=now();

-- E. Condition consumption event. Only create when the underlying IN/payable
-- condition is known. Missing linkage is flagged below instead of guessed.
WITH candidates AS (
  SELECT
    rc.id AS calculation_id,s.document_id,s.backlog_issue_key,s.condition_line_id,
    s.occurred_date,s.period,s.actual_royalty,s.mg_consumed_this_time,
    s.ag_consumed_this_time,rc.manufacturing_event_id,
    COALESCE(
      (SELECT MAX(existing.event_no)
         FROM condition_events existing
        WHERE existing.condition_line_id=s.condition_line_id),
      0
    ) +
    ROW_NUMBER() OVER (
      PARTITION BY s.condition_line_id
      ORDER BY s.occurred_date,s.document_id
    ) AS next_event_no
  FROM lb_m5_royalty_source s
  JOIN royalty_calculations rc ON rc.document_id=s.document_id
  WHERE s.condition_line_id IS NOT NULL
    AND s.actual_royalty IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM condition_events e
      WHERE e.condition_line_id=s.condition_line_id
        AND e.document_id=s.document_id
        AND e.event_type='royalty_calc'
        AND e.voided_at IS NULL
    )
)
INSERT INTO condition_events (
  condition_line_id,event_no,event_type,document_id,backlog_issue_key,occurred_at,
  period,amount_ex_tax,source_royalty_calculation_id,manufacturing_event_id,
  mg_consumed_this_time,ag_consumed_this_time
)
SELECT
  condition_line_id,next_event_no::int,'royalty_calc',document_id,backlog_issue_key,
  occurred_date::timestamptz,period,actual_royalty,calculation_id,
  manufacturing_event_id,mg_consumed_this_time,ag_consumed_this_time
FROM candidates;

UPDATE royalty_calculations rc
SET condition_event_id=e.id,updated_at=now()
FROM condition_events e
WHERE e.source_royalty_calculation_id=rc.id
  AND e.event_type='royalty_calc'
  AND e.voided_at IS NULL
  AND rc.condition_event_id IS DISTINCT FROM e.id;

-- F. Canonical statement header.
INSERT INTO royalty_statements (
  document_id,backlog_issue_key,contract_id,product_id,work_material_id,
  manufacturing_event_id,sales_event_id,calc_type,unit_price,quantity,
  sample_quantity,billable_quantity,rate_pct,gross_royalty_ex_tax,mg_amount,
  mg_consumed_before,mg_consumed_this_time,mg_consumed_after,mg_remaining,
  mg_fully_consumed,mg_topup_this_time,ag_amount,ag_consumed_before,
  ag_consumed_this_time,ag_consumed_after,ag_remaining,ag_fully_consumed,
  actual_royalty_ex_tax,tax_rate,tax_amount,total_payment_inc_tax,currency,period,
  reporting_deadline,payment_due_date,notes,source_condition_line_id,
  source_out_condition_line_id,event_type,occurred_at,basis_amount,deductions,
  source_form_data,updated_at
)
SELECT
  s.document_id,s.backlog_issue_key,s.contract_id,s.product_id,s.work_material_id,
  me.id,se.id,s.event_type,s.unit_price,s.quantity,s.sample_quantity,
  s.billable_quantity,s.rate_pct,s.gross_royalty,s.mg_amount,s.mg_consumed_before,
  s.mg_consumed_this_time,s.mg_consumed_after,s.mg_remaining,
  CASE WHEN s.mg_remaining IS NULL OR s.mg_amount IS NULL THEN NULL ELSE s.mg_remaining<=0 END,
  0,s.ag_amount,s.ag_consumed_before,s.ag_consumed_this_time,s.ag_consumed_after,
  s.ag_remaining,
  CASE WHEN s.ag_remaining IS NULL OR s.ag_amount IS NULL THEN NULL ELSE s.ag_remaining<=0 END,
  s.actual_royalty,s.tax_rate,s.tax_amount,s.total_payment,s.currency,s.period,
  s.reporting_deadline,s.payment_due_date,s.notes,s.condition_line_id,
  s.source_out_condition_line_id,s.event_type,s.occurred_date::timestamptz,
  s.basis_amount,s.deductions,s.f,now()
FROM lb_m5_royalty_source s
LEFT JOIN manufacturing_events me ON me.source_document_id=s.document_id
LEFT JOIN sales_events se ON se.source_document_id=s.document_id
ON CONFLICT (document_id) WHERE document_id IS NOT NULL
DO UPDATE SET
  backlog_issue_key=EXCLUDED.backlog_issue_key,contract_id=EXCLUDED.contract_id,
  product_id=EXCLUDED.product_id,work_material_id=EXCLUDED.work_material_id,
  manufacturing_event_id=EXCLUDED.manufacturing_event_id,
  sales_event_id=EXCLUDED.sales_event_id,calc_type=EXCLUDED.calc_type,
  unit_price=EXCLUDED.unit_price,quantity=EXCLUDED.quantity,
  sample_quantity=EXCLUDED.sample_quantity,billable_quantity=EXCLUDED.billable_quantity,
  rate_pct=EXCLUDED.rate_pct,gross_royalty_ex_tax=EXCLUDED.gross_royalty_ex_tax,
  mg_amount=EXCLUDED.mg_amount,mg_consumed_before=EXCLUDED.mg_consumed_before,
  mg_consumed_this_time=EXCLUDED.mg_consumed_this_time,
  mg_consumed_after=EXCLUDED.mg_consumed_after,mg_remaining=EXCLUDED.mg_remaining,
  mg_fully_consumed=EXCLUDED.mg_fully_consumed,ag_amount=EXCLUDED.ag_amount,
  ag_consumed_before=EXCLUDED.ag_consumed_before,
  ag_consumed_this_time=EXCLUDED.ag_consumed_this_time,
  ag_consumed_after=EXCLUDED.ag_consumed_after,ag_remaining=EXCLUDED.ag_remaining,
  ag_fully_consumed=EXCLUDED.ag_fully_consumed,
  actual_royalty_ex_tax=EXCLUDED.actual_royalty_ex_tax,
  tax_rate=EXCLUDED.tax_rate,tax_amount=EXCLUDED.tax_amount,
  total_payment_inc_tax=EXCLUDED.total_payment_inc_tax,currency=EXCLUDED.currency,
  period=EXCLUDED.period,reporting_deadline=EXCLUDED.reporting_deadline,
  payment_due_date=EXCLUDED.payment_due_date,notes=EXCLUDED.notes,
  source_condition_line_id=EXCLUDED.source_condition_line_id,
  source_out_condition_line_id=EXCLUDED.source_out_condition_line_id,
  event_type=EXCLUDED.event_type,occurred_at=EXCLUDED.occurred_at,
  basis_amount=EXCLUDED.basis_amount,deductions=EXCLUDED.deductions,
  source_form_data=EXCLUDED.source_form_data,updated_at=now();

-- G. Statement lines.
WITH expanded AS (
  SELECT
    s.*,
    rs.id AS royalty_statement_id,
    l.line_json,
    l.line_no
  FROM lb_m5_royalty_source s
  JOIN royalty_statements rs ON rs.document_id=s.document_id
  CROSS JOIN LATERAL (
    SELECT value AS line_json, ordinality::int AS line_no
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(s.f->'lines')='array'
         AND jsonb_array_length(s.f->'lines')>0
        THEN s.f->'lines'
        ELSE jsonb_build_array(
          jsonb_build_object(
            'productName',s.product_name,
            'sales_amount',s.basis_amount,
            'rate_pct',s.rate_pct,
            'royalty_amount',s.actual_royalty,
            'basisNote',s.notes
          )
        )
      END
    ) WITH ORDINALITY
  ) l
)
INSERT INTO royalty_statement_lines (
  royalty_statement_id,document_id,document_number,backlog_issue_key,line_no,group_no,
  contract_id,contract_title,contract_number,calc_method,product_name,intake_currency,
  fx_rate,sales_input,unit_price,quantity,sample_quantity,sales_jpy,rate_pct,payment_jpy,
  basis_note,source_condition_line_id,source_out_condition_line_id,gross_event_amount,
  deductions,source_json
)
SELECT
  e.royalty_statement_id,e.document_id,e.document_number,e.backlog_issue_key,e.line_no,
  COALESCE(pg_temp.lb_int(e.line_json->>'group_no'),1),
  e.contract_id,
  COALESCE(NULLIF(e.line_json->>'contractTitle',''),NULLIF(e.f->>'contractTitle',''),
           NULLIF(e.f->>'CONTRACT_TITLE','')),
  COALESCE(NULLIF(e.line_json->>'contractNumber',''),
           NULLIF(e.f->>'linked_contract_number',''),NULLIF(e.f->>'CONTRACT_NO','')),
  COALESCE(NULLIF(e.line_json->>'calc_method',''),e.event_type),
  COALESCE(NULLIF(e.line_json->>'productName',''),NULLIF(e.line_json->>'product_name',''),
           e.product_name),
  COALESCE(NULLIF(e.line_json->>'currency',''),NULLIF(e.line_json->>'intake_currency',''),
           e.currency),
  COALESCE(pg_temp.lb_num(e.line_json->>'fx_rate'),pg_temp.lb_num(e.f->>'fxRate')),
  COALESCE(pg_temp.lb_num(e.line_json->>'sales_input'),
           pg_temp.lb_num(e.line_json->>'sales_amount'),
           pg_temp.lb_num(e.line_json->>'base_amount'),e.basis_amount),
  COALESCE(pg_temp.lb_num(e.line_json->>'unit_price'),e.unit_price),
  COALESCE(pg_temp.lb_num(e.line_json->>'quantity'),e.quantity),
  COALESCE(pg_temp.lb_num(e.line_json->>'sample_quantity'),e.sample_quantity),
  CASE
    WHEN COALESCE(NULLIF(e.line_json->>'currency',''),e.currency)='JPY'
    THEN COALESCE(pg_temp.lb_num(e.line_json->>'sales_jpy'),
                  pg_temp.lb_num(e.line_json->>'sales_amount'),e.basis_amount)
    ELSE pg_temp.lb_num(e.line_json->>'sales_jpy')
  END,
  COALESCE(pg_temp.lb_num(e.line_json->>'rate_pct'),e.rate_pct),
  CASE
    WHEN COALESCE(NULLIF(e.line_json->>'currency',''),e.currency)='JPY'
    THEN COALESCE(pg_temp.lb_num(e.line_json->>'payment_jpy'),
                  pg_temp.lb_num(e.line_json->>'royalty_amount'),e.actual_royalty)
    ELSE pg_temp.lb_num(e.line_json->>'payment_jpy')
  END,
  COALESCE(NULLIF(e.line_json->>'basisNote',''),NULLIF(e.line_json->>'basis_note',''),e.notes),
  e.condition_line_id,e.source_out_condition_line_id,e.gross_event_amount,e.deductions,
  e.line_json
FROM expanded e
ON CONFLICT (royalty_statement_id,line_no) WHERE royalty_statement_id IS NOT NULL
DO UPDATE SET
  document_id=EXCLUDED.document_id,document_number=EXCLUDED.document_number,
  backlog_issue_key=EXCLUDED.backlog_issue_key,group_no=EXCLUDED.group_no,
  contract_id=EXCLUDED.contract_id,contract_title=EXCLUDED.contract_title,
  contract_number=EXCLUDED.contract_number,calc_method=EXCLUDED.calc_method,
  product_name=EXCLUDED.product_name,intake_currency=EXCLUDED.intake_currency,
  fx_rate=EXCLUDED.fx_rate,sales_input=EXCLUDED.sales_input,unit_price=EXCLUDED.unit_price,
  quantity=EXCLUDED.quantity,sample_quantity=EXCLUDED.sample_quantity,
  sales_jpy=EXCLUDED.sales_jpy,rate_pct=EXCLUDED.rate_pct,payment_jpy=EXCLUDED.payment_jpy,
  basis_note=EXCLUDED.basis_note,
  source_condition_line_id=EXCLUDED.source_condition_line_id,
  source_out_condition_line_id=EXCLUDED.source_out_condition_line_id,
  gross_event_amount=EXCLUDED.gross_event_amount,deductions=EXCLUDED.deductions,
  source_json=EXCLUDED.source_json;

-- H. Link legacy royalty_payments only to payments that already clearly exist.
WITH matches AS (
  SELECT
    rp.id AS royalty_payment_id,
    p.id AS payment_id,
    ROW_NUMBER() OVER (
      PARTITION BY rp.id
      ORDER BY
        CASE WHEN NULLIF(p.backlog_issue_key,'')=NULLIF(rp.backlog_issue_key,'') THEN 0 ELSE 1 END,
        CASE WHEN p.due_date IS NOT DISTINCT FROM rp.payment_due_date THEN 0 ELSE 1 END,
        p.id
    ) AS rn
  FROM royalty_payments rp
  JOIN payments p
    ON (
         NULLIF(p.backlog_issue_key,'')=NULLIF(rp.backlog_issue_key,'')
         OR (
           p.contract_id IS NOT NULL
           AND p.contract_id=rp.license_contract_id
           AND p.due_date IS NOT DISTINCT FROM rp.payment_due_date
         )
       )
   AND (
        COALESCE(p.payment_kind,'') ILIKE '%royalty%'
        OR COALESCE(p.payment_kind,'') ILIKE '%license%'
       )
)
UPDATE royalty_payments rp
SET payment_id=m.payment_id
FROM matches m
WHERE m.royalty_payment_id=rp.id
  AND m.rn=1
  AND rp.payment_id IS NULL;

UPDATE payments p
SET legacy_royalty_payment_id=rp.id
FROM royalty_payments rp
WHERE rp.payment_id=p.id
  AND p.legacy_royalty_payment_id IS NULL;

-- I. Data-quality issues instead of unsafe guesses.
INSERT INTO data_quality_issues (
  entity_type,entity_id,rule_code,severity,status,detected_at,last_detected_at,detail
)
SELECT
  'document',s.document_id,'ROYALTY_STATEMENT_CONDITION_UNRESOLVED','warning','open',
  now(),now(),
  jsonb_build_object(
    'document_number',s.document_number,
    'issue_key',s.issue_key,
    'event_type',s.event_type,
    'candidate_condition_line_id',s.candidate_condition_line_id
  )
FROM lb_m5_royalty_source s
WHERE s.condition_line_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM data_quality_issues q
    WHERE q.entity_type='document'
      AND q.entity_id=s.document_id
      AND q.rule_code='ROYALTY_STATEMENT_CONDITION_UNRESOLVED'
      AND q.status='open'
  );

INSERT INTO data_quality_issues (
  entity_type,entity_id,rule_code,severity,status,detected_at,last_detected_at,detail
)
SELECT
  'document',s.document_id,'ROYALTY_STATEMENT_AMOUNT_UNRESOLVED','error','open',
  now(),now(),
  jsonb_build_object(
    'document_number',s.document_number,
    'issue_key',s.issue_key,
    'rate_pct',s.rate_pct,
    'basis_amount',s.basis_amount
  )
FROM lb_m5_royalty_source s
WHERE s.actual_royalty IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM data_quality_issues q
    WHERE q.entity_type='document'
      AND q.entity_id=s.document_id
      AND q.rule_code='ROYALTY_STATEMENT_AMOUNT_UNRESOLVED'
      AND q.status='open'
  );

INSERT INTO data_quality_issues (
  entity_type,entity_id,rule_code,severity,status,detected_at,last_detected_at,detail
)
SELECT
  'royalty_payment',rp.id,'ROYALTY_PAYMENT_LINK_UNRESOLVED','warning','open',
  now(),now(),
  jsonb_build_object(
    'backlog_issue_key',rp.backlog_issue_key,
    'license_contract_id',rp.license_contract_id,
    'payment_due_date',rp.payment_due_date,
    'total_amount',rp.total_amount,
    'status',rp.status
  )
FROM royalty_payments rp
WHERE rp.payment_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM data_quality_issues q
    WHERE q.entity_type='royalty_payment'
      AND q.entity_id=rp.id
      AND q.rule_code='ROYALTY_PAYMENT_LINK_UNRESOLVED'
      AND q.status='open'
  );

-- Resolve issues automatically when backfill later becomes complete.
UPDATE data_quality_issues q
SET status='resolved',resolved_at=now(),resolution_type='auto_backfill',
    resolution_note='M5 royalty normalization resolved canonical linkage.'
FROM royalty_statements rs
WHERE q.entity_type='document'
  AND q.entity_id=rs.document_id
  AND q.rule_code='ROYALTY_STATEMENT_CONDITION_UNRESOLVED'
  AND q.status='open'
  AND rs.source_condition_line_id IS NOT NULL;

UPDATE data_quality_issues q
SET status='resolved',resolved_at=now(),resolution_type='auto_backfill',
    resolution_note='M5 royalty normalization restored royalty amount.'
FROM royalty_statements rs
WHERE q.entity_type='document'
  AND q.entity_id=rs.document_id
  AND q.rule_code='ROYALTY_STATEMENT_AMOUNT_UNRESOLVED'
  AND q.status='open'
  AND rs.actual_royalty_ex_tax IS NOT NULL;

UPDATE data_quality_issues q
SET status='resolved',resolved_at=now(),resolution_type='linked_existing_payment',
    resolution_note='Legacy royalty payment linked to existing payments row.'
FROM royalty_payments rp
WHERE q.entity_type='royalty_payment'
  AND q.entity_id=rp.id
  AND q.rule_code='ROYALTY_PAYMENT_LINK_UNRESOLVED'
  AND q.status='open'
  AND rp.payment_id IS NOT NULL;

COMMIT;
