-- =====================================================================
-- V3移行 003：ランタイムロールの権限
--   legalbridge_v3_runtime に v3 スキーマだけを触らせる。
--   public（V1・V2 の表）への権限は一切与えない。これが V1 と並行稼働する
--   あいだの安全境界になる。
--
--   実行: psql "$ADMIN_DSN" -v confirm_v3_grants=GRANT_V3_RUNTIME \
--           -f infra/v3/003_grants.sql
--   前提: ロールが未作成なら先に
--           CREATE ROLE legalbridge_v3_runtime LOGIN PASSWORD '...';
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

\if :{?confirm_v3_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_v3_grants=GRANT_V3_RUNTIME'
  \quit 2
\endif

SELECT :'confirm_v3_grants' = 'GRANT_V3_RUNTIME' AS confirmed \gset
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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v3_runtime') THEN
    RAISE EXCEPTION
      'role legalbridge_v3_runtime does not exist. Create it first with CREATE ROLE ... LOGIN PASSWORD.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'v3') THEN
    RAISE EXCEPTION 'schema v3 does not exist. Apply infra/v3/001_schema.sql first.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------
-- 接続とスキーマ
-- ---------------------------------------------------------------------
GRANT CONNECT ON DATABASE :"DBNAME" TO legalbridge_v3_runtime;
GRANT USAGE ON SCHEMA v3 TO legalbridge_v3_runtime;
-- public には USAGE すら与えない。誤って旧表を読み書きする経路を作らない。
REVOKE ALL ON SCHEMA public FROM legalbridge_v3_runtime;

-- ---------------------------------------------------------------------
-- 付与は「読み取りは全部、書込は実テーブルだけ」の順で行う。
-- ALL TABLES はビューも含むため、書込をまとめて付けるとビューにも付いてしまう。
-- ---------------------------------------------------------------------

-- 1. 読み取りは表もビューも一律。
GRANT SELECT ON ALL TABLES IN SCHEMA v3 TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA v3 TO legalbridge_v3_runtime;

-- 2. 書込は実テーブルだけに個別付与する（ビューは除く）。
DO $write$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'v3' LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON v3.%I TO legalbridge_v3_runtime', r.tablename);
  END LOOP;
END
$write$;

-- 3. ここから絞る。順序が大事で、これらは付与のあとに来る必要がある。

-- 監査は追記専用。書き換えも削除もさせない。
REVOKE UPDATE, DELETE, TRUNCATE ON v3.audit_events FROM legalbridge_v3_runtime;

-- 口座情報は既定で見せない。経理の出力を有効にするときだけ別途 GRANT する。
REVOKE ALL ON v3.party_bank_accounts FROM legalbridge_v3_runtime;

-- テンプレート本文は読み取りのみ。改訂は管理者の運用でやる（互換境界）。
REVOKE INSERT, UPDATE, DELETE ON v3.document_templates FROM legalbridge_v3_runtime;
REVOKE INSERT, UPDATE, DELETE ON v3.document_template_versions FROM legalbridge_v3_runtime;

-- TRUNCATE はどの表にも与えない。
DO $revoke$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'v3' LOOP
    EXECUTE format('REVOKE TRUNCATE ON v3.%I FROM legalbridge_v3_runtime', r.tablename);
  END LOOP;
END
$revoke$;

-- 今後 001 に表を足したときも同じ既定が効くようにする。
ALTER DEFAULT PRIVILEGES IN SCHEMA v3
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO legalbridge_v3_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA v3
  GRANT USAGE, SELECT ON SEQUENCES TO legalbridge_v3_runtime;

COMMIT;

-- ---------------------------------------------------------------------
-- 確認：付いた権限を出す。想定外が無いことを目視する。
-- ---------------------------------------------------------------------
BEGIN READ ONLY;

\echo '--- v3 スキーマで legalbridge_v3_runtime が持つ権限 ---'
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_v3_runtime' AND table_schema = 'v3'
 GROUP BY table_name
 ORDER BY table_name;

\echo '--- 想定外の権限（v3 以外・TRUNCATE・口座表・テンプレ書込があれば異常）---'
SELECT table_schema, table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_v3_runtime'
   AND (table_schema <> 'v3'
        OR privilege_type = 'TRUNCATE'
        OR table_name = 'party_bank_accounts'
        OR (table_name IN ('document_templates', 'document_template_versions')
            AND privilege_type <> 'SELECT')
        OR (table_name = 'audit_events' AND privilege_type IN ('UPDATE', 'DELETE'))
        OR (table_name LIKE 'v\\_%' AND privilege_type <> 'SELECT'))
 ORDER BY table_schema, table_name, privilege_type;

COMMIT;
