\set ON_ERROR_STOP on
\pset pager off

\if :{?confirm_contract_intake_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_contract_intake_grants=GRANT_PRODUCTION_CONTRACT_INTAKE'
  \quit 2
\endif

SELECT :'confirm_contract_intake_grants' = 'GRANT_PRODUCTION_CONTRACT_INTAKE' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no privileges were changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime'
  ) THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'works',
    'work_materials',
    'material_categories',
    'material_rights_sources',
    'contracts',
    'contract_works',
    'work_relations',
    'condition_line_regions',
    'condition_line_languages',
    'documents',
    'condition_lines',
    'document_sequences',
    'vendors'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required contract-intake relation public.% is missing', relation_name;
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY ARRAY[
    'works_id_seq',
    'work_materials_id_seq',
    'material_categories_id_seq',
    'material_rights_sources_id_seq',
    'contracts_id_seq',
    'contract_works_id_seq',
    'work_relations_id_seq',
    'condition_line_regions_id_seq',
    'condition_line_languages_id_seq'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required contract-intake sequence public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;
GRANT EXECUTE ON FUNCTION public.lb_norm_name(text)
TO legalbridge_v2_runtime;

GRANT SELECT ON TABLE
  public.vendors
TO legalbridge_v2_runtime;

GRANT SELECT, INSERT ON TABLE
  public.works,
  public.work_materials,
  public.material_categories,
  public.material_rights_sources,
  public.contracts,
  public.contract_works,
  public.work_relations,
  public.condition_line_regions,
  public.condition_line_languages
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.works_id_seq,
  public.work_materials_id_seq,
  public.material_categories_id_seq,
  public.material_rights_sources_id_seq,
  public.contracts_id_seq,
  public.contract_works_id_seq,
  public.work_relations_id_seq,
  public.condition_line_regions_id_seq,
  public.condition_line_languages_id_seq
TO legalbridge_v2_runtime;

COMMIT;
