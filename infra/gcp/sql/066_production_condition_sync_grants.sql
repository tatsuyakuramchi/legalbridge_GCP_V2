\set ON_ERROR_STOP on
\pset pager off

-- 066_production_condition_sync_grants.sql
-- 文書確定時の条件明細（condition_lines）同期に必要な権限。
--   V2 の文書作成画面から発行した利用許諾条件書・発注書の経済条件
--   （料率・MG/AG・地域言語）を V1 と同じく condition_lines へ upsert し、
--   条件明細一覧・ライセンスマトリクス・消化管理へ反映させる（監査2026-08-25 ギャップ1）。
--   - upsert のため UPDATE、置換セマンティクスの安全削除のため DELETE を付与。
--     削除はアプリ側 SQL が「実績（condition_events）・作品参照（work_material_uses）を
--     持たない行のみ」に常にガードする。
--   - 地域/言語の子テーブルは DELETE→INSERT の置換保存。
--   - line_code 採番は document_sequences（既存の kind 方式・INSERT/UPDATE は 007 系で付与済みの
--     想定だが冪等に再付与する）。

\if :{?confirm_condition_sync}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_condition_sync=GRANT_PRODUCTION_CONDITION_SYNC'
  \quit 2
\endif

SELECT :'confirm_condition_sync' = 'GRANT_PRODUCTION_CONDITION_SYNC' AS confirmed
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
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'condition_lines'
  ) THEN
    RAISE EXCEPTION 'Table condition_lines does not exist';
  END IF;
END
$guard$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.condition_lines TO legalbridge_v2_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.condition_lines_id_seq TO legalbridge_v2_runtime;

GRANT SELECT, INSERT, DELETE ON TABLE public.condition_line_regions TO legalbridge_v2_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.condition_line_regions_id_seq TO legalbridge_v2_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE public.condition_line_languages TO legalbridge_v2_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.condition_line_languages_id_seq TO legalbridge_v2_runtime;

-- line_code 採番（既存 kind 方式）。冪等に再付与。
GRANT SELECT, INSERT, UPDATE ON TABLE public.document_sequences TO legalbridge_v2_runtime;
-- 素材結線の解決（読み取りのみ）。
GRANT SELECT ON TABLE public.work_materials TO legalbridge_v2_runtime;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime'
       AND table_schema = 'public' AND table_name = 'condition_lines'
       AND privilege_type = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'condition_lines DELETE grant was not applied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime'
       AND table_schema = 'public' AND table_name = 'condition_lines'
       AND privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'condition_lines UPDATE grant was not applied';
  END IF;
END
$verify$;

COMMIT;
