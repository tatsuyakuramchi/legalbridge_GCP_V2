-- =====================================================================
-- 本番 v3 の中身を Cloud SQL Studio から取り出す（読むだけ・何も書き換えない）
--
--   予備系の自動同期が使えない環境で、ローカル版に本番のデータを入れるための
--   取り出し口。Studio でこの SQL を流し、結果を CSV で落として取り込む。
--
--   使い方:
--     1. 「1.」を流してページの一覧（ページ番号・行数・バイト数）を見る。控えておく
--     2. 「2.」の  WHERE page = 0  の数字を 0, 1, 2 … と変えて流し、毎回 CSV で落とす
--        （落とすファイル名は何でもよい。順番も問わない）
--     3. 落とした CSV を infra/local/dumps/rows/ に置いて
--          docker compose run --rm ops import-rows /dumps/rows
--
--   ページは行数ではなく大きさ（バイト）で切る。Studio は 1 回の結果の大きさに
--   上限があり（超えると「レスポンスのサイズが上限を超えています。結果は切り捨て
--   られます」と出て行が欠ける）、ひな形の本文や発行時の値を持つ行は 1 行が大きい。
--   1 ページを約 2.5MB にそろえてあるので、どのページも切り捨てられない。
--
--   document_pdfs（PDF の作り置き。A-065）は取り出さない。1 行が数 MB で、
--   手元では文書を開けば作り直される。
--
--   表の一覧はこのファイルに書いていない（その場のスキーマから拾う）ので、
--   表が増えてもここを直す必要はない。
--
--   1行が1件。中身は JSON なので、NULL・日本語・配列・jsonb も崩れない。
--   ページは tbl と中身の文字列で並べて切るので、同じ中身なら何度流しても同じ
--   ページ割りになる。取り出している最中に本番が書き換わると割りが変わるので、
--   全ページを続けて落とすこと。
-- =====================================================================

-- 表の一覧を書かずに全部の表から取るために、いったん XML を経由する。
-- 取り出しは必ず xmltable を使うこと。xpath(...)::text は XML の記号を
-- 元に戻さないので、ひな形の本文（<h1> など）が &lt;h1&gt; に化ける。

-- 1. ページの一覧（ページ番号・行数・バイト数）。Studio の上限に収まる大きさで切る
WITH rows AS (
  SELECT t.tablename AS tbl, x.j AS data, octet_length(x.j) AS bytes
    FROM pg_tables t
    CROSS JOIN LATERAL xmltable('/table/row'
      PASSING query_to_xml(format('SELECT to_jsonb(r)::text AS j FROM v3.%I r', t.tablename),
                           false, false, '')
      COLUMNS j text PATH 'j') AS x
   WHERE t.schemaname = 'v3' AND t.tablename <> 'document_pdfs'
), paged AS (
  SELECT tbl, data, bytes,
         floor((sum(bytes) OVER (ORDER BY tbl, data ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - bytes) / 2500000.0)::int AS page
    FROM rows
)
SELECT page AS ページ, count(*) AS 行数, sum(bytes) AS バイト数,
       string_agg(DISTINCT tbl, ', ' ORDER BY tbl) AS 入っている表
  FROM paged
 GROUP BY page
 ORDER BY page;

-- 2. 取り出し（WHERE page = の数字を 0, 1, 2 … と「1.」のページ数のぶん変えて、毎回 CSV で落とす）
WITH rows AS (
  SELECT t.tablename AS tbl, x.j AS data, octet_length(x.j) AS bytes
    FROM pg_tables t
    CROSS JOIN LATERAL xmltable('/table/row'
      PASSING query_to_xml(format('SELECT to_jsonb(r)::text AS j FROM v3.%I r', t.tablename),
                           false, false, '')
      COLUMNS j text PATH 'j') AS x
   WHERE t.schemaname = 'v3' AND t.tablename <> 'document_pdfs'
), paged AS (
  SELECT tbl, data, bytes,
         floor((sum(bytes) OVER (ORDER BY tbl, data ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - bytes) / 2500000.0)::int AS page
    FROM rows
)
SELECT tbl, data
  FROM paged
 WHERE page = 0
 ORDER BY tbl, data;

-- 3. 表ごとの行数（取り込んだあと、手元の ops status と見比べる用）
SELECT t.tablename AS 表, x.n AS 行数
  FROM pg_tables t
  CROSS JOIN LATERAL xmltable('/table/row'
    PASSING query_to_xml(format('SELECT count(*) AS c FROM v3.%I', t.tablename), false, false, '')
    COLUMNS n bigint PATH 'c') AS x
 WHERE t.schemaname = 'v3'
 ORDER BY 1;
