\set ON_ERROR_STOP on
\pset pager off

-- 021_matter_overview_requester_introspect.sql
-- 読取専用。matter_overview_v の依頼者メール露出（gap ⑥）を安全に拡張するための
-- 事前調査。ビュー現行定義は本 repo に無い（V1本番側の既存ビュー）ため、
-- 実DBから現行 DDL と候補列を吸い出し、拡張案（別ファイル/手順）を確定する材料にする。
-- 変更は一切行わない。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.matter_overview_v') IS NULL THEN
    RAISE EXCEPTION 'View public.matter_overview_v is missing';
  END IF;
END
$guard$;

\echo '== (1) matter_overview_v 現行定義（CREATE OR REPLACE の土台にする） =='
SELECT pg_get_viewdef('public.matter_overview_v'::regclass, true) AS matter_overview_v_definition;

\echo '== (2) matter_overview_v の現行カラム（requester_email/created_by が既に出ているか確認） =='
SELECT ordinal_position, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'matter_overview_v'
ORDER BY ordinal_position;

\echo '== (3) matters テーブルの依頼者メール候補列（派生元の特定） =='
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'matters'
  AND (
    column_name ILIKE '%requester%'
    OR column_name ILIKE '%created_by%'
    OR column_name ILIKE '%owner%'
    OR column_name ILIKE '%email%'
    OR column_name ILIKE '%applicant%'
    OR column_name ILIKE '%依頼%'
  )
ORDER BY column_name;

\echo '== (4) 参考: documents.created_by（依頼者メールの代替源になり得るか） =='
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'documents'
  AND column_name IN ('created_by')
ORDER BY column_name;

\echo '== 調査完了。アプリ側 mapSummary は requester_email -> created_by -> requester の順で読む。 =='
\echo '== ビューが上記いずれかの列名で依頼者メールを露出すれば、コード側(スライス5-3修正済)が解決可能。 =='
