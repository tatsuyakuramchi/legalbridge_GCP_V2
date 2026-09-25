-- ローカル（予備系）で入れた変更を数える。読むだけ。何も書き換えない。
--
-- 本番が止まっている間にローカルで作業した分を、本番へ持ち帰る前に
-- 「何を・何件・いつ」入れたかを掴むための照会。同じファイルを本番にも流すと、
-- 同じ期間に本番側でも何か入ったか（写しを取ったあとの変更）が分かる。
--
-- 使い方（infra/local で）:
--   docker compose run --rm ops status            … 「いま入っているデータの時点」を控える
--   docker compose run --rm ops sql /v3/diag/local-changes.sql
--   docker compose run --rm ops sql-prod /v3/diag/local-changes.sql "since=2026-09-20 02:00"
--
-- since は写しを取った時点（日本時間）。
-- 省略すると、取り込み（ops import-rows）で入った操作記録の最後の時刻を起点にする
-- （取り込んだ行はみな同じ xmin を持つ）。ops status が「不明」でも写しの時点が分かる。
-- 本番へ流すときは since を必ず指定する（ローカルで出た起点をそのまま使う）。
-- 名前・住所・口座・メールは出さない。出すのは件数と番号だけ。

\if :{?since}
\else
  \set since ''
\endif

-- 取り込み（ops import-rows）は 1 つのトランザクションで全部の表の全部の行を入れる。
-- その行はみな同じ xmin を持つ。全部の表を通していちばん多くの行が持つ xmin を
-- 「取り込み」とみなす（ローカルの一括登録は数表・数百行なので、これを超えない）。
-- 取り込んだ操作記録の最後の時刻が写しの時点。
SELECT x.xid AS import_xid, sum(x.n) AS import_rows, count(*) AS import_tables
  FROM pg_tables t
  CROSS JOIN LATERAL xmltable('/table/row'
    PASSING query_to_xml(format('SELECT xmin::text AS xid, count(*) AS n FROM v3.%I GROUP BY 1', t.tablename),
                         false, false, '')
    COLUMNS xid text PATH 'xid', n bigint PATH 'n') AS x
 WHERE t.schemaname = 'v3'
 GROUP BY x.xid ORDER BY sum(x.n) DESC LIMIT 1 \gset

\echo ''
\echo '=== 取り込みとみなしたトランザクション（表の数が 30 前後なら import-rows の取り込み。数表しかなければ取り込みは見つかっていない） ==='
SELECT :'import_xid' AS xmin, :'import_rows' AS 行数, :'import_tables' AS 表の数;

SELECT COALESCE(
         NULLIF(:'since', '')::timestamp AT TIME ZONE 'Asia/Tokyo',
         (SELECT max(occurred_at) FROM v3.audit_events WHERE xmin::text = :'import_xid'),
         now() - interval '14 days') AS since \gset

\echo ''
\echo '=== 0. 取り込んだ記録と、取り込み後の記録（ローカルでは取り込み後＝ローカルの操作） ==='
SELECT CASE WHEN xmin::text = :'import_xid' THEN '取り込んだ（本番の写し）' ELSE '取り込み後' END AS 区分,
       CASE WHEN actor LIKE '%@local' THEN actor ELSE '（利用者）' END AS 操作者,
       count(*) AS 件数,
       min(occurred_at) AT TIME ZONE 'Asia/Tokyo' AS 最初,
       max(occurred_at) AT TIME ZONE 'Asia/Tokyo' AS 最後
  FROM v3.audit_events
 WHERE action NOT IN ('job.daily')
 GROUP BY 1, 2 ORDER BY 1, 最後;

\echo ''
\echo '=== 対象の期間 ==='
SELECT :'since'::timestamptz AT TIME ZONE 'Asia/Tokyo' AS 起点_日本時間,
       now() AT TIME ZONE 'Asia/Tokyo' AS 現在_日本時間;

\echo ''
\echo '=== 1. 操作の記録（audit_events）: 種類ごとの件数 ==='
SELECT action AS 操作, count(*) AS 件数,
       min(occurred_at) AT TIME ZONE 'Asia/Tokyo' AS 最初,
       max(occurred_at) AT TIME ZONE 'Asia/Tokyo' AS 最後
  FROM v3.audit_events
 WHERE occurred_at > :'since'::timestamptz
   AND action NOT IN ('job.daily')
 GROUP BY action ORDER BY count(*) DESC, action;

\echo ''
\echo '=== 2. 誰が操作したか ==='
SELECT CASE WHEN actor LIKE '%@local' THEN actor ELSE '（利用者）' END AS 操作者, count(*) AS 件数
  FROM v3.audit_events
 WHERE occurred_at > :'since'::timestamptz AND action NOT IN ('job.daily')
 GROUP BY 1 ORDER BY count(*) DESC;

\echo ''
\echo '=== 3. 新しくできた行（created_at が起点より後）: 表ごとの件数 ==='
SELECT '作品 works' AS 表, count(*) AS 件数 FROM v3.works WHERE created_at > :'since'::timestamptz
UNION ALL SELECT 'クレジット work_credits', count(*) FROM v3.work_credits WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '取引先 parties', count(*) FROM v3.parties WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '案件 matters', count(*) FROM v3.matters WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '案件の繋がり matter_links', count(*) FROM v3.matter_links WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '案件の関係 matter_relations', count(*) FROM v3.matter_relations WHERE created_at > :'since'::timestamptz
UNION ALL SELECT 'やり取り matter_communications', count(*) FROM v3.matter_communications WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '契約 agreements', count(*) FROM v3.agreements WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '条件 conditions', count(*) FROM v3.conditions WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '実績 condition_events', count(*) FROM v3.condition_events WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '期間の出来事 term_events', count(*) FROM v3.term_events WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '文書 documents', count(*) FROM v3.documents WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '一括作成 document_batches', count(*) FROM v3.document_batches WHERE created_at > :'since'::timestamptz
UNION ALL SELECT 'ひな形の版 document_template_versions', count(*) FROM v3.document_template_versions WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '支払 payments', count(*) FROM v3.payments WHERE created_at > :'since'::timestamptz
UNION ALL SELECT '定型文 text_snippets', count(*) FROM v3.text_snippets WHERE created_at > :'since'::timestamptz;

\echo ''
\echo '=== 4. 書き換えただけの行（新規ではなく、既存の行への操作）: 対象の種類ごと ==='
SELECT a.target_type AS 対象, count(DISTINCT a.target_id) AS 対象の数, count(*) AS 操作の数
  FROM v3.audit_events a
 WHERE a.occurred_at > :'since'::timestamptz
   AND a.action NOT IN ('job.daily')
   AND a.action NOT LIKE '%.create' AND a.action NOT IN ('document.draft', 'document.batch')
 GROUP BY a.target_type ORDER BY count(*) DESC;

\echo ''
\echo '=== 5. ローカルで作った・決定した文書（番号と状態だけ） ==='
SELECT d.id, d.document_no AS 文書番号, d.status AS 状態, t.template_key AS ひな形,
       d.created_at AT TIME ZONE 'Asia/Tokyo' AS 作成,
       d.issued_at AT TIME ZONE 'Asia/Tokyo' AS 決定,
       CASE WHEN d.storage_url IS NULL THEN '（未保存）'
            WHEN d.storage_url LIKE '%local-files%' OR d.storage_url NOT LIKE 'http%' THEN 'ローカルの保存先'
            ELSE 'Drive' END AS PDF保存先
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions v ON v.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = v.template_id
 WHERE d.created_at > :'since'::timestamptz
    OR d.issued_at > :'since'::timestamptz
 ORDER BY d.id;

\echo ''
\echo '=== 6. ローカルで作った作品・案件・支払（番号だけ） ==='
SELECT '作品' AS 種類, w.id, w.work_code AS 番号, w.created_at AT TIME ZONE 'Asia/Tokyo' AS 作成
  FROM v3.works w WHERE w.created_at > :'since'::timestamptz
UNION ALL
SELECT '案件', m.id, m.matter_no, m.created_at AT TIME ZONE 'Asia/Tokyo'
  FROM v3.matters m WHERE m.created_at > :'since'::timestamptz
UNION ALL
SELECT '支払', p.id, p.payment_no, p.created_at AT TIME ZONE 'Asia/Tokyo'
  FROM v3.payments p WHERE p.created_at > :'since'::timestamptz
UNION ALL
SELECT '条件', c.id, c.condition_no, c.created_at AT TIME ZONE 'Asia/Tokyo'
  FROM v3.conditions c WHERE c.created_at > :'since'::timestamptz
ORDER BY 1, 2;

\echo ''
\echo '=== 7. 番号の採番表（document_sequences）: いまの値 ==='
SELECT prefix AS 接頭辞, year AS 年, current_value AS 現在値
  FROM v3.document_sequences ORDER BY prefix, year;

\echo ''
\echo '=== 8. 表ごとの行：取り込んだまま／取り込み後に追加・変更（xmin で判定。ローカルで流す） ==='
\echo '    ※ ops upgrade（004_amend）で直した行も「取り込み後」に数える。消した行はここには出ない'
SELECT t.tablename AS 表, x.total AS 全部, x.kept AS 取り込んだまま, x.total - x.kept AS 取り込み後に追加・変更
  FROM pg_tables t
  CROSS JOIN LATERAL xmltable('/table/row'
    PASSING query_to_xml(format(
      'SELECT count(*) AS total, count(*) FILTER (WHERE xmin::text = %L) AS kept FROM v3.%I',
      :'import_xid', t.tablename), false, false, '')
    COLUMNS total bigint PATH 'total', kept bigint PATH 'kept') AS x
 WHERE t.schemaname = 'v3'
 ORDER BY (x.total - x.kept) DESC, t.tablename;
