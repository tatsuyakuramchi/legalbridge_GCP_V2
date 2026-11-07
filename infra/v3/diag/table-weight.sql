-- =====================================================================
-- 軽量化の下調べ：表の重さと使われ方（Cloud SQL Studio 用。読むだけ。書き込みは 1 つも無い）。
--
--   ★ 使い方：1〜7 を 1 つずつ流して、結果を貼ってください。
--     数字は pg_stat（最後に統計を消してからの累計）と見積りの行数。正確な件数は 6 で数える。
-- =====================================================================

-- 1. スキーマごとの大きさ（v3 以外に旧アプリの表が残っていないか） ----------------------------
SELECT n.nspname AS スキーマ, count(*) AS 表の数,
       pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS 大きさ, sum(pg_total_relation_size(c.oid)) AS バイト
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
 GROUP BY n.nspname ORDER BY バイト DESC;

-- 2. 表ごとの大きさ・行数・読み書きの回数（大きい順） --------------------------------------------
SELECT s.schemaname AS スキーマ, s.relname AS 表, s.n_live_tup AS 行数の見積り,
       pg_size_pretty(pg_total_relation_size(s.relid)) AS 全体, pg_size_pretty(pg_relation_size(s.relid)) AS 本体,
       pg_size_pretty(pg_indexes_size(s.relid)) AS 索引,
       pg_size_pretty(pg_total_relation_size(s.relid) - pg_relation_size(s.relid) - pg_indexes_size(s.relid)) AS 長い値_toast,
       s.seq_scan AS 全件読み, s.idx_scan AS 索引読み, s.n_tup_ins AS 追加, s.n_tup_upd AS 更新, s.n_tup_del AS 削除,
       s.n_dead_tup AS 死んだ行, greatest(s.last_autovacuum, s.last_vacuum)::date AS 最後の掃除
  FROM pg_stat_user_tables s
 ORDER BY pg_total_relation_size(s.relid) DESC
 LIMIT 80;

-- 3. 一度も使われていない索引（主キー・一意は除く。大きい順） ------------------------------------
SELECT s.schemaname AS スキーマ, s.relname AS 表, s.indexrelname AS 索引, pg_size_pretty(pg_relation_size(s.indexrelid)) AS 大きさ,
       s.idx_scan AS 使われた回数
  FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
 WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
 ORDER BY pg_relation_size(s.indexrelid) DESC
 LIMIT 50;

-- 4. 長い値の中身：どの列が重いか（PDF・本文・JSON） ---------------------------------------------
SELECT 'document_pdfs.data（決定済み文書の PDF の作り置き）' AS 列, count(*) AS 件数,
       pg_size_pretty(COALESCE(sum(octet_length(data)), 0)) AS 合計, pg_size_pretty(COALESCE(avg(octet_length(data)), 0)::bigint) AS 平均
  FROM v3.document_pdfs
UNION ALL
SELECT 'documents.rendered_values', count(*), pg_size_pretty(COALESCE(sum(pg_column_size(rendered_values)), 0)),
       pg_size_pretty(COALESCE(avg(pg_column_size(rendered_values)), 0)::bigint) FROM v3.documents
UNION ALL
SELECT 'documents.manual_inputs', count(*), pg_size_pretty(COALESCE(sum(pg_column_size(manual_inputs)), 0)),
       pg_size_pretty(COALESCE(avg(pg_column_size(manual_inputs)), 0)::bigint) FROM v3.documents
UNION ALL
SELECT 'document_template_versions.html_source', count(*), pg_size_pretty(COALESCE(sum(pg_column_size(html_source)), 0)),
       pg_size_pretty(COALESCE(avg(pg_column_size(html_source)), 0)::bigint) FROM v3.document_template_versions
UNION ALL
SELECT 'audit_events.detail', count(*), pg_size_pretty(COALESCE(sum(pg_column_size(detail)), 0)),
       pg_size_pretty(COALESCE(avg(pg_column_size(detail)), 0)::bigint) FROM v3.audit_events
UNION ALL
SELECT 'intake_requests.source_payload・backlog_snapshot', count(*),
       pg_size_pretty(COALESCE(sum(pg_column_size(source_payload)) + sum(pg_column_size(backlog_snapshot)), 0)),
       pg_size_pretty(COALESCE(avg(COALESCE(pg_column_size(source_payload), 0) + COALESCE(pg_column_size(backlog_snapshot), 0)), 0)::bigint)
  FROM v3.intake_requests;

-- 5. 監査ログの増え方（月ごと・多い操作） -----------------------------------------------------------
SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS 月, count(*) AS 件数,
       pg_size_pretty(sum(pg_column_size(detail))) AS detail_の大きさ
  FROM v3.audit_events GROUP BY 1 ORDER BY 1;
SELECT action AS 操作, count(*) AS 件数, pg_size_pretty(sum(pg_column_size(detail))) AS detail_の大きさ,
       max(occurred_at)::date AS 最後
  FROM v3.audit_events GROUP BY action ORDER BY sum(pg_column_size(detail)) DESC LIMIT 30;

-- 6. 消す候補の表：正確な件数と最後に書いた日 ------------------------------------------------------
SELECT 'condition_holder_190_backup（190 の退避）' AS 表, (SELECT count(*) FROM v3.condition_holder_190_backup) AS 件数,
       (SELECT max(saved_at)::date FROM v3.condition_holder_190_backup)::text AS 最後
UNION ALL SELECT 'condition_holder_190_created（190 で立てた器の記録）', (SELECT count(*) FROM v3.condition_holder_190_created), NULL
UNION ALL SELECT 'condition_holder_190_review（190 の要確認）', (SELECT count(*) FROM v3.condition_holder_190_review),
       (SELECT max(seen_at)::date FROM v3.condition_holder_190_review)::text
UNION ALL SELECT 'snippets（旧・文例。今は text_snippets）', (SELECT count(*) FROM v3.snippets), (SELECT max(updated_at)::date FROM v3.snippets)::text
UNION ALL SELECT 'text_snippets（今の文例）', (SELECT count(*) FROM v3.text_snippets), NULL
UNION ALL SELECT 'document_pdfs（取り消し・差し替え済み文書の PDF）',
       (SELECT count(*) FROM v3.document_pdfs p JOIN v3.documents d ON d.id = p.document_id WHERE d.status IN ('void', 'superseded')), NULL
UNION ALL SELECT 'data_quality_issues（解決済み）',
       (SELECT count(*) FROM v3.data_quality_issues WHERE status <> 'open'), NULL;

-- 7. v3 以外のスキーマの表（旧アプリ V1・V2 の表が残っているか。最後に書いたのはいつか） ----------
SELECT s.schemaname AS スキーマ, s.relname AS 表, s.n_live_tup AS 行数の見積り,
       pg_size_pretty(pg_total_relation_size(s.relid)) AS 全体,
       s.seq_scan + COALESCE(s.idx_scan, 0) AS 読まれた回数, s.n_tup_ins + s.n_tup_upd + s.n_tup_del AS 書かれた回数,
       greatest(s.last_autoanalyze, s.last_analyze)::date AS 最後の統計
  FROM pg_stat_user_tables s
 WHERE s.schemaname <> 'v3'
 ORDER BY pg_total_relation_size(s.relid) DESC;
