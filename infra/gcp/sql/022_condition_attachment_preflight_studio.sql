-- 022_condition_attachment_preflight_studio.sql
-- LegalBridge V2: retroactive condition attachment preflight
-- Cloud SQL Studio compatible. READ ONLY.

DO $guard$
DECLARE relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[
    'documents','condition_lines','condition_line_regions','condition_line_languages',
    'works','work_materials','contracts','contract_works','material_rights_sources','vendors'
  ]
  LOOP
    IF to_regclass(format('public.%I',relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required relation public.% is missing',relation_name;
    END IF;
  END LOOP;
END
$guard$;

-- 1. Required columns.
SELECT table_name,column_name,data_type,is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND (
    (table_name='documents' AND column_name IN (
      'id','contract_id','ledger_ref_id','material_ref_id','flow_direction',
      'template_type','contract_category','contract_type','original_work','work_name'
    ))
    OR
    (table_name='condition_lines' AND column_name IN (
      'document_id','work_id','source_work_id','source_material_id',
      'parent_license_condition_id','material_rights_source_id',
      'flow_direction','is_inbound','transaction_kind'
    ))
    OR
    (table_name='material_rights_sources' AND column_name IN (
      'material_id','source_work_id','source_document_id','source_contract_id',
      'rights_holder_vendor_id','source_role','is_primary'
    ))
  )
ORDER BY table_name,column_name;

-- 2. Past / license-like documents without any condition line.
SELECT
  d.id,d.document_number,d.template_type,d.contract_category,d.contract_type,
  d.flow_direction,d.contract_id,d.ledger_ref_id,d.material_ref_id,
  d.original_work,d.work_name,d.created_at
FROM documents d
WHERE d.is_active IS DISTINCT FROM false
  AND NOT EXISTS (SELECT 1 FROM condition_lines cl WHERE cl.document_id=d.id)
  AND (
    d.template_type ILIKE '%license%'
    OR COALESCE(d.contract_category,'') ILIKE '%license%'
    OR COALESCE(d.contract_type,'') ILIKE '%license%'
    OR COALESCE(d.template_type,'') IN (
      'individual_license_terms','individual_license_terms_v3',
      'license_master','license_out_en','igla_license_en','igla_license_annex_en'
    )
  )
ORDER BY d.created_at DESC NULLS LAST,d.id DESC;

-- 3. How much work linkage can already be recovered without guessing.
WITH candidates AS (
  SELECT d.id,d.contract_id,d.ledger_ref_id,d.material_ref_id
  FROM documents d
  WHERE NOT EXISTS (SELECT 1 FROM condition_lines cl WHERE cl.document_id=d.id)
),
resolved AS (
  SELECT c.id,
         c.ledger_ref_id AS direct_work_id,
         wm.work_id AS material_work_id,
         cw.work_id AS contract_work_id,
         COUNT(cw.id) OVER(PARTITION BY c.id) AS contract_work_count
  FROM candidates c
  LEFT JOIN work_materials wm ON wm.id=c.material_ref_id
  LEFT JOIN contract_works cw ON cw.contract_id=c.contract_id
)
SELECT
  COUNT(DISTINCT id) AS documents_without_conditions,
  COUNT(DISTINCT id) FILTER (WHERE direct_work_id IS NOT NULL) AS direct_work_hint,
  COUNT(DISTINCT id) FILTER (WHERE direct_work_id IS NULL AND material_work_id IS NOT NULL) AS material_work_hint,
  COUNT(DISTINCT id) FILTER (
    WHERE direct_work_id IS NULL AND material_work_id IS NULL AND contract_work_count=1
  ) AS single_contract_work_hint
FROM resolved;

-- 4. Existing condition rows that can later be attached rather than duplicated.
SELECT
  cl.id,cl.line_code,cl.condition_name,cl.work_id,w.title AS work_title,
  cl.flow_direction,cl.direction,cl.transaction_kind,cl.document_id,cl.capability_id
FROM condition_lines cl
LEFT JOIN works w ON w.id=cl.work_id
WHERE cl.document_id IS NULL
ORDER BY cl.updated_at DESC NULLS LAST,cl.id DESC
LIMIT 300;

-- 5. OUT license rows lacking a parent IN condition.
SELECT
  cl.id,cl.condition_name,cl.work_id,w.title AS work_title,
  cl.document_id,d.document_number,cl.counterparty_vendor_id
FROM condition_lines cl
LEFT JOIN works w ON w.id=cl.work_id
LEFT JOIN documents d ON d.id=cl.document_id
WHERE (cl.flow_direction='out' OR cl.direction='receivable')
  AND COALESCE(cl.transaction_kind,'license')='license'
  AND cl.parent_license_condition_id IS NULL
ORDER BY cl.updated_at DESC NULLS LAST,cl.id DESC;
