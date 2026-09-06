-- 077_delivery_registration_preflight.sql
-- 案件画面からの「納品実績（delivery_events）・支払（payments）の登録」の事前確認。READ ONLY。
-- Cloud SQL Studio（postgres・DB legalbridge）で実行。
--
-- 1) 列一覧：アプリは information_schema で実列を見て「ある列だけ」に書く。
--    NOT NULL かつ既定値なしの列が backlog_issue_key / status / delivered_amount / inspection_deadline /
--    納品日（delivered_on|delivered_at|delivery_date）/ 文書番号 / 備考 / created_by 以外にあると、
--    登録時に 422（DELIVERY_SCHEMA_UNSUPPORTED）で列名が返る。その列名をこの結果で確認する。
SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('delivery_events', 'payments')
 ORDER BY table_name, ordinal_position;

-- 2) 現在の権限（078 適用前は delivery_events の INSERT/UPDATE が false のはず。payments は grant 016）。
SELECT
  has_table_privilege('legalbridge_v2_runtime', 'public.delivery_events', 'SELECT') AS delivery_select,
  has_table_privilege('legalbridge_v2_runtime', 'public.delivery_events', 'INSERT') AS delivery_insert,
  has_table_privilege('legalbridge_v2_runtime', 'public.delivery_events', 'UPDATE') AS delivery_update,
  has_table_privilege('legalbridge_v2_runtime', 'public.payments', 'INSERT') AS payments_insert,
  has_table_privilege('legalbridge_v2_runtime', 'public.payments', 'UPDATE') AS payments_update,
  has_table_privilege('legalbridge_v2_runtime', 'public.matter_issues', 'SELECT') AS matter_issues_select;

-- 3) delivery_events の id 採番シーケンス名（078 で USAGE を付ける対象）。
SELECT pg_get_serial_sequence('public.delivery_events', 'id') AS delivery_events_sequence,
       pg_get_serial_sequence('public.payments', 'id') AS payments_sequence;

-- 4) 状態値の実態（既存行の status 分布。アプリは delivered/inspected/completed/cancelled を使う）。
SELECT 'delivery_events' AS table_name, status, count(*) FROM delivery_events GROUP BY status
UNION ALL
SELECT 'payments', status, count(*) FROM payments GROUP BY status
ORDER BY 1, 3 DESC;
