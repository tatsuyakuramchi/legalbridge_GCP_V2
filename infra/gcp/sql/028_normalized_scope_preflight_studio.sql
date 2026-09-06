-- 028_normalized_scope_preflight_studio.sql
-- LegalBridge V2: normalized territory/language preflight. READ ONLY.

BEGIN READ ONLY;

DO $guard$
DECLARE relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[
    'condition_lines','condition_line_regions','condition_line_languages'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required relation public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

-- 1. Child-table column capacity. WORLD requires 5 chars; ALL requires 3 chars.
SELECT
  table_name,
  column_name,
  data_type,
  character_maximum_length,
  is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND (
    (table_name='condition_line_regions' AND column_name IN (
      'condition_line_id','country_code','country_name','sort_order'
    ))
    OR
    (table_name='condition_line_languages' AND column_name IN (
      'condition_line_id','language_code','language_name','sort_order'
    ))
  )
ORDER BY table_name,column_name;

-- 2. Constraints on child tables.
SELECT
  c.relname AS table_name,
  con.conname,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid=con.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public'
  AND c.relname IN ('condition_line_regions','condition_line_languages')
ORDER BY c.relname,con.conname;

-- 3. Runtime privileges needed for transactional replace/write.
SELECT
  has_table_privilege('legalbridge_v2_runtime','public.condition_line_regions','SELECT,INSERT,DELETE') AS regions_rw_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_line_languages','SELECT,INSERT,DELETE') AS languages_rw_ok,
  has_table_privilege('legalbridge_v2_runtime','public.condition_lines','SELECT,INSERT,UPDATE') AS condition_lines_rw_ok;

-- 4. Current normalized coverage.
SELECT
  COUNT(*) AS condition_lines,
  COUNT(*) FILTER (
    WHERE EXISTS (SELECT 1 FROM condition_line_regions r WHERE r.condition_line_id=cl.id)
  ) AS with_region_rows,
  COUNT(*) FILTER (
    WHERE EXISTS (SELECT 1 FROM condition_line_languages l WHERE l.condition_line_id=cl.id)
  ) AS with_language_rows,
  COUNT(*) FILTER (
    WHERE region_territory IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM condition_line_regions r WHERE r.condition_line_id=cl.id)
  ) AS legacy_region_only,
  COUNT(*) FILTER (
    WHERE region_language IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM condition_line_languages l WHERE l.condition_line_id=cl.id)
  ) AS legacy_language_only
FROM condition_lines cl;

-- 5. Existing special-code usage.
SELECT country_code,country_name,COUNT(*) AS rows
FROM condition_line_regions
WHERE UPPER(country_code)='WORLD'
GROUP BY country_code,country_name;

SELECT language_code,language_name,COUNT(*) AS rows
FROM condition_line_languages
WHERE UPPER(language_code)='ALL'
GROUP BY language_code,language_name;

-- 6. IN conditions with canonical child rows: candidates for strict OUT validation.
SELECT
  cl.id,
  cl.condition_name,
  cl.work_id,
  cl.region_territory,
  cl.region_language,
  COUNT(DISTINCT r.id) AS region_rows,
  COUNT(DISTINCT l.id) AS language_rows
FROM condition_lines cl
LEFT JOIN condition_line_regions r ON r.condition_line_id=cl.id
LEFT JOIN condition_line_languages l ON l.condition_line_id=cl.id
WHERE (cl.flow_direction='in' OR cl.direction='payable')
  AND COALESCE(cl.transaction_kind,'license')='license'
GROUP BY cl.id
ORDER BY cl.id DESC
LIMIT 100;

ROLLBACK;
