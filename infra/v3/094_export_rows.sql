-- =====================================================================
-- 本番 v3 の中身を Cloud SQL Studio から取り出す（読むだけ・何も書き換えない）
--
--   予備系の自動同期が使えない環境で、ローカル版に本番のデータを入れるための
--   取り出し口。Studio でこの SQL を流し、結果を CSV で落として取り込む。
--
--   使い方:
--     1. 「1.」を流して行数とページ数を見る
--     2. 「2.」を流して結果を CSV で落とす。OFFSET の数字を
--        0 → 5000 → 10000 … と増やし、ページ数の分だけ繰り返す
--        （落とすファイル名は何でもよい。順番も問わない）
--     3. 落とした CSV を infra/local/dumps/rows/ に置いて
--          docker compose run --rm ops import-rows /dumps/rows
--
--   表の一覧はこのファイルに書いていない（その場のスキーマから拾う）ので、
--   表が増えてもここを直す必要はない。
--
--   1行が1件。中身は JSON なので、NULL・日本語・配列・jsonb も崩れない。
-- =====================================================================

-- 表の一覧を書かずに全部の表から取るために、いったん XML を経由する。
-- 取り出しは必ず xmltable を使うこと。xpath(...)::text は XML の記号を
-- 元に戻さないので、ひな形の本文（<h1> など）が &lt;h1&gt; に化ける。

-- 1. 行数とページ数（1ページ 5000 行）
SELECT sum(n) AS 行数, ceil(sum(n) / 5000.0) AS ページ数
FROM pg_tables t
CROSS JOIN LATERAL xmltable('/table/row'
  PASSING query_to_xml(format('SELECT count(*) AS c FROM v3.%I', t.tablename), false, false, '')
  COLUMNS n bigint PATH 'c') AS x
WHERE t.schemaname = 'v3';

-- 2. 取り出し（OFFSET を 0 → 5000 → 10000 … と増やして、毎回 CSV で落とす）
SELECT tbl, data
FROM (
  SELECT t.tablename AS tbl, x.j AS data
    FROM pg_tables t
    CROSS JOIN LATERAL xmltable('/table/row'
      PASSING query_to_xml(format('SELECT to_jsonb(r)::text AS j FROM v3.%I r', t.tablename),
                           false, false, '')
      COLUMNS j text PATH 'j') AS x
   WHERE t.schemaname = 'v3'
) s
ORDER BY tbl, data
OFFSET 0 LIMIT 5000;
