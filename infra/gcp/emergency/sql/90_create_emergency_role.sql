\set ON_ERROR_STOP on

-- 90_create_emergency_role.sql — 緊急登録専用ロールの作成（管理者が事前に1回実行）。
-- アプリ用 legalbridge_v2_runtime とは別の、人が使う最小権限ロール。
--   ・INSERT できるのは vendors / staff / documents のみ（DELETE・TRUNCATE 権限なし）
--   ・vendor_code 採番と文書採番に必要な UPDATE を限定付与
--   ・平時は NOLOGIN で寝かせ、発動時に LOGIN を付与し、終了後に戻す
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_emergency_role=CREATE_EMERGENCY_ROLE \
--         -f infra/gcp/emergency/sql/90_create_emergency_role.sql
-- 発動時: ALTER ROLE legalbridge_emergency LOGIN PASSWORD '<一時パスワード>' VALID UNTIL '<期限>';
-- 終了時: ALTER ROLE legalbridge_emergency NOLOGIN;

\if :{?confirm_emergency_role}
\else
  \echo 'Run with: -v confirm_emergency_role=CREATE_EMERGENCY_ROLE'
  \quit 2
\endif
SELECT :'confirm_emergency_role' = 'CREATE_EMERGENCY_ROLE' AS ok \gset
\if :ok
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_emergency') THEN
    CREATE ROLE legalbridge_emergency NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

-- 読取（照合・検証に必要な範囲）
GRANT SELECT ON TABLE vendors, staff, documents, matters,
                     document_templates, document_template_versions,
                     document_sequences TO legalbridge_emergency;

-- 書込（緊急登録の対象のみ）
GRANT INSERT ON TABLE vendors, staff, documents TO legalbridge_emergency;
-- vendor_code の VEN- 採番に必要
GRANT UPDATE (vendor_code) ON vendors TO legalbridge_emergency;
-- 文書採番（本番と同じ採番表の UPSERT）に必要
GRANT INSERT, UPDATE ON TABLE document_sequences TO legalbridge_emergency;

-- id 採番シーケンス
DO $$
DECLARE seq text;
BEGIN
  FOREACH seq IN ARRAY ARRAY[
    pg_get_serial_sequence('vendors', 'id'),
    pg_get_serial_sequence('staff', 'id'),
    pg_get_serial_sequence('documents', 'id')
  ] LOOP
    IF seq IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO legalbridge_emergency', seq);
    END IF;
  END LOOP;
END $$;

-- 確認
SELECT rolname, rolcanlogin, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname = 'legalbridge_emergency';
SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_emergency'
 ORDER BY table_name, privilege_type;
