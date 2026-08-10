\set ON_ERROR_STOP on
\pset pager off

-- 041_production_reissue_repoint_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（適用は 041_production_reissue_repoint_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.condition_events') IS NULL THEN
    RAISE EXCEPTION 'Relation public.condition_events is missing';
  END IF;
END
$guard$;

-- 現在の condition_events への列 UPDATE 権限（document_id が無いはず）。
SELECT column_name, privilege_type
FROM information_schema.role_column_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public' AND table_name = 'condition_events' AND privilege_type = 'UPDATE'
ORDER BY column_name;

-- 再発行台帳の列名（canceled_events → carried_events 改名前の確認）。
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'lb_v2_document_reissue_ledger'
ORDER BY ordinal_position;

-- 過去に V2 旧方式（void）で再発行された文書の有無。行が返る場合、その実績は void されたままで
-- 残高が消えている。必要なら void_reason を手掛かりに個別リカバリ（voided_at を NULL に戻す）を検討。
SELECT l.source_number, l.new_number, l.canceled_events AS voided_by_old_reissue, l.reissued_at
FROM public.lb_v2_document_reissue_ledger l
WHERE l.canceled_events > 0
ORDER BY l.reissued_at;
