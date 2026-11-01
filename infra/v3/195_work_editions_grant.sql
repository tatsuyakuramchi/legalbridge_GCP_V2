-- =====================================================================
-- 195_work_editions_grant.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   193 で作った刊行物・製品の台帳（v3.work_editions）に、アプリの実行ロール
--   legalbridge_v3_runtime の権限を付け忘れていた。権限が無いと、刊行物を読む画面・API が
--   「権限が付与されていません」（サーバーエラー）で止まる：
--     作品台帳（一覧・検索・作品を選ぶ欄）、作品の刊行物の欄、入金と作者への支払、
--     権利とお金の流れ、条件の点検、出版作品・ゲーム作品の一括登録。
--   ほかの台帳（160 condition_shares・161 ebook_work_codes など）と同じ権限を付ける。
--
--   何度流しても同じ結果。戻す必要はない（戻すと上の画面がまた止まる）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

GRANT SELECT, INSERT, UPDATE, DELETE ON v3.work_editions TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.work_editions_id_seq TO legalbridge_v3_runtime;

COMMIT;

-- 確かめ：3 つとも true
SELECT has_table_privilege('legalbridge_v3_runtime', 'v3.work_editions', 'SELECT') AS can_select,
       has_table_privilege('legalbridge_v3_runtime', 'v3.work_editions', 'INSERT') AS can_insert,
       has_sequence_privilege('legalbridge_v3_runtime', 'v3.work_editions_id_seq', 'USAGE') AS can_use_seq;
