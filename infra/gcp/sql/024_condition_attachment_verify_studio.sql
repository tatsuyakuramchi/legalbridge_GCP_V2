-- 024_condition_attachment_verify_studio.sql
-- LegalBridge V2: retroactive condition attachment verification. READ ONLY.

SELECT
  has_table_privilege('legalbridge_v2_runtime','public.documents','SELECT,UPDATE') AS documents_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_lines','SELECT,INSERT,UPDATE') AS condition_lines_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_line_regions','SELECT,INSERT,DELETE') AS regions_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_line_languages','SELECT,INSERT,DELETE') AS languages_ok,
  has_table_privilege('legalbridge_v2_runtime','public.contract_works','SELECT,INSERT') AS contract_works_ok,
  has_table_privilege('legalbridge_v2_runtime','public.material_rights_sources','SELECT,INSERT') AS material_rights_sources_ok;

-- Documents that now have condition links.
SELECT
  COUNT(DISTINCT d.id) AS documents_with_conditions,
  COUNT(DISTINCT d.id) FILTER (WHERE cl.work_id IS NOT NULL) AS documents_with_work_link,
  COUNT(DISTINCT d.id) FILTER (
    WHERE cl.transaction_kind='license' AND cl.flow_direction='in'
  ) AS documents_with_license_in,
  COUNT(DISTINCT d.id) FILTER (
    WHERE cl.transaction_kind='license' AND cl.flow_direction='out'
  ) AS documents_with_license_out
FROM documents d
JOIN condition_lines cl ON cl.document_id=d.id;

-- License condition integrity.
SELECT
  COUNT(*) AS license_conditions,
  COUNT(*) FILTER (WHERE work_id IS NULL) AS missing_work,
  COUNT(*) FILTER (
    WHERE flow_direction='out' AND parent_license_condition_id IS NULL
  ) AS out_missing_parent_in,
  COUNT(*) FILTER (
    WHERE flow_direction='in' AND source_material_id IS NOT NULL
      AND material_rights_source_id IS NULL
  ) AS material_in_missing_rights_source
FROM condition_lines
WHERE transaction_kind='license';

-- Parent IN must reference the same work.
SELECT
  child.id AS out_condition_id,
  child.work_id AS out_work_id,
  parent.id AS parent_in_id,
  parent.work_id AS parent_work_id
FROM condition_lines child
JOIN condition_lines parent ON parent.id=child.parent_license_condition_id
WHERE child.transaction_kind='license'
  AND child.flow_direction='out'
  AND child.work_id IS DISTINCT FROM parent.work_id
ORDER BY child.id;

-- Material rights source must point back to the attached document.
SELECT
  cl.id AS condition_line_id,cl.document_id,cl.source_material_id,
  cl.material_rights_source_id,mrs.source_document_id,mrs.material_id
FROM condition_lines cl
JOIN material_rights_sources mrs ON mrs.id=cl.material_rights_source_id
WHERE cl.transaction_kind='license'
  AND cl.flow_direction='in'
  AND (
    mrs.source_document_id IS DISTINCT FROM cl.document_id
    OR mrs.material_id IS DISTINCT FROM cl.source_material_id
  )
ORDER BY cl.id;
