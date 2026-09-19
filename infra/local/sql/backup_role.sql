-- 予備系への同期に使う読み取り専用ロール。Cloud SQL Studio で1回だけ流す。
--   ・v3 スキーマを読むだけ。public（V1・V2）には触れない。書き込みもできない。
--   ・パスワードは <PASSWORD> を置き換えてから流し、infra/local/.env の SYNC_DB_PASSWORD に書く。
--   ・v3 に表を足したあとは、003_grants.sql と同じく最後の2文を流し直す（既存表への GRANT）。
CREATE ROLE legalbridge_v3_backup LOGIN PASSWORD '<PASSWORD>';
GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v3_backup;
GRANT USAGE ON SCHEMA v3 TO legalbridge_v3_backup;
REVOKE ALL ON SCHEMA public FROM legalbridge_v3_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA v3 TO legalbridge_v3_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA v3 TO legalbridge_v3_backup;
-- 今後 v3 に増える表・シーケンスも読めるように。
ALTER DEFAULT PRIVILEGES IN SCHEMA v3 GRANT SELECT ON TABLES TO legalbridge_v3_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA v3 GRANT SELECT ON SEQUENCES TO legalbridge_v3_backup;

-- 確認：読める表の数（v3 の表と同じ数になる）
SELECT count(*) AS readable_tables
  FROM information_schema.table_privileges
 WHERE grantee = 'legalbridge_v3_backup' AND table_schema = 'v3' AND privilege_type = 'SELECT';
