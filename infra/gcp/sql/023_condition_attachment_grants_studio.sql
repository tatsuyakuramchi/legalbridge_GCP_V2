-- 023_condition_attachment_grants_studio.sql
-- LegalBridge V2: runtime privileges for retroactive document condition attachment.

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT ON TABLE
  public.documents,
  public.condition_lines,
  public.condition_line_regions,
  public.condition_line_languages,
  public.works,
  public.work_materials,
  public.contracts,
  public.contract_works,
  public.material_rights_sources,
  public.vendors
TO legalbridge_v2_runtime;

GRANT UPDATE ON TABLE
  public.documents,
  public.condition_lines
TO legalbridge_v2_runtime;

GRANT INSERT ON TABLE
  public.condition_lines,
  public.condition_line_regions,
  public.condition_line_languages,
  public.contract_works,
  public.material_rights_sources
TO legalbridge_v2_runtime;

GRANT DELETE ON TABLE
  public.condition_line_regions,
  public.condition_line_languages
TO legalbridge_v2_runtime;

GRANT USAGE,SELECT ON SEQUENCE
  public.condition_lines_id_seq,
  public.condition_line_regions_id_seq,
  public.condition_line_languages_id_seq,
  public.contract_works_id_seq,
  public.material_rights_sources_id_seq
TO legalbridge_v2_runtime;

COMMIT;
