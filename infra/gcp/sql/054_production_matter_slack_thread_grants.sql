\set ON_ERROR_STOP on
\pset pager off

-- 054_production_matter_slack_thread_grants.sql
-- V1 の案件 Slack スレッドを V2 から読めるようにする（v1-reference 計画 Slice 3）。
--
-- 背景: 案件スレッド機能そのものは V2 に実装済み（Phase 7・matter-slack-routes.ts）だが、
--   保存先が隔離テーブル lb_v2_matter_slack_threads（grant 024）で、V1 の
--   matter_slack_threads（本番に実データあり）とは別物になっている。そのため V1 で
--   スレッドを立てた案件を V2 で開くと「未作成」と見え、作成すると同じ案件に
--   2本目の root が立つ。1案件=1スレッドを跨いで保つには V1 側を読む必要がある。
--
-- 方針:
--   - V1 テーブルへは **SELECT のみ**。INSERT/UPDATE/DELETE は与えない
--     （V1 運用中のデータを V2 から書き換えない・計画 §6.1「破壊的変更を行わない」）。
--   - 新規スレッドは従来どおり lb_v2_matter_slack_threads へ保存する。
--   - 新規 migration は作らない（既存テーブルをそのまま使う）。
--
-- 適用前に存在確認すること（計画 §6.1）:
--   SELECT to_regclass('public.matter_slack_threads');

\if :{?confirm_matter_slack_thread}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_slack_thread=GRANT_PRODUCTION_MATTER_SLACK_THREAD_READ'
  \quit 2
\endif

SELECT :'confirm_matter_slack_thread' = 'GRANT_PRODUCTION_MATTER_SLACK_THREAD_READ' AS confirmed
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
  -- 存在しない環境（V1 を持たない DB）では何もしない方が安全なので明示的に止める。
  IF to_regclass('public.matter_slack_threads') IS NULL THEN
    RAISE EXCEPTION 'public.matter_slack_threads is missing; nothing to read (V1 table not present)';
  END IF;
  -- V2 側の保存先は grant 024 が前提（未適用ならスレッド作成ができない）。
  IF to_regclass('public.lb_v2_matter_slack_threads') IS NULL THEN
    RAISE EXCEPTION 'public.lb_v2_matter_slack_threads is missing; apply the V2 matter slack thread migration first';
  END IF;
END
$guard$;

GRANT SELECT ON public.matter_slack_threads TO legalbridge_v2_runtime;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_name = 'matter_slack_threads'
       AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'matter_slack_threads SELECT grant was not applied';
  END IF;
  -- 書込権限が混ざっていないこと（V1 データを V2 から変更させない）。
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_name = 'matter_slack_threads'
       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'matter_slack_threads must be read-only for legalbridge_v2_runtime';
  END IF;
END
$verify$;

-- 適用結果と、V1／V2 それぞれの行数・重複案件数（実装方針の判断材料）。
SELECT (SELECT count(*) FROM public.matter_slack_threads) AS v1_threads,
       (SELECT count(*) FROM public.lb_v2_matter_slack_threads) AS v2_threads,
       (SELECT count(*) FROM public.matter_slack_threads v1
          JOIN public.lb_v2_matter_slack_threads v2 ON v2.matter_id = v1.matter_id) AS both;

COMMIT;
