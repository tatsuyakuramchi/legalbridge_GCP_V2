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
-- 省略すると、ローカルの操作者（…@local。既定は backup@local）以外の最後の操作の
-- 時刻を起点にする。CSV で取り込んだとき（ops status が「不明」）は、これが写しの時点。
-- 本番へ流すときは since を必ず指定する（ローカルで出た起点をそのまま使う）。
-- 名前・住所・口座・メールは出さない。出すのは件数と番号だけ。

\if :{?since}
\else
  \set since ''
\endif

SELECT COALESCE(
         NULLIF(:'since', '')::timestamp AT TIME ZONE 'Asia/Tokyo',
         (SELECT max(occurred_at) FROM v3.audit_events WHERE actor NOT LIKE '%@local'),
         now() - interval '14 days') AS since \gset

\echo ''
\echo '=== 0. 操作者ごとの期間（…@local がローカルでの操作） ==='
SELECT CASE WHEN actor LIKE '%@local' THEN actor ELSE '（本番の利用者）' END AS 操作者,
       count(*) AS 件数,
       min(occurred_at) AT TIME ZONE 'Asia/Tokyo' AS 最初,
       max(occurred_at) AT TIME ZONE 'Asia/Tokyo' AS 最後
  FROM v3.audit_events
 WHERE action NOT IN ('job.daily')
 GROUP BY 1 ORDER BY 最後;

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
SELECT CASE WHEN actor LIKE '%@local' THEN actor ELSE '（本番の利用者）' END AS 操作者, count(*) AS 件数
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
