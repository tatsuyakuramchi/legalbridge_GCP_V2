\set ON_ERROR_STOP on
\pset pager off

-- 00_preflight.sql — 緊急DB登録の事前確認（書込みなし・何度でも実行可）。
-- 「LegalBridge V2停止時 緊急DB登録・CSV作成マニュアル」§6 に対応。
-- 実行: psql "$EMERGENCY_DSN" -f infra/gcp/emergency/sql/00_preflight.sql

\echo '=== 1. 接続先の確認（database は legalbridge であること）==='
SELECT current_database() AS database,
       current_user       AS db_user,
       now()              AS server_time;
SHOW transaction_read_only;

\echo ''
\echo '=== 2. 本番DBであることの機械チェック（f 以外なら中止）==='
SELECT current_database() = 'legalbridge' AS is_production_db;

\echo ''
\echo '=== 3. active テンプレートと現行版（文書登録の前提）==='
SELECT dt.template_key, dt.document_prefix, dt.current_version_id,
       dtv.version_no, dt.is_active
  FROM document_templates dt
  JOIN document_template_versions dtv ON dtv.id = dt.current_version_id
 WHERE dt.is_active = true
 ORDER BY dt.template_key;

\echo ''
\echo '=== 4. 主要テーブルの現在件数（実行後の増分確認の基準）==='
SELECT 'vendors' AS table_name, COUNT(*) AS rows FROM vendors
UNION ALL SELECT 'staff', COUNT(*) FROM staff
UNION ALL SELECT 'documents', COUNT(*) FROM documents
ORDER BY table_name;

\echo ''
\echo '=== 5. 採番の現在値（documents 自動採番は本番と同じ採番表を使う）==='
SELECT kind, year, current_value
  FROM document_sequences
 ORDER BY year DESC, kind
 LIMIT 30;

\echo ''
\echo '=== 6. 権限の確認（緊急ロールに必要な INSERT があるか）==='
SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = current_user
   AND table_name IN ('vendors', 'staff', 'documents', 'document_sequences')
 ORDER BY table_name, privilege_type;

\echo ''
\echo 'preflight 完了。上記に異常が無ければ、承認を得て 01〜03 の実行へ進む。'
