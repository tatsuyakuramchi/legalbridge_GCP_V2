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

-- 口座情報。支払通知書・請求書は振込先が無いと書類として成立しないので、
-- 読み取りを開ける（2026-09-08 の判断）。
--
-- 書き込みも開ける（2026-09-09 の判断）。移行してきた 2498 件のうち 460 件が
-- 口座番号か名義を欠いていて、そのままでは振り込めない（うち 383 件は名義だけ）。
-- V1 の元データがその形なので、直す先が要る。V1 側で直して移し直す道は、
-- V1 を止める前提と噛み合わない。
--
-- 漏れたときの被害が他の項目と桁違いなので、開ける範囲は最小にしてある。
--   - INSERT と UPDATE だけ。DELETE は与えない（行ごと消す操作は要らない。
--     使わない口座は各欄を空にする）
--   - 触れる経路は取引先の画面1つだけ。requireRole("admin","legal") の下に置く
--   - 変更は audit_events に残す（誰がいつどの取引先の口座を直したか）
-- AUTH_MODE=disabled のあいだは入れた人が全員 admin になる。IAP へ移すまでは、
-- 「アプリに入れる人＝口座を見て直せる人」であることを承知して運用する。
-- 閉じ直すときは REVOKE INSERT, UPDATE ON v3.party_bank_accounts。
REVOKE ALL ON v3.party_bank_accounts FROM legalbridge_v3_runtime;
GRANT SELECT, INSERT, UPDATE ON v3.party_bank_accounts TO legalbridge_v3_runtime;

-- 一括作成の束。結果を書き戻すので UPDATE は要る。消さない。
REVOKE DELETE, TRUNCATE ON v3.document_batches FROM legalbridge_v3_runtime;

-- やり取りの記録は証憑。追記だけで、書き換えも削除もさせない。
REVOKE UPDATE, DELETE, TRUNCATE ON v3.matter_communications FROM legalbridge_v3_runtime;

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

-- ビューは読むだけ。派生値の置き場であって書込先ではない。
--   002_views.sql を流し直すとビューが作り直されるので、既定権限が
--   付いてしまう経路がある。ここで必ず剥がす（003 を再実行すれば直る）。
DO $revoke_views$
DECLARE r record;
BEGIN
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'v3' LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON v3.%I FROM legalbridge_v3_runtime',
      r.viewname);
  END LOOP;
END
$revoke_views$;

-- 今後 001 に表を足したときのための既定。
--   SELECT だけにする。PostgreSQL の ON TABLES はビューにも効くため、
--   書込を既定に入れると 002 を流し直したビューに書込権限が付く。
--   表を足したときは 003 を流し直すこと（明示的な操作にする）。
ALTER DEFAULT PRIVILEGES IN SCHEMA v3
  GRANT SELECT ON TABLES TO legalbridge_v3_runtime;
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
        -- 口座表は SELECT / INSERT / UPDATE が正。DELETE が付いていたら異常
        -- （行ごと消す操作は用意していない）。
        OR (table_name = 'party_bank_accounts'
            AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE'))
        OR (table_name IN ('document_templates', 'document_template_versions')
            AND privilege_type <> 'SELECT')
        OR (table_name = 'audit_events' AND privilege_type IN ('UPDATE', 'DELETE'))
        -- ビューは pg_views で厳密に判定する。以前は名前の前方一致
        -- （LIKE 'v\_%'）で見ていたが、standard_conforming_strings が
        -- 有効だとこれは「v + バックスラッシュ + 任意1文字」を意味し、
        -- どのビューにも一致せずチェックが素通りしていた。
        OR (table_name IN (SELECT viewname FROM pg_views WHERE schemaname = 'v3')
            AND privilege_type <> 'SELECT'))
 ORDER BY table_schema, table_name, privilege_type;

COMMIT;
